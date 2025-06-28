// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, log, RequestQueue, SessionPool } from 'crawlee';
import { Input, ScrapeMetadata, AdDetail } from './types.js';
import { randomDelay } from './utils.js';
import { scrapeAdDetail } from './ad-detail-scraper.js';
// this is ESM project, and as such, it requires you to specify extensions in your relative imports
// read more about this here: https://nodejs.org/docs/latest-v18.x/api/esm.html#mandatory-file-extensions
// note that we need to use `.js` even when inside TS files
// import { router } from './routes.js';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init();

// Record start time right after init
const startTime = Date.now();

// Get the input
const input = await Actor.getInput<Input>();
if (!input) {
    throw new Error('Input is missing. Please provide input.');
}

// Validate that either accountOwner or keyword is provided
if (!input.accountOwner && !input.keyword) {
    throw new Error('You must provide either accountOwner (company name) or keyword to search for ads.');
}

const {
    accountOwner,
    keyword = '',
    maxUrlsCount = 500,
    debugMode = true,
    unlimitedMode = true,
    scrapeAdDetails = true,
    maxCrawlerConcurrency = 10,
} = input;

// Set log level based on debugMode
if (debugMode) {
    log.setLevel(log.LEVELS.DEBUG);
} else {
    log.setLevel(log.LEVELS.INFO);
}

const MIN_BACKOFF_TIME = 10000; // 10 seconds
const MAX_BACKOFF_TIME = 60000; // 60 seconds
const BACKOFF_FACTOR = 1.5; // Exponential backoff multiplier

// Request queue priorities
const PRIORITY = {
    LISTING: 10, // Higher priority (processed first)
    DETAIL: 0,   // Lower priority
};

// Track 429 errors for exponential backoff
let consecutiveRateLimitErrors = 0;
let lastBackoffTime = MIN_BACKOFF_TIME;

log.info('Starting LinkedIn Ads Library scraper', {
    accountOwner,
    keyword,
    maxUrlsCount,
    unlimitedMode,
    scrapeAdDetails,
    maxCrawlerConcurrency
});

// Create a single request queue
log.info('Creating fresh request queue');
const queueTimestamp = Date.now();
const requestQueue = await Actor.openRequestQueue(`request-queue-${queueTimestamp}`);

const proxyConfiguration = await Actor.createProxyConfiguration();

// Initialize counters
let urlsFound = 0;
let pagesProcessed = 0;
let totalAdsAvailable = 0;
let isFirstPage = true;
let detailsCollected = 0;

// Function to save progress (metadata only)
const saveProgress = async () => {
    log.info(`Saving intermediate progress: ${urlsFound} ad URLs found, ${detailsCollected} details scraped`, {
        totalAdsAvailable: totalAdsAvailable || 'unknown'
    });

    // Save metadata about the scrape
    const metadata: ScrapeMetadata = {
        totalAdsAvailable,
        adsCollected: urlsFound,
        detailsCollected,
        accountOwner: accountOwner || '',
        keyword,
        timestamp: new Date().toISOString()
    };
    await Actor.setValue('scrape_metadata', metadata);
};

// Define how often to save progress (metadata)
const SAVE_METADATA_EVERY_N_PAGES = 20;

// Create a session pool for managing sessions
const sessionPool = await SessionPool.open({
    maxPoolSize: maxCrawlerConcurrency * 20,
    sessionOptions: {
        maxUsageCount: 100,
    },
});

/**
 * Handle rate limit errors with exponential backoff
 */
const handleRateLimit = async (): Promise<void> => {
    consecutiveRateLimitErrors++;
    const backoffTime = Math.min(lastBackoffTime * BACKOFF_FACTOR, MAX_BACKOFF_TIME);
    lastBackoffTime = backoffTime;
    
    log.warning(`Rate limit backoff: Waiting ${backoffTime/1000}s (Consecutive errors: ${consecutiveRateLimitErrors})`);
    await new Promise(resolve => setTimeout(resolve, backoffTime));
    log.info(`Rate limit backoff: Finished waiting ${backoffTime/1000}s. Resuming...`);
};

/**
 * Reset rate limit counters after successful request
 */
const resetRateLimitCounters = (): void => {
    if (consecutiveRateLimitErrors > 0) {
        // Make recovery message clearer
        log.info(`Rate limit recovery: Processed request after ${consecutiveRateLimitErrors} error(s). Resetting backoff.`);
        consecutiveRateLimitErrors = 0;
        lastBackoffTime = MIN_BACKOFF_TIME;
    }
};

// Create the unified crawler
const crawler = new CheerioCrawler({
    requestQueue,
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    minConcurrency: 2,
    maxRequestRetries: 5,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,

    // Using fixed concurrency for debugging stall issue
    maxConcurrency: maxCrawlerConcurrency, // Use input value

    requestHandler: async ({ request, $, log, crawler: crawlerInstance }) => {
        const { label = 'UNKNOWN', adId = 'N/A' } = request.userData;

        log.info(`RequestHandler START: Processing ${label} page (Ad ID: ${adId}). URL: ${request.url}`);

        // Check if we received actual content
        const htmlContent = $.html();
        const contentLength = htmlContent.length;
        log.debug(`Page content length: ${contentLength} bytes (Label: ${label})`);

        if (contentLength < 100 && label === 'LIST') {
            log.error('Received empty or very small HTML content for LIST page!');
            throw new Error('Empty LIST page content');
        } else if (contentLength < 1000 && label === 'AD') {
             log.error(`Suspiciously small HTML content for Ad ID ${request.userData.adId}! Length: ${contentLength}`);
             throw new Error(`Suspiciously small AD page content for Ad ID ${request.userData.adId}`);
        }

        try {
            if (label === 'LIST') {
                pagesProcessed++;

                // Extract the total count only on the first page
                if (isFirstPage && !request.url.includes('searchPaginationFragment')) {
                    isFirstPage = false;

                    // Get the total count using the specific selector provided by the user
                    const countElement = $('h1.font-normal.text-sm.text-color-text.py-3');
                    if (countElement.length > 0) {
                        const totalCountText = countElement.text().trim();
                        log.debug(`Found count element: "${totalCountText}"`);

                        // Extract the number from text like "480 ads match your search criteria"
                        const countMatch = totalCountText.match(/(\d+,?\d*)\s+ads/i);

                        if (countMatch && countMatch[1]) {
                            // Remove commas from numbers like "1,234"
                            totalAdsAvailable = parseInt(countMatch[1].replace(/,/g, ''), 10);
                            log.info(`Found ${totalAdsAvailable} total ads for '${accountOwner || keyword}'`);

                            // Update metadata right away
                            await saveProgress();
                        } else {
                            log.warning(`Count element found but couldn't extract number: "${totalCountText}"`);
                        }
                    } else {
                        log.warning('Could not find total ads count element');

                        // Fallback: try other common heading elements
                        const headings = $('h1');
                        if (headings.length > 0) {
                            log.debug(`Found ${headings.length} h1 elements, checking them:`);
                            headings.each((i, el) => {
                                const text = $(el).text().trim();
                                log.debug(`Heading ${i}: "${text}"`);

                                const countMatch = text.match(/(\d+,?\d*)\s+(?:ads|results)/i);
                                if (countMatch && countMatch[1]) {
                                    totalAdsAvailable = parseInt(countMatch[1].replace(/,/g, ''), 10);
                                    log.info(`Found ${totalAdsAvailable} total ads from heading`);
                                    return false;
                                }
                                return true;
                            });
                        }
                    }

                    // Count the ads on the first page as a fallback indicator
                    const adsCount = $('.search-result-item').length;
                    log.info(`Found ${adsCount} ads on first page`);
                }

                // Check if we've reached the limit (only if not in unlimited mode)
                if (!unlimitedMode && urlsFound >= maxUrlsCount) {
                    log.info(`Reached URL limit (${maxUrlsCount}), stopping LIST page processing.`);
                    return;
                }

                // Process the ads on the page
                const ads = $('.search-result-item');
                log.info(`Found ${ads.length} ads on current page`);

                const adDetailRequests = [];

                // Extract ad URLs and enqueue detail requests
                for (let i = 0; i < ads.length; i++) {
                    // If not in unlimited mode, check if we've reached the limit
                    if (!unlimitedMode && urlsFound >= maxUrlsCount) {
                        break;
                    }

                    const ad = ads.eq(i);

                    try {
                        // Extract ad URL and ID
                        const adDetailUrl = ad.find('a[data-tracking-control-name="ad_library_view_ad_detail"]').attr('href');
                        if (!adDetailUrl) {
                            log.warning('Could not extract ad detail URL, skipping ad.');
                            continue;
                        }

                        const adId = adDetailUrl.split('/').pop()?.split('?')[0];
                        if (!adId) {
                            log.warning('Could not extract ad ID, skipping ad.');
                            continue;
                        }

                        const fullAdUrl = `https://www.linkedin.com${adDetailUrl}`;

                        // Increment found count (even if not scraping details)
                        urlsFound++;

                        // If we are scraping detail pages, create request for detail queue
                        if (scrapeAdDetails) {
                            adDetailRequests.push({
                                url: fullAdUrl,
                                userData: {
                                    label: 'AD',
                                    adId,
                                    // priority: PRIORITY.DETAIL // Temporarily removed for debugging
                                },
                                uniqueKey: `ad_${adId}` // Use simpler unique key if timestamp isn't strictly needed
                            });
                        }

                        const progressInfo = totalAdsAvailable
                            ? `${urlsFound}/${totalAdsAvailable} (${(urlsFound/totalAdsAvailable*100).toFixed(1)}%)`
                            : urlsFound;

                        log.debug(`Extracted ad URL: ${fullAdUrl}, progress: ${progressInfo}`);
                    } catch (error) {
                        log.error('Error extracting ad URL', { error: (error as Error).message });
                    }
                }

                // Enqueue all found ad detail requests
                if (adDetailRequests.length > 0) {
                    log.debug(`RequestHandler (LIST): Calling crawlerInstance.addRequests for ${adDetailRequests.length} ADs...`);
                    await crawlerInstance.addRequests(adDetailRequests);
                    log.debug(`RequestHandler (LIST): crawlerInstance.addRequests finished for ADs.`);
                    log.info(`Enqueued ${adDetailRequests.length} ad detail requests.`);
                }

                // Save metadata periodically
                if (pagesProcessed % SAVE_METADATA_EVERY_N_PAGES === 0) {
                    await saveProgress();
                }

                // Handle pagination - extract the pagination token from the HTML comment
                const paginationMetadataEl = $('#paginationMetadata');
                if (paginationMetadataEl.length) {
                    const paginationHtml = $.html(paginationMetadataEl);
                    const commentRegex = /<!--(.*)-->/s;
                    const match = paginationHtml.match(commentRegex);

                    if (match && match[1]) {
                        try {
                            const paginationData = JSON.parse(match[1]);

                            if (!paginationData.isLastPage && paginationData.paginationToken) {
                                // LinkedIn suggests there might be more pages and provides a token.
                                // Let's inspect and clean this token.
                                let rawToken = paginationData.paginationToken;
                                log.debug(`Original pagination token from LinkedIn: "${rawToken}"`);
                                let cleanedToken = rawToken; // Initialize with original in case it's not a string or doesn't have #

                                if (typeof rawToken === 'string' && rawToken.includes('#')) {
                                    const oldToken = rawToken;
                                    cleanedToken = rawToken.split('#')[0];
                                    log.info(`Cleaned pagination token: from "${oldToken}" to "${cleanedToken}"`);
                                }

                                // Now, check if this cleaned token is a special "end" token like "0"
                                // Also respect user-defined limits.
                                if (cleanedToken === "0") {
                                    log.info(`Pagination token (raw: "${rawToken}", cleaned: "${cleanedToken}") is "0". Treating as the end of pagination to prevent potential errors.`);
                                } else if (!unlimitedMode && urlsFound >= maxUrlsCount) {
                                    log.info(`URL limit (${maxUrlsCount}) reached, not enqueueing next LIST page (token was "${cleanedToken}").`);
                                } else {
                                    // Token is not "0" and limits not reached, proceed to enqueue.
                                    log.info(`Valid pagination token (raw: "${rawToken}", cleaned: "${cleanedToken}") found, enqueueing next LIST page.`);

                                    let nextPageUrl;
                                    if (keyword) {
                                        nextPageUrl = `https://www.linkedin.com/ad-library/searchPaginationFragment?${accountOwner ? 'accountOwner=' + encodeURIComponent(accountOwner) + '&' : ''}keyword=${encodeURIComponent(keyword)}&start=0&count=25&paginationToken=${encodeURIComponent(cleanedToken)}`;
                                    } else {
                                        nextPageUrl = `https://www.linkedin.com/ad-library/searchPaginationFragment?accountOwner=${encodeURIComponent(accountOwner || '')}&start=0&count=25&paginationToken=${encodeURIComponent(cleanedToken)}`;
                                    }

                                    await crawlerInstance.addRequests([{
                                        url: nextPageUrl,
                                        userData: {
                                            label: 'LIST',
                                            // priority: PRIORITY.LISTING // Temporarily removed for debugging
                                        },
                                        uniqueKey: `list_${cleanedToken}`, // Simpler unique key using cleaned token
                                    }]);
                                    log.debug(`RequestHandler (LIST): crawlerInstance.addRequests finished for next page.`);
                                }
                            } else {
                                // LinkedIn explicitly says isLastPage=true OR no paginationToken was provided.
                                log.info('Reached last pagination page (isLastPage=true or no token found in metadata).');
                            }
                        } catch (error) {
                            log.error('Error parsing pagination data', { error: (error as Error).message });
                        }
                    } else {
                        log.warning('No pagination data found in comment.');
                    }
                } else {
                    log.warning('No pagination metadata element found.');
                    if ($('.search-result-item').length === 0 && !isFirstPage) {
                        log.info('No ads found and no pagination, assuming end of LIST pages for this path.');
                    }
                }

                // Reset rate limit counters after successful processing
                resetRateLimitCounters();

            } else if (label === 'AD') {
                const currentAdId = request.userData.adId || request.url.split('/').pop()?.split('?')[0] || 'unknown_id';

                log.debug(`RequestHandler (AD ${currentAdId}): Calling scrapeAdDetail...`);
                const adDetail = await scrapeAdDetail(htmlContent, request.url);
                log.debug(`RequestHandler (AD ${currentAdId}): scrapeAdDetail finished.`);

                log.debug(`RequestHandler (AD ${currentAdId}): Calling Actor.pushData...`);
                await Actor.pushData(adDetail);
                log.debug(`RequestHandler (AD ${currentAdId}): Actor.pushData finished.`);
                detailsCollected++;

                log.info(`Scraped details for Ad ID ${adDetail.adId} (${detailsCollected} total)`);

                // Save metadata periodically based on details collected
                if (detailsCollected % (SAVE_METADATA_EVERY_N_PAGES * 5) === 0) {
                    await saveProgress();
                }

                resetRateLimitCounters();

            } else {
                log.warning(`Unknown request label: ${label}`, { url: request.url });
            }

            log.info(`RequestHandler END (Success): Finished processing ${label} page (Ad ID: ${adId}). URL: ${request.url}`);

        } catch (error) {
            log.error(`Unexpected error processing page (Label: ${label})`, {
                url: request.url,
                adId: request.userData.adId,
                error: (error as Error).message
            });

            if (label === 'LIST' && urlsFound === 0 && pagesProcessed <= 1 && !(error as any)?.message?.includes('429')) {
                 log.error('Failed to extract URLs from first page. LinkedIn format may have changed or page load failed.');
            }

            throw error;
        }
    },

    failedRequestHandler: async ({ request, response, error, log, session }) => {
        const { label = 'UNKNOWN', adId = 'N/A' } = request.userData;
        const statusCode = response ? response.statusCode : 'unknown';
        const errorMessage = error ? (error as Error).message : 'Unknown error';

        if (response) {
            if (response.statusCode === 429) {
                log.warning(`Rate limit detected (429) on ${label} page (Ad ID: ${adId}). URL: ${request.url}. Backing off...`);
                await handleRateLimit();
                throw error;
            } else if (response.statusCode === 403) {
                log.warning(`Access denied (403) on ${label} page (Ad ID: ${adId}). URL: ${request.url}. Retiring session.`);
                session?.retire();
            } else if (response.statusCode === 404) {
                log.warning(`${label} page not found (404) (Ad ID: ${adId}). URL: ${request.url}.`);
            } else {
                log.error(`Failed ${label} page (Ad ID: ${adId}). URL: ${request.url} (Status: ${statusCode})`, {
                    error: errorMessage,
                    retryCount: request.retryCount
                });
                throw error;
            }
        } else {
             log.error(`Failed ${label} page (Ad ID: ${adId}). URL: ${request.url} (Network/Unknown Error)`, {
                error: errorMessage,
                retryCount: request.retryCount
             });
             throw error;
        }
    },
});

// Main section where URL is constructed
const baseUrl = accountOwner 
    ? 'https://www.linkedin.com/ad-library/search?accountOwner=' + encodeURIComponent(accountOwner)
    : 'https://www.linkedin.com/ad-library/search?keyword=' + encodeURIComponent(keyword);

// Add keyword to URL if provided
const searchUrl = keyword
    ? `${baseUrl}&keyword=${encodeURIComponent(keyword)}`
    : baseUrl;

// Add the initial URL to the listing queue with high priority
await requestQueue.addRequest({
    url: searchUrl,
    userData: {
        label: 'LIST',
        // priority: PRIORITY.LISTING // Ensure initial LIST page has high priority
    },
    uniqueKey: `initial_page_${Date.now()}`,
});

log.info('Starting the crawler', { startUrl: searchUrl, maxConcurrency: maxCrawlerConcurrency });

// --- Start periodic status logging ---
const logInterval = 15000; // Log every 15 seconds
let isCrawlerRunning = true; // Assume running initially

const statusLogIntervalId = setInterval(async () => {
    if (!isCrawlerRunning) {
        clearInterval(statusLogIntervalId);
        log.info('Crawler finished or stopped, stopping status logging.');
        return;
    }
    try {
        const queueInfo = await requestQueue.getInfo();
        const poolState = sessionPool.getState();
        log.info('Periodic Status Check', {
            crawlerIsRunning: crawler.running,
            queuePendingCount: queueInfo?.pendingRequestCount,
            queueHandledCount: queueInfo?.handledRequestCount,
            sessionPoolUsableCount: poolState.usableSessionsCount,
            sessionPoolRetiredCount: poolState.retiredSessionsCount,
        });
        // Update running status based on live check
        if (!crawler.running) {
             isCrawlerRunning = false;
        }
    } catch (error) {
        log.error('Error in periodic status check', { error: (error as Error).message });
    }
}, logInterval);
// --- End periodic status logging ---

// Run the single unified crawler
await crawler.run();

// --- Cleanup status logging after crawler finishes ---
isCrawlerRunning = false; // Explicitly set to false after run completes
clearInterval(statusLogIntervalId); // Attempt to clear interval if it hasn't stopped itself
log.info('Crawler run finished. Status logging stopped.');
// --- End cleanup ---

log.info('Crawler finished processing the queue.');

// Calculate progress percentage for final logs
const progressPercentage = totalAdsAvailable
    ? ` (${(urlsFound/totalAdsAvailable*100).toFixed(1)}% of ${totalAdsAvailable} total ads)`
    : '';

log.info(`Scraping summary:`, {
    pagesProcessed,
    urlsFound: `${urlsFound}${progressPercentage}`,
    detailsCollected
});

// Final save (only metadata needed, Actor.pushData handled details)
log.info(`Final Metadata Save: Saving scrape summary.`);

// Save final metadata
const finalMetadata: ScrapeMetadata = {
    totalAdsAvailable,
    adsCollected: urlsFound,
    detailsCollected,
    accountOwner: accountOwner || '',
    keyword,
    timestamp: new Date().toISOString()
};

await Actor.setValue('scrape_metadata', finalMetadata);

// Calculate and log total duration
const endTime = Date.now();
const durationMillis = endTime - startTime;
const durationSeconds = (durationMillis / 1000).toFixed(2);
log.info(`Total scraping duration: ${durationSeconds} seconds`);

// Exit the actor
await Actor.exit();