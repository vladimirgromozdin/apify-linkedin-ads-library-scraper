/**
 * Ad detail scraper for LinkedIn Ads Library
 */
import { CheerioAPI, load, Cheerio } from 'cheerio';
import { log } from 'crawlee';
import { AdDetail, CountryImpression, CarouselItem } from './types.js';
import { extractProfileId, parseImpressionRange, parsePercentage, generateContentFingerprint, cleanLinkedInUrl } from './utils.js';

/**
 * Converts a potentially relative URL to an absolute URL
 * @param url The URL to convert
 * @param baseUrl The base URL to use if the URL is relative
 * @returns The absolute URL
 */
function ensureAbsoluteUrl(url: string, baseUrl: string): string {
    if (!url) return '';
    
    // If URL is already absolute, return it
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url;
    }
    
    // Handle different formats of relative URLs
    if (url.startsWith('//')) {
        // Protocol-relative URL
        const baseUrlProtocol = baseUrl.split('://')[0];
        return `${baseUrlProtocol}:${url}`;
    }
    
    // Extract base domain from baseUrl
    let baseDomain = '';
    try {
        const urlObj = new URL(baseUrl);
        baseDomain = `${urlObj.protocol}//${urlObj.host}`;
    } catch (e) {
        log.warning(`Could not parse base URL: ${baseUrl}`, { error: e });
        return url; // Return original URL if we can't parse the base URL
    }
    
    // Handle absolute path (starts with /)
    if (url.startsWith('/')) {
        return `${baseDomain}${url}`;
    }
    
    // Handle relative path
    // For simplicity, we'll assume it's relative to the domain
    return `${baseDomain}/${url}`;
}

/**
 * Scrapes ad details from a LinkedIn Ad Library detail page
 * @param html HTML content of the ad detail page
 * @param url URL of the ad detail page
 * @returns Extracted ad detail object
 */
export async function scrapeAdDetail(html: string, url: string): Promise<AdDetail> {
    const $ = load(html);
    const adId = extractAdId(url);
    const htmlFingerprint = generateContentFingerprint(html);
    
    log.debug(`Detail Scraper: Starting extraction for Ad ID: ${adId}`);
    
    if (log.getLevel() === log.LEVELS.DEBUG) {
        const advertiserCount = $('a[data-tracking-control-name="ad_library_ad_preview_advertiser"], a[data-tracking-control-name="ad_library_ad_preview_company"], a[data-tracking-control-name="ad_library_about_ad_advertiser"]').length;
        const contentCount = $('.ad-preview-content, .base-ad-preview-card').length;
        const imageCount = $('img').length;
        const videoCount = $('video').length;
        log.debug(`Detail Scraper: Structure check for Ad ID ${adId} - Advertiser: ${advertiserCount}, Content: ${contentCount}, Img: ${imageCount}, Vid: ${videoCount}`);
    }
    
    if ($('.ad-preview-content, .base-ad-preview-card').length === 0) {
        log.warning(`Detail Scraper: Missing main content element (.ad-preview-content or .base-ad-preview-card) for Ad ID: ${adId}`);
        log.debug(`Detail Scraper: HTML structure debug for Ad ID ${adId}:
            Title: ${$('title').length > 0 ? `\"${$('title').text()}\"` : 'Missing'}
            Body class: ${$('body').attr('class') || 'N/A'}
            Main container: ${$('.ad-library-main').length} 
            Error container: ${$('.error-container').length > 0 ? `Yes: \"${$('.error-container').text()}\"` : 'No'}
        `);
    }
    
    const adDetail: AdDetail = {
        adId,
        adDetailUrl: url,
        capturedAt: new Date().toISOString(),
        htmlVersion: htmlFingerprint,
        
        advertiserName: '',
        advertiserProfileUrl: '',
        advertiserProfileId: '',
        adType: '',
        promotionType: 'COMPANY',
    };
    
    try {
        // Try multiple selectors for the advertiser - LinkedIn's HTML structure varies
        const advertiserSelectors = [
            'a[data-tracking-control-name="ad_library_ad_preview_advertiser"]',
            'a[data-tracking-control-name="ad_library_ad_preview_company"]',
            'a[data-tracking-control-name="ad_library_about_ad_advertiser"]',
            '.ad-detail-right-rail a[target="_blank"]' // Fallback for "About the ad" section
        ];
        
        let advertiserFound = false;
        for (const selector of advertiserSelectors) {
            const advertiserLink = $(selector).first();
            if (advertiserLink.length > 0) {
                adDetail.advertiserName = advertiserLink.text().trim();
                adDetail.advertiserProfileUrl = cleanLinkedInUrl(advertiserLink.attr('href') || '');
                adDetail.advertiserProfileId = extractProfileId(adDetail.advertiserProfileUrl) || '';
                advertiserFound = true;
                // Try to get advertiser logo from the associated image link if main advertiser link is found
                const advertiserImageLink = advertiserLink.closest('.flex.items-center').find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"]');
                if (advertiserImageLink.length > 0) {
                    const logoImg = advertiserImageLink.find('img');
                    if (logoImg.length > 0) {
                        let logoSrc = logoImg.attr('src');
                        if (!logoSrc) { // Fallback if src is missing or empty
                            logoSrc = logoImg.attr('data-delayed-url') ||
                                      logoImg.attr('data-src') ||
                                      logoImg.attr('data-ghost-url');
                        }
                        if (logoSrc) { // Ensure we have a source before assigning
                            adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrc, url);
                        }
                    }
                }
                break;
            }
        }
        
        if (!advertiserFound) {
            log.warning(`Detail Scraper: Could not find advertiser info for Ad ID: ${adId}`);
            
            // Try to get it from the logo image directly if main info not found
            const advertiserLogoAnchor = $('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"]');
            if (advertiserLogoAnchor.length > 0) {
                const advertiserLogo = advertiserLogoAnchor.find('img');
                if (advertiserLogo.length > 0) {
                    let logoSrc = advertiserLogo.attr('src');
                    if (!logoSrc) { // Fallback if src is missing or empty
                        logoSrc = advertiserLogo.attr('data-delayed-url') ||
                                  advertiserLogo.attr('data-src') ||
                                  advertiserLogo.attr('data-ghost-url');
                    }
                    if (logoSrc) { // Ensure we have a source before assigning
                        adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrc, url);
                    }
                    const logoAlt = advertiserLogo.attr('alt');
                    if (logoAlt && logoAlt.includes('logo')) {
                        adDetail.advertiserName = logoAlt.replace(' logo', '').trim(); // Fallback for name
                    }
                }
                 // If we found the logo anchor, try to get URL from it if not already set
                if (!adDetail.advertiserProfileUrl) {
                    adDetail.advertiserProfileUrl = cleanLinkedInUrl(advertiserLogoAnchor.attr('href') || '');
                    adDetail.advertiserProfileId = extractProfileId(adDetail.advertiserProfileUrl) || '';
                }
            }
        }
        
        // Check for paid by info
        const paidByInfo = $('.about-ad__paying-entity').text().trim();
        if (paidByInfo && paidByInfo.includes('Paid for by')) {
            adDetail.paidBy = paidByInfo.replace('Paid for by', '').trim();
        }
        
        const promoterLink = $('a[data-tracking-control-name="ad_library_ad_preview_member"]');
        if (promoterLink.length > 0) {
            adDetail.promotionType = 'THOUGHT_LEADERSHIP';
            const promoterName = promoterLink.text().trim();
            const promoterProfileUrl = cleanLinkedInUrl(promoterLink.attr('href') || '');
            const promoterProfileId = extractProfileId(promoterProfileUrl) || '';
            
            // Updated promoter headline extraction
            let promoterHeadline = '';
            const promoterDetailsContainer = promoterLink.closest('.flex.flex-col.self-center');
            if (promoterDetailsContainer.length > 0) {
                // Find <p> elements that are children of promoterDetailsContainer,
                // have the class text-xs and text-color-text-secondary,
                // do not contain "Promoted by", and take the first one.
                const potentialHeadlines = promoterDetailsContainer.find('p.text-xs.text-color-text-secondary').filter((_, el) => !$(el).text().includes('Promoted by'));
                if (potentialHeadlines.length > 0) {
                    promoterHeadline = potentialHeadlines.first().text().trim();
                } else {
                    // Fallback if the exclusion was too strict or structure differs slightly
                    // Take the first p.text-xs.text-color-text-secondary if no non-"Promoted by" version found
                    const fallbackHeadlines = promoterDetailsContainer.find('p.text-xs.text-color-text-secondary');
                    if (fallbackHeadlines.length > 0) {
                         promoterHeadline = fallbackHeadlines.first().text().trim();
                    }
                }
            }
            
            // Updated promoter image URL extraction
            let promoterImageUrl = '';
            // Use the container of promoter's text details to find the sibling image anchor.
            // promoterDetailsContainer is promoterLink.closest('.flex.flex-col.self-center');
            if (promoterDetailsContainer.length > 0) {
                const outerSharedContainer = promoterDetailsContainer.parent(); // This parent should hold both text block and image link
                if (outerSharedContainer.length > 0) {
                    const promoterImageAnchor = outerSharedContainer.find('a[data-tracking-control-name="ad_library_ad_preview_member_image"]');
                    if (promoterImageAnchor.length > 0) {
                        const imgTag = promoterImageAnchor.find('img[alt="member logo"]'); // Ensure it's the member's logo
                        if (imgTag.length > 0) {
                            // Debug attributes of the found image tag
                            const attrs: Record<string, string> = {};
                            const el = imgTag[0];
                            if (el.attribs) { Object.keys(el.attribs).forEach(key => { attrs[key] = el.attribs[key]; }); }
                            log.debug(`Found promoter image tag for Ad ID: ${adId}`, { attributes: attrs });

                            promoterImageUrl = ensureAbsoluteUrl(
                                imgTag.attr('src') || // Prioritize src as per user's HTML example
                                imgTag.attr('data-delayed-url') ||
                                imgTag.attr('data-ghost-url') ||
                                '',
                                url // adDetail page URL, passed as 'url' to scrapeAdDetail, then to ensureAbsoluteUrl
                            );
                            log.debug(`Extracted promoter image URL: "${promoterImageUrl}" for Ad ID: ${adId}`);
                        } else {
                            log.debug(`No img[alt="member logo"] tag found within promoterImageAnchor (via outerSharedContainer) for Ad ID: ${adId}`);
                        }
                    } else {
                        log.debug(`No promoter image anchor found within outerSharedContainer for Ad ID: ${adId}`);
                    }
                } else {
                    log.debug(`Could not find outerSharedContainer for promoter image for Ad ID: ${adId}`);
                }
            } else {
                // This case implies promoterDetailsContainer (used for headline) was not found,
                // which is unlikely if promoterLink itself was found and the structure is consistent.
                log.debug(`promoterDetailsContainer (for headline) was not found. Cannot find promoter image via relative parent for Ad ID: ${adId}.`);
            }
            
            adDetail.promoterDetails = {
                promoterName,
                promoterHeadline,
                promoterProfileUrl,
                promoterProfileId,
                promoterImageUrl,
            };
        } else {
            adDetail.promotionType = 'COMPANY';
            log.debug(`Detail Scraper: No personal promoter found for Ad ID: ${adId}, assuming company promotion.`);
        }
        
        const videoElement = $('video');
        const imageElement = $('.ad-preview-image img, .ad-image__image img');
        const documentElement = $('iframe[data-id="sponsored-native-document-preview"]');
        const carouselElement = $('.ad-carousel-item, .slide-list__list > div');
        const eventElement = $('.ad-preview-event-info');
        const textOnlyElement = $('.ad-preview-text');
        
        // Check for sponsored-update-carousel class which indicates a carousel
        const carouselClass = $('.sponsored-update-carousel-preview');

        // New selectors for text ads
        const textAdCreativeType = $('[data-creative-type="TEXT_AD"]');
        const textAdClass = $('.text-ad-preview');
        const textAdContainer = $('.container-lined:contains("TAM-Rechner")'); // Additional check for specific text ad pattern
        const aboutAdTextLabel = $('p.text-sm.mb-1.text-color-text:contains("Text Ad")'); // Text Ad label in "About the ad" section

        // Message ad selectors (Sponsored InMails)
        const messageAdCreativeType = $('[data-creative-type="SPONSORED_INMAILS"]');
        const messageAdClass = $('.sponsored-message-preview');
        const messageAdContent = $('.sponsored-message__content');
        const aboutAdMessageLabel = $('p.text-sm.mb-1.text-color-text:contains("Message Ad")');

        // Single Image ad selectors
        const singleImageCreativeType = $('[data-creative-type="SPONSORED_STATUS_UPDATE"]');
        const aboutAdSingleImageLabel = $('p.text-sm.mb-1.text-color-text:contains("Single Image Ad")');
        const singleImageContent = $('.ad-preview__dynamic-dimensions-image');
        const sponsoredContentHeadline = $('.sponsored-content-headline');

        // ADDED: Selector for "Follow Company Ad" text in "About the ad" section
        const aboutAdFollowCompanyLabel = $('div.pt-3.px-3.pb-2 p.text-sm.mb-1.text-color-text:contains("Follow Company Ad")');

        // ADDED: Selector for "Spotlight Ad" text in "About the ad" section
        const aboutAdSpotlightLabel = $('div.pt-3.px-3.pb-2 p.text-sm.mb-1.text-color-text:contains("Spotlight Ad")');

        // ADDED: Selector for "Job Ad" text in "About the ad" section
        const aboutAdJobLabel = $('div.pt-3.px-3.pb-2 p.text-sm.mb-1.text-color-text:contains("Job Ad")');

        // --- Ad Type Detection based on data-creative-type ---
        const creativeType = $('.ad-preview').attr('data-creative-type');
        log.debug(`Detail Scraper: Detected data-creative-type: ${creativeType} for Ad ID: ${adId}`);

        if (creativeType === 'FOLLOW_COMPANY_V2' || aboutAdFollowCompanyLabel.length > 0) {
            adDetail.adType = 'FOLLOW_COMPANY';
        } else if (creativeType === 'SPOTLIGHT_V2' || aboutAdSpotlightLabel.length > 0) { // ADDED: Spotlight Ad detection
            adDetail.adType = 'SPOTLIGHT';
        } else if (creativeType === 'JOBS_V2' || aboutAdJobLabel.length > 0) { // ADDED: Job Ad detection
            adDetail.adType = 'JOB';
        } else if (creativeType === 'SPONSORED_VIDEO') {
            adDetail.adType = 'VIDEO';
            // Video URL will be extracted in extractAdContent
        } else if (creativeType === 'SPONSORED_INMAILS' || messageAdClass.length > 0 || messageAdContent.length > 0 || aboutAdMessageLabel.length > 0) {
            adDetail.adType = 'MESSAGE';
        } else if (creativeType === 'SPONSORED_UPDATE_CAROUSEL' || carouselElement.length > 0 || carouselClass.length > 0) {
            adDetail.adType = 'CAROUSEL';
        } else if (creativeType === 'SPONSORED_NATIVE_DOCUMENT' || creativeType === 'SPONSORED_UPDATE_NATIVE_DOCUMENT' || documentElement.length > 0) {
            adDetail.adType = 'DOCUMENT';
        } else if (creativeType === 'SPONSORED_EVENT' || creativeType === 'SPONSORED_UPDATE_EVENT') {
            adDetail.adType = 'EVENT';
        } else if (creativeType === 'SPONSORED_STATUS_UPDATE' || aboutAdSingleImageLabel.length > 0 || (singleImageContent.length > 0 && sponsoredContentHeadline.length > 0)) {
            adDetail.adType = 'SINGLE_IMAGE';
        } else if (creativeType === 'TEXT_AD' || textAdClass.length > 0 || textAdContainer.length > 0 || aboutAdTextLabel.length > 0) {
            adDetail.adType = 'TEXT';
        } 
        // --- Fallback Ad Type Detection (if data-creative-type was not specific or absent) ---
        else if (videoElement.length > 0 && adDetail.adType === 'UNKNOWN') { // Check if adType is still UNKNOWN
            adDetail.adType = 'VIDEO';
            // videoUrl is extracted in extractAdContent and might set adType too if it was UNKNOWN
        } else if ((carouselElement.length > 0 || carouselClass.length > 0) && adDetail.adType === 'UNKNOWN') {
            adDetail.adType = 'CAROUSEL';
            adDetail.imageUrls = [];
            adDetail.carouselItems = extractCarouselItems($, url);
            
            // Also collect image URLs separately for backward compatibility
            $('img.ad-preview__dynamic-dimensions-image').each((_, img) => {
                const imgUrl = $(img).attr('src');
                if (imgUrl && !imgUrl.includes('ghost-url')) {
                    adDetail.imageUrls?.push(ensureAbsoluteUrl(imgUrl, url));
                }
            });
        } else if (textOnlyElement.length > 0 && !imageElement.length && !videoElement.length && adDetail.adType === 'UNKNOWN') {
            adDetail.adType = 'TEXT';
        } else {
            // If adType is still UNKNOWN after all checks
            if (adDetail.adType === '' || adDetail.adType === 'UNKNOWN' ) { // Check if it's empty or already UNKNOWN
                 adDetail.adType = 'UNKNOWN';
                 log.warning(`Detail Scraper: Could not determine ad type for Ad ID: ${adDetail.adId} after all checks.`);
            }
        }
        
        extractAdContent($, adDetail);
        extractAvailabilityDates($, adDetail);
        extractImpressionData($, adDetail);
        extractTargetingInfo($, adDetail);
        
        log.debug(`Detail Scraper: Finished extraction for Ad ID: ${adDetail.adId}`);
        return adDetail;
    } catch (error) {
        log.error(`Detail Scraper: Unexpected error during extraction for Ad ID: ${adId}`, {
            error: (error as Error).message,
            stack: (error as Error).stack
        });
        adDetail.errorDuringScraping = (error as Error).message;
        return adDetail;
    }
}

/**
 * Extracts carousel items from the ad
 */
function extractCarouselItems($: CheerioAPI, baseUrl: string): CarouselItem[] {
    const items: CarouselItem[] = [];
    
    // Updated selector for carousel items based on the new HTML structure
    const carouselItemElements = $('.slide-list__list > div[class*="pr-1.5"]');
    
    carouselItemElements.each((index, itemEl) => {
        const item = $(itemEl);
        const carouselItem: CarouselItem = {
            position: index + 1
        };
        
        // Extract title/caption
        // The title is within an 'a' tag, then div, then span
        const titleEl = item.find('a[data-tracking-control-name="ad_library_ad_preview_carousel_item_title"] span.text-xs.font-semibold.text-color-text');
        if (titleEl.length > 0) {
            carouselItem.title = titleEl.text().trim();
        }
        
        // Extract image URL and alt text
        const imgEl = item.find('img.ad-preview__dynamic-dimensions-image');
        if (imgEl.length > 0) {
            // Prioritize src attribute
            let imageUrl = imgEl.attr('src');
            
            if (!imageUrl) { // Fallback if src is missing
                imageUrl = imgEl.attr('data-delayed-url') || 
                           imgEl.attr('data-src') ||
                           imgEl.attr('data-ghost-url');
            }
            
            carouselItem.imageUrl = ensureAbsoluteUrl(imageUrl || '', baseUrl);
            carouselItem.imageAlt = imgEl.attr('alt')?.trim() || '';
            
            if (carouselItem.imageUrl) {
                log.debug(`Extracted carousel image URL at position ${carouselItem.position}: ${carouselItem.imageUrl}`);
            }
        }
        
        // Extract link URL (usually from the image's anchor tag or a dedicated title link)
        // The image is wrapped in an 'a' tag which serves as the primary link for the card.
        const linkEl = item.find('a[data-tracking-control-name="ad_library_ad_preview_carousel_item_image"]');
        if (linkEl.length > 0) {
            carouselItem.linkUrl = ensureAbsoluteUrl(linkEl.attr('href') || '', baseUrl);
        } else {
            // Fallback to the title link if the image link isn't found
            const titleLinkEl = item.find('a[data-tracking-control-name="ad_library_ad_preview_carousel_item_title"]');
            if (titleLinkEl.length > 0) {
                carouselItem.linkUrl = ensureAbsoluteUrl(titleLinkEl.attr('href') || '', baseUrl);
            }
        }
        
        items.push(carouselItem);
    });
    
    // Log if no items were found, which might indicate a selector issue or different carousel structure
    if (items.length === 0) {
        log.debug('No carousel items found with selector .slide-list__list > div.pr-1.5. Checking older selector .ad-carousel-item.');
        // Fallback to older selector if new one yields no results
        const oldCarouselItems = $('.ad-carousel-item');
        oldCarouselItems.each((index, itemEl) => {
            const item = $(itemEl);
            const carouselItem: CarouselItem = {
                position: index + 1
            };

            const titleElOld = item.find('.carousel-card-title, h3');
            if (titleElOld.length > 0) {
                carouselItem.title = titleElOld.text().trim();
            }

            const imgElOld = item.find('img');
            if (imgElOld.length > 0) {
                let imageUrl = imgElOld.attr('src');
                if (!imageUrl) {
                    imageUrl = imgElOld.attr('data-delayed-url') || imgElOld.attr('data-src') || imgElOld.attr('data-ghost-url');
                }
                carouselItem.imageUrl = ensureAbsoluteUrl(imageUrl || '', baseUrl);
                carouselItem.imageAlt = imgElOld.attr('alt') || '';
            }

            const linkElOld = item.find('a');
            if (linkElOld.length > 0) {
                carouselItem.linkUrl = ensureAbsoluteUrl(linkElOld.attr('href') || '', baseUrl);
            }
            items.push(carouselItem);
        });
        if (items.length > 0) {
            log.debug(`Found ${items.length} items using fallback selector .ad-carousel-item`);
        } else {
            log.warning('Still no carousel items found after trying fallback selector for base URL: ' + baseUrl);
        }
    }
    
    return items;
}

const extractAdId = (url: string): string => {
    try {
        const urlParts = url.split('/');
        const adId = urlParts.pop()?.split('?')[0];
        return adId || 'unknown';
    } catch (e) {
        log.error('Failed to extract ad ID from URL', { url });
        return 'unknown';
    }
};

/**
 * Extracts ad content (text, images, etc.)
 */
function extractAdContent($: CheerioAPI, adDetail: AdDetail): void {
    log.debug(`Extracting content for Ad ID: ${adDetail.adId}, Type: ${adDetail.adType}`);

    const LINKEDIN_PLACEHOLDER_IMG_URL = 'https://static.licdn.com/aero-v1/sc/h/9l8dv1r8a09nem281grvopn9l';

    // Helper to identify placeholder images
    // Cheerio.Element is the correct type for 'el' in .each() callbacks
    function isPotentialPlaceholder(imgElement: Cheerio<any>, imgSrcAttr: string | undefined, baseDetailUrl: string): boolean {
        if (!imgSrcAttr) return false;
        const absoluteImgSrc = ensureAbsoluteUrl(imgSrcAttr, baseDetailUrl);

        if (absoluteImgSrc === LINKEDIN_PLACEHOLDER_IMG_URL) {
            const altText = imgElement.attr('alt')?.trim();
            // Consider it a placeholder if src matches AND (alt is empty OR img has 'onerror' class)
            if (altText === '' || imgElement.hasClass('onerror')) {
                log.debug(`Identified placeholder image for Ad ID ${adDetail.adId}: src=${absoluteImgSrc}, alt="${altText}", hasErrorClass=${imgElement.hasClass('onerror')}`);
                return true;
            }
            log.debug(`Image src matches placeholder URL (${absoluteImgSrc}) for Ad ID ${adDetail.adId}, but alt text ("${altText}") and no 'onerror' class. Treating as non-placeholder.`);
        }
        return false;
    }

    const preserveLinksAndGetText = (element: Cheerio<any>): string => {
        // Create a clone to work with
        const clone = element.clone();
        
        // Replace all links with their text content
        clone.find('a').each((_, el) => {
            const linkText = $(el).text().trim();
            $(el).replaceWith(linkText);
        });
        
        // Replace any <br> with newlines
        let html = clone.html() || '';
        html = html.replace(/<br\s*\/?>/gi, '\n');
        
        // Remove any remaining HTML tags
        return html.replace(/<[^>]*>/g, '').trim();
    };
    
    let adCopy = '';
    
    // Ad Copy (Primary Text)
    // Multiple selectors to try for ad copy, as structure can vary.
    const adCopySelectors = [
        '.commentary__text', // Common for many ad types
        '.feed-shared-update-v2__description .feed-shared-inline-show-more-text', // Another common one
        '.attributed-text-segment-list__content', // Seen in some updates
        'div[data-ad-text]', // Generic data attribute
        '.ad-banner-text-body', // For banner-like ads
        '.title.main-title', // For text ads title
        '.description.secondary-description', // For text ads description
        'p.commentary__content', // As per new Event Ad HTML
    ];

    // For non-message ads, try to extract adCopy using general selectors
    if (adDetail.adType !== 'MESSAGE') {
        for (const selector of adCopySelectors) {
            const adCopyEl = $(selector);
            if (adCopyEl.length > 0) {
                adCopy = preserveLinksAndGetText(adCopyEl);
                break;
            }
        }
    }
    
    adDetail.adCopy = adCopy; // Initialize, will be overwritten by message content if type is MESSAGE
    
    // Extract headline & CTA from the ad
    const headlineEl = $('.sponsored-content-headline h2.text-sm.font-semibold');
    if (headlineEl.length > 0) {
        adDetail.headline = headlineEl.text().trim();
    }
    
    const ctaButton = $('button.btn-sm.btn-secondary-emphasis');
    if (ctaButton.length > 0) {
        adDetail.ctaText = ctaButton.text().trim();
    }
    
    // Extract image URLs
    const imageUrls: string[] = [];
    
    // Main image
    const mainImageElement = $('.ad-preview img.ad-preview__dynamic-dimensions-image').first();
    if (mainImageElement.length > 0) {
        // Prioritize src attribute for the main image
        let mainImageUrlSourceAttr = mainImageElement.attr('src');
        
        // Only use alternatives if src is completely missing
        if (!mainImageUrlSourceAttr) {
            // Try other attributes first
            mainImageUrlSourceAttr = mainImageElement.attr('data-delayed-url') || 
                           mainImageElement.attr('data-src');
                           
            // Use ghost-url as last resort
            if (!mainImageUrlSourceAttr) {
                mainImageUrlSourceAttr = mainImageElement.attr('data-ghost-url');
            }
        }
        
        if (mainImageUrlSourceAttr) {
            if (isPotentialPlaceholder(mainImageElement, mainImageUrlSourceAttr, adDetail.adDetailUrl)) {
                log.debug(`Main image for Ad ID ${adDetail.adId} identified as placeholder. src: ${mainImageUrlSourceAttr}. Not using as adDetail.imageUrl or adding to imageUrls list.`);
            } else {
                const resolvedMainImageUrl = ensureAbsoluteUrl(mainImageUrlSourceAttr, adDetail.adDetailUrl);
                // Add to imageUrls list (will be deduplicated later)
                imageUrls.push(resolvedMainImageUrl);
                
                // If we didn't find adDetail.imageUrl before (e.g. from specific ad type logic), set it now
                if (!adDetail.imageUrl) {
                    adDetail.imageUrl = resolvedMainImageUrl;
                    log.debug(`extractAdContent: Set adDetail.imageUrl from non-placeholder main image for Ad ID: ${adDetail.adId}`);
                }
            }
        }
    }
    
    // Add all images, filtering out placeholders
    $('.ad-preview img').each((_, el) => {
        const imgElement = $(el);

        // Skip if this element is the same as mainImageElement and already processed
        if (mainImageElement.length > 0 && mainImageElement[0] === el) {
            return; // Already handled by mainImageElement logic
        }

        // First try src attribute
        let imgSrcAttr = imgElement.attr('src');
        if (imgSrcAttr) {
            if (!isPotentialPlaceholder(imgElement, imgSrcAttr, adDetail.adDetailUrl) && !imageUrls.includes(ensureAbsoluteUrl(imgSrcAttr, adDetail.adDetailUrl))) {
                imageUrls.push(ensureAbsoluteUrl(imgSrcAttr, adDetail.adDetailUrl));
            }
        } else {
            // If src attribute not available, try others in priority order
            imgSrcAttr = imgElement.attr('data-delayed-url') || 
                          imgElement.attr('data-src') || 
                          imgElement.attr('data-ghost-url');
                          
            if (imgSrcAttr && !isPotentialPlaceholder(imgElement, imgSrcAttr, adDetail.adDetailUrl) && !imageUrls.includes(ensureAbsoluteUrl(imgSrcAttr, adDetail.adDetailUrl))) {
                imageUrls.push(ensureAbsoluteUrl(imgSrcAttr, adDetail.adDetailUrl));
            }
        }
        
        // Check for srcset attribute (responsive images) - also apply placeholder check
        const srcset = imgElement.attr('srcset');
        if (srcset) {
            const srcsetParts = srcset.split(',');
            for (const part of srcsetParts) {
                const [urlCandidate] = part.trim().split(' ');
                if (urlCandidate && !isPotentialPlaceholder(imgElement, urlCandidate, adDetail.adDetailUrl) && !imageUrls.includes(ensureAbsoluteUrl(urlCandidate, adDetail.adDetailUrl))) {
                    imageUrls.push(ensureAbsoluteUrl(urlCandidate, adDetail.adDetailUrl));
                    break; // Just take the first valid one from srcset for simplicity
                }
            }
        }
    });
    
    if (imageUrls.length > 0) {
        adDetail.imageUrls = [...new Set(imageUrls)]; // Assign unique, non-placeholder URLs
        
        // If primary adDetail.imageUrl is still not set (e.g. main image was placeholder or not found)
        // and we have valid images in the list, use the first one.
        if (!adDetail.imageUrl && adDetail.imageUrls.length > 0) {
            adDetail.imageUrl = adDetail.imageUrls[0];
            log.debug(`extractAdContent: Set adDetail.imageUrl from filtered imageUrls list for Ad ID: ${adDetail.adId}`);
        }
    } else {
        // If imageUrls list is empty, it means all found images were placeholders or no images were found.
        // Ensure adDetail.imageUrl is undefined if it wasn't set by a specific (trusted) ad type logic.
        // The current flow means if adDetail.imageUrl was set by mainImageElement, it was already checked.
        // If adDetail.imageUrl was set by ad-type specific logic (e.g. EVENT), that logic needs its own placeholder check.
        log.debug(`extractAdContent: imageUrls list is empty (all placeholders or no images) for Ad ID: ${adDetail.adId}. adDetail.imageUrl remains: ${adDetail.imageUrl}`);
        if (adDetail.imageUrls && adDetail.imageUrls.length === 0) { // If list was initialized but ended up empty
             adDetail.imageUrls = undefined; // Explicitly set to undefined if empty
        }
    }
    
    // Extract video URL if present
    const videoContainer = $('.share-native-video');
    if (videoContainer.length > 0) {
        let extractedVideoUrl: string | undefined;
        let extractedVideoThumbnailUrl: string | undefined;
        
        // First try to get data-sources from the video player div
        const videoPlayerDiv = videoContainer.find('.share-native-video__node');
        let videoSourcesAttr = videoPlayerDiv.attr('data-sources');
        
        // If not found on player div, try the video tag itself
        if (!videoSourcesAttr) {
            const videoTag = videoContainer.find('video');
            if (videoTag.length > 0) {
                videoSourcesAttr = videoTag.attr('data-sources');
            }
        }

        if (videoSourcesAttr) {
            try {
                const sources = JSON.parse(videoSourcesAttr);
                if (Array.isArray(sources) && sources.length > 0) {
                    // Use the highest quality source
                    const highestQualitySource = sources.reduce((prev, current) => {
                        return (current.bitrate > prev.bitrate) ? current : prev;
                    });
                    extractedVideoUrl = highestQualitySource.src;
                    log.debug(`extractAdContent: Extracted video URL from data-sources for Ad ID ${adDetail.adId}: ${extractedVideoUrl}`);
                }
            } catch (e) {
                log.debug(`extractAdContent: Error parsing video sources from data-sources for Ad ID ${adDetail.adId}`, { error: (e as Error).message });
            }
        }

        // Fallback to video tag src if data-sources didn't yield a URL or was not present
        if (!extractedVideoUrl) {
            const videoTag = videoContainer.find('video');
            if (videoTag.length > 0) {
                extractedVideoUrl = videoTag.attr('src');
                log.debug(`extractAdContent: Extracted video URL from video tag src for Ad ID ${adDetail.adId}: ${extractedVideoUrl}`);
            }
        }

        // Extract video thumbnail/poster URL
        if (videoPlayerDiv.length > 0) {
            extractedVideoThumbnailUrl = videoPlayerDiv.attr('data-poster-url');
        }
        
        if (!extractedVideoThumbnailUrl) {
            const videoTag = videoContainer.find('video');
            if (videoTag.length > 0) {
                extractedVideoThumbnailUrl = videoTag.attr('poster') || videoTag.attr('data-poster-url');
            }
        }

        if (extractedVideoUrl) {
            adDetail.videoUrl = ensureAbsoluteUrl(extractedVideoUrl, adDetail.adDetailUrl);
            
            // Also capture video thumbnail if available
            if (extractedVideoThumbnailUrl) {
                adDetail.videoThumbnailUrl = ensureAbsoluteUrl(extractedVideoThumbnailUrl, adDetail.adDetailUrl);
                log.debug(`extractAdContent: Extracted video thumbnail URL for Ad ID ${adDetail.adId}: ${adDetail.videoThumbnailUrl}`);
            }
            
             // If adType wasn't set to VIDEO by data-creative-type, this is another indicator
            if (adDetail.adType === 'UNKNOWN' || !adDetail.adType) {
                adDetail.adType = 'VIDEO';
                log.debug(`extractAdContent: Set adType to VIDEO based on video presence for Ad ID: ${adDetail.adId}`);
            }
        } else {
            log.warning(`extractAdContent: Could not extract video URL for Ad ID: ${adDetail.adId} from .share-native-video element.`);
        }
    }
    
    // Extract document URL for document ads
    const documentFrame = $('iframe[data-id="sponsored-native-document-preview"]');
    if (documentFrame.length > 0) {
        const documentConfig = documentFrame.attr('data-native-document-config');
        if (documentConfig) {
            try {
                const config = JSON.parse(documentConfig);
                if (config.doc && config.doc.manifestUrl) {
                    adDetail.documentUrl = config.doc.manifestUrl;
                }
                // Add title extraction
                if (config.doc && config.doc.title) {
                    adDetail.documentTitle = config.doc.title;
                }
            } catch (e) {
                log.debug('Error parsing document config', { error: (e as Error).message });
            }
        }
    }
    
    // Extract click URL - preserving UTM parameters for external links
    const clickLink = $('a[data-tracking-control-name="ad_library_ad_preview_headline_content"]');
    if (clickLink.length > 0) {
        // For click URLs, we keep the UTM parameters intact as these are important for ad analytics
        adDetail.clickUrl = clickLink.attr('href') || '';
    } else {
        // Try other common link elements
        const otherLinks = $('a[data-tracking-control-name="ad_library_ad_preview_content_image"]');
        if (otherLinks.length > 0) {
            adDetail.clickUrl = otherLinks.attr('href') || '';
        } else {
            // Fallback to links in commentary if no primary CTA link found
            const commentarySection = $('.commentary__content, .commentary__container');
            let commentaryClickUrl: string | undefined;
            commentarySection.find('a[data-tracking-control-name="ad_library_ad_preview_commentary_link"]').each((_, el) => {
                const href = $(el).attr('href');
                // Prioritize non-hashtag, non-LinkedIn profile/company links
                if (href && !href.startsWith('https://www.linkedin.com/feed/hashtag/') && 
                    !href.includes('linkedin.com/in/') && 
                    !href.includes('linkedin.com/company/')) {
                    commentaryClickUrl = href;
                    return false; // Found a suitable primary commentary link
                }
                return true; // Continue iteration
            });

            if (commentaryClickUrl) {
                adDetail.clickUrl = commentaryClickUrl;
            } else {
                // If no "external-like" link was found, take the first non-hashtag link from commentary
                commentarySection.find('a[data-tracking-control-name="ad_library_ad_preview_commentary_link"]').each((_, el) => {
                    const href = $(el).attr('href');
                    if (href && !href.startsWith('https://www.linkedin.com/feed/hashtag/')) {
                        adDetail.clickUrl = href;
                        return false; // Found a suitable link
                    }
                    return true; // Continue iteration
                });
            }
        }
    }

    if (adDetail.adType === 'UNKNOWN') {
        // Attempt to determine ad type if not already set by creativeType
        const videoElement = $('video');
        const imageElement = $('.ad-preview-image img, .ad-image__image img, img.ad-preview__dynamic-dimensions-image'); // Added event ad image
        const documentElement = $('iframe[data-id="sponsored-native-document-preview"]');
        const carouselElement = $('.ad-carousel-item, .slide-list__list > div');
        // const eventElement = $('.ad-preview-event-info'); // Already defined, consider if SPONSORED_UPDATE_EVENT is primary
        const textOnlyElement = $('.ad-preview-text');
        const messageAdContent = $('.sponsored-message__content'); // for message ads specifically
        const jobAdElement = $('.container-raised .flex.flex-col.px-3.py-1\\.5.m-1\\.5.gap-y-1\\.5.text-center.items-center'); // for job ads

        if (videoElement.length > 0) {
            adDetail.adType = 'VIDEO';
        } else if (carouselElement.length > 0) {
            adDetail.adType = 'CAROUSEL';
        } else if (documentElement.length > 0) {
            adDetail.adType = 'DOCUMENT';
        } else if ($('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"]').length > 0) { // Check specifically for event ad structure
            adDetail.adType = 'EVENT';
        } else if (jobAdElement.length > 0) { // Check for job ad structure
            adDetail.adType = 'JOB';
        } else if (imageElement.length > 0) {
            // This is a broad category, could be SINGLE_IMAGE or part of another type
            // We'll refine this based on other elements or lack thereof
            // If no other specific type indicators are present, assume SINGLE_IMAGE
            adDetail.adType = 'SINGLE_IMAGE';
        } else if (messageAdContent.length > 0) {
            adDetail.adType = 'MESSAGE';
        } else if (textOnlyElement.length > 0 || $('.text-ad-preview').length > 0) {
            adDetail.adType = 'TEXT';
        } else {
            log.warning(`Detail Scraper: Could not determine ad type through fallback for Ad ID: ${adDetail.adId}`);
        }
    }

    switch (adDetail.adType) {
        case 'VIDEO': {
            // Video URL is already extracted in extractAdContent
            break;
        }
        case 'CAROUSEL': {
            adDetail.carouselItems = extractCarouselItems($, adDetail.adDetailUrl);
            // Ad copy is usually handled by the generic selector
            // CTA is also usually generic
            break;
        }
        case 'SPOTLIGHT': {
            log.debug(`Detail Scraper: Extracting SPOTLIGHT specific content for Ad ID: ${adDetail.adId}`);
            
            // Try multiple approaches to find the Spotlight content
            let contentContainer;
            
            // Approach 1: Look for the specific ad preview container with data-creative-type
            const spotlightAdPreview = $('.ad-preview[data-creative-type="SPOTLIGHT_V2"]');
            if (spotlightAdPreview.length > 0) {
                contentContainer = spotlightAdPreview.find('.container-lined');
                log.debug(`Detail Scraper: SPOTLIGHT - Found container via data-creative-type for Ad ID: ${adDetail.adId}`);
            }
            
            // Approach 2: Fallback - Look for container-lined with Spotlight structure patterns
            if (!contentContainer || contentContainer.length === 0) {
                // Look for container-lined that has the typical Spotlight structure
                const containerCandidates = $('.container-lined');
                containerCandidates.each((_, el) => {
                    const candidate = $(el);
                    // Check if this container has the Spotlight pattern:
                    // - Contains an h2 with font-semibold
                    // - Contains a CTA button with the specific tracking control name
                    // - Contains a p element with text-color-text-low-emphasis
                    if (candidate.find('h2.font-semibold').length > 0 && 
                        candidate.find('a[data-tracking-control-name="ad_library_ad_detail_cta"]').length > 0 &&
                        candidate.find('p.text-color-text-low-emphasis').length > 0) {
                        contentContainer = candidate;
                        log.debug(`Detail Scraper: SPOTLIGHT - Found container via pattern matching for Ad ID: ${adDetail.adId}`);
                        return false; // Break the each loop
                    }
                    return true; // Continue the each loop
                });
            }

            if (contentContainer && contentContainer.length > 0) {
                // Description (top paragraph) - updated selector to be more flexible
                const descriptionSelectors = [
                    'p.text-xs.leading-\[16px\].text-color-text-low-emphasis',
                    'p.text-color-text-low-emphasis',
                    'p.text-xs.text-color-text-low-emphasis'
                ];
                
                let descriptionEl;
                for (const selector of descriptionSelectors) {
                    descriptionEl = contentContainer.find(selector).first();
                    if (descriptionEl.length > 0) break;
                }
                
                if (descriptionEl && descriptionEl.length > 0) {
                    adDetail.adCopy = descriptionEl.text().trim();
                    log.debug(`Detail Scraper: SPOTLIGHT - AdCopy: "${adDetail.adCopy}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: SPOTLIGHT - Description element not found for Ad ID: ${adDetail.adId}`);
                }

                // Headline (h2 element) - updated selector to be more flexible
                const headlineSelectors = [
                    'h2.text-sm.text-color-text.leading-\[18px\].font-semibold',
                    'h2.font-semibold',
                    'h2.text-sm.font-semibold'
                ];
                
                let headlineElSpotlight;
                for (const selector of headlineSelectors) {
                    headlineElSpotlight = contentContainer.find(selector);
                    if (headlineElSpotlight.length > 0) break;
                }
                
                if (headlineElSpotlight && headlineElSpotlight.length > 0) {
                    adDetail.headline = headlineElSpotlight.text().trim();
                    log.debug(`Detail Scraper: SPOTLIGHT - Headline: "${adDetail.headline}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: SPOTLIGHT - Headline element not found for Ad ID: ${adDetail.adId}`);
                }

                // CTA Text and Click URL (button-like anchor)
                const ctaLinkEl = contentContainer.find('a.btn-sm.btn-secondary-emphasis[data-tracking-control-name="ad_library_ad_detail_cta"]');
                if (ctaLinkEl.length > 0) {
                    adDetail.ctaText = ctaLinkEl.text().trim();
                    const href = ctaLinkEl.attr('href');
                    if (href) {
                        adDetail.clickUrl = ensureAbsoluteUrl(href, adDetail.adDetailUrl);
                    }
                    log.debug(`Detail Scraper: SPOTLIGHT - CTA: "${adDetail.ctaText}", URL: "${adDetail.clickUrl}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: SPOTLIGHT - CTA link element not found for Ad ID: ${adDetail.adId}`);
                }

                // Advertiser Logo URL (ensure it's picked up if not already by general logic)
                if (!adDetail.advertiserLogoUrl) {
                    const logoImgEl = contentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
                    if (logoImgEl.length > 0) {
                        let logoSrcAttr = logoImgEl.attr('src');
                        if (!logoSrcAttr) {
                            logoSrcAttr = logoImgEl.attr('data-delayed-url') ||
                                          logoImgEl.attr('data-src') ||
                                          logoImgEl.attr('data-ghost-url');
                        }
                        if (logoSrcAttr) {
                            adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrcAttr, adDetail.adDetailUrl);
                            log.debug(`Detail Scraper: SPOTLIGHT - Fallback advertiserLogoUrl extracted: ${adDetail.advertiserLogoUrl} for Ad ID: ${adDetail.adId}`);
                        }
                    }
                }

            } else {
                log.warning(`Detail Scraper: SPOTLIGHT - Could not find content container for Ad ID: ${adDetail.adId}`);
            }
            break;
        }
        case 'FOLLOW_COMPANY': {
            log.debug(`Detail Scraper: Extracting FOLLOW_COMPANY specific content for Ad ID: ${adDetail.adId}`);
            
            // Try multiple approaches to find the Follow Company content
            let contentContainer;
            
            // Approach 1: Look for the specific ad preview container with data-creative-type
            const followCompanyAdPreview = $('.ad-preview[data-creative-type="FOLLOW_COMPANY_V2"]');
            if (followCompanyAdPreview.length > 0) {
                contentContainer = followCompanyAdPreview.find('.container-lined');
                log.debug(`Detail Scraper: FOLLOW_COMPANY - Found container via data-creative-type for Ad ID: ${adDetail.adId}`);
            }
            
            // Approach 2: Fallback - Look for container-lined with Follow Company structure patterns
            if (!contentContainer || contentContainer.length === 0) {
                // Look for container-lined that has the typical Follow Company structure
                const containerCandidates = $('.container-lined');
                containerCandidates.each((_, el) => {
                    const candidate = $(el);
                    // Check if this container has the Follow Company pattern:
                    // - Contains an h2 with font-semibold
                    // - Contains a CTA button with the specific tracking control name
                    // - Contains a p element with text-color-text-low-emphasis
                    if (candidate.find('h2.font-semibold').length > 0 && 
                        candidate.find('a[data-tracking-control-name="ad_library_ad_detail_cta"]').length > 0 &&
                        candidate.find('p.text-color-text-low-emphasis').length > 0) {
                        contentContainer = candidate;
                        log.debug(`Detail Scraper: FOLLOW_COMPANY - Found container via pattern matching for Ad ID: ${adDetail.adId}`);
                        return false; // Break the each loop
                    }
                    return true; // Continue the each loop
                });
            }

            if (contentContainer && contentContainer.length > 0) {
                // Description (top paragraph) - updated selector to be more flexible
                const descriptionSelectors = [
                    'p.text-xs.leading-\[16px\].text-color-text-low-emphasis',
                    'p.text-color-text-low-emphasis',
                    'p.text-xs.text-color-text-low-emphasis'
                ];
                
                let descriptionEl;
                for (const selector of descriptionSelectors) {
                    descriptionEl = contentContainer.find(selector).first();
                    if (descriptionEl.length > 0) break;
                }
                
                if (descriptionEl && descriptionEl.length > 0) {
                    adDetail.adCopy = descriptionEl.text().trim();
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - AdCopy: "${adDetail.adCopy}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - Description element not found for Ad ID: ${adDetail.adId}`);
                }

                // Headline (h2 element) - updated selector to be more flexible
                const headlineSelectors = [
                    'h2.text-sm.text-color-text.leading-\[18px\].font-semibold',
                    'h2.font-semibold',
                    'h2.text-sm.font-semibold'
                ];
                
                let headlineElFollow;
                for (const selector of headlineSelectors) {
                    headlineElFollow = contentContainer.find(selector);
                    if (headlineElFollow.length > 0) break;
                }
                
                if (headlineElFollow && headlineElFollow.length > 0) {
                    adDetail.headline = headlineElFollow.text().trim();
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - Headline: "${adDetail.headline}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - Headline element not found for Ad ID: ${adDetail.adId}`);
                }

                // CTA Text and Click URL (button-like anchor)
                const ctaLinkEl = contentContainer.find('a.btn-sm.btn-secondary-emphasis[data-tracking-control-name="ad_library_ad_detail_cta"]');
                if (ctaLinkEl.length > 0) {
                    adDetail.ctaText = ctaLinkEl.text().trim();
                    const href = ctaLinkEl.attr('href');
                    if (href) {
                        adDetail.clickUrl = ensureAbsoluteUrl(href, adDetail.adDetailUrl);
                    }
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - CTA: "${adDetail.ctaText}", URL: "${adDetail.clickUrl}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: FOLLOW_COMPANY - CTA link element not found for Ad ID: ${adDetail.adId}`);
                }

                // Advertiser Logo URL (ensure it's picked up if not already by general logic)
                if (!adDetail.advertiserLogoUrl) {
                    const logoImgEl = contentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
                    if (logoImgEl.length > 0) {
                        let logoSrcAttr = logoImgEl.attr('src');
                        if (!logoSrcAttr) {
                            logoSrcAttr = logoImgEl.attr('data-delayed-url') ||
                                          logoImgEl.attr('data-src') ||
                                          logoImgEl.attr('data-ghost-url');
                        }
                        if (logoSrcAttr) {
                            adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrcAttr, adDetail.adDetailUrl);
                            log.debug(`Detail Scraper: FOLLOW_COMPANY - Fallback advertiserLogoUrl extracted: ${adDetail.advertiserLogoUrl} for Ad ID: ${adDetail.adId}`);
                        }
                    }
                }

            } else {
                log.warning(`Detail Scraper: FOLLOW_COMPANY - Could not find content container for Ad ID: ${adDetail.adId}`);
            }
            break;
        }
        case 'JOB': {
            log.debug(`Detail Scraper: Extracting JOB specific content for Ad ID: ${adDetail.adId}`);
            
            // Try multiple approaches to find the Job Ad content
            let contentContainer;
            
            // Approach 1: Look for the specific ad preview container with data-creative-type
            const jobAdPreview = $('.ad-preview[data-creative-type="JOBS_V2"]');
            if (jobAdPreview.length > 0) {
                contentContainer = jobAdPreview.find('.container-raised .flex.flex-col.px-3.py-1\\.5.m-1\\.5.gap-y-1\\.5.text-center.items-center');
                log.debug(`Detail Scraper: JOB - Found container via data-creative-type for Ad ID: ${adDetail.adId}`);
            }
            
            // Approach 2: Fallback - Look for container patterns with Job Ad structure
            if (!contentContainer || contentContainer.length === 0) {
                // Look for container-raised that has the typical Job Ad structure
                const containerCandidates = $('.container-raised');
                containerCandidates.each((_, el) => {
                    const candidate = $(el);
                    // Check if this container has the Job Ad pattern:
                    // - Contains an h2 with specific job ad classes
                    // - Contains a CTA button with the specific tracking control name
                    // - Has text-center and items-center classes structure
                    const innerContainer = candidate.find('.flex.flex-col.px-3.py-1\\.5.m-1\\.5.gap-y-1\\.5.text-center.items-center');
                    if (innerContainer.length > 0 && 
                        innerContainer.find('h2.text-sm.leading-\\[18px\\].text-color-text').length > 0 && 
                        innerContainer.find('a[data-tracking-control-name="ad_library_ad_detail_cta"]').length > 0) {
                        contentContainer = innerContainer;
                        log.debug(`Detail Scraper: JOB - Found container via pattern matching for Ad ID: ${adDetail.adId}`);
                        return false; // Break the each loop
                    }
                    return true; // Continue the each loop
                });
            }

            if (contentContainer && contentContainer.length > 0) {
                // Job Ad Headline/Message - specific selector for job ads
                const headlineSelectors = [
                    'h2.text-sm.leading-\\[18px\\].text-color-text.max-w-\\[276px\\].break-words.w-full',
                    'h2.text-sm.leading-\\[18px\\].text-color-text',
                    'h2.text-sm.text-color-text'
                ];
                
                let headlineElJob;
                for (const selector of headlineSelectors) {
                    headlineElJob = contentContainer.find(selector);
                    if (headlineElJob.length > 0) break;
                }
                
                if (headlineElJob && headlineElJob.length > 0) {
                    adDetail.headline = headlineElJob.text().trim();
                    log.debug(`Detail Scraper: JOB - Headline: "${adDetail.headline}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: JOB - Headline element not found for Ad ID: ${adDetail.adId}`);
                }

                // CTA Text and Click URL (button-like anchor)
                const ctaLinkEl = contentContainer.find('a.btn-sm.btn-secondary-emphasis[data-tracking-control-name="ad_library_ad_detail_cta"]');
                if (ctaLinkEl.length > 0) {
                    adDetail.ctaText = ctaLinkEl.text().trim();
                    const href = ctaLinkEl.attr('href');
                    if (href) {
                        adDetail.clickUrl = ensureAbsoluteUrl(href, adDetail.adDetailUrl);
                    }
                    log.debug(`Detail Scraper: JOB - CTA: "${adDetail.ctaText}", URL: "${adDetail.clickUrl}" for Ad ID: ${adDetail.adId}`);
                } else {
                    log.debug(`Detail Scraper: JOB - CTA link element not found for Ad ID: ${adDetail.adId}`);
                }

                // Company Logo URL (ensure it's picked up if not already by general logic)
                if (!adDetail.advertiserLogoUrl) {
                    const logoImgEl = contentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
                    if (logoImgEl.length > 0) {
                        let logoSrcAttr = logoImgEl.attr('src');
                        if (!logoSrcAttr) {
                            logoSrcAttr = logoImgEl.attr('data-delayed-url') ||
                                          logoImgEl.attr('data-src') ||
                                          logoImgEl.attr('data-ghost-url');
                        }
                        if (logoSrcAttr) {
                            adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrcAttr, adDetail.adDetailUrl);
                            log.debug(`Detail Scraper: JOB - Company logo extracted: ${adDetail.advertiserLogoUrl} for Ad ID: ${adDetail.adId}`);
                        }
                    }
                }

            } else {
                log.warning(`Detail Scraper: JOB - Could not find content container for Ad ID: ${adDetail.adId}`);
            }
            break;
        }
        case 'DOCUMENT': {
            // Document URL is already extracted in extractAdContent
            break;
        }
        case 'TEXT': {
            log.debug(`Detail Scraper: Extracting TEXT specific content for Ad ID: ${adDetail.adId}`);
            
            // Look for the text ad container with the new format
            const textAdContentContainer = $('.container-lined');
            
            if (textAdContentContainer.length > 0) {
                // Extract headline/title from the link text
                const titleLinkEl = textAdContentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_text_ad_content_link"]');
                if (titleLinkEl.length > 0) {
                    adDetail.headline = titleLinkEl.text().trim();
                    adDetail.clickUrl = ensureAbsoluteUrl(titleLinkEl.attr('href') || '', adDetail.adDetailUrl);
                    log.debug(`Detail Scraper: TEXT - Headline: "${adDetail.headline}", URL: "${adDetail.clickUrl}" for Ad ID: ${adDetail.adId}`);
                }
                
                // Extract description text (the text after the " - " separator)
                const textContentEl = textAdContentContainer.find('.font-semibold.text-sm.break-words.leading-\\[18px\\]');
                if (textContentEl.length > 0) {
                    const fullText = textContentEl.text().trim();
                    // Split on " - " to separate headline from description
                    const parts = fullText.split(' - ');
                    if (parts.length > 1) {
                        // The description is everything after the first " - "
                        adDetail.adCopy = parts.slice(1).join(' - ').trim();
                        log.debug(`Detail Scraper: TEXT - AdCopy: "${adDetail.adCopy}" for Ad ID: ${adDetail.adId}`);
                    } else {
                        // If no separator found, use the full text as headline if not already set
                        if (!adDetail.headline) {
                            adDetail.headline = fullText;
                        }
                    }
                }
                
                // Extract small logo image
                const logoImageEl = textAdContentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_text_ad_content_logo"] img');
                if (logoImageEl.length > 0) {
                    let logoSrc = logoImageEl.attr('src');
                    if (!logoSrc) {
                        logoSrc = logoImageEl.attr('data-delayed-url') || 
                                  logoImageEl.attr('data-src') ||
                                  logoImageEl.attr('data-ghost-url');
                    }
                    if (logoSrc) {
                        adDetail.imageUrl = ensureAbsoluteUrl(logoSrc, adDetail.adDetailUrl);
                        // Add to imageUrls array if not already there
                        if (!adDetail.imageUrls) adDetail.imageUrls = [];
                        if (!adDetail.imageUrls.includes(adDetail.imageUrl)) {
                            adDetail.imageUrls.push(adDetail.imageUrl);
                        }
                        log.debug(`Detail Scraper: TEXT - Logo Image URL: ${adDetail.imageUrl} for Ad ID: ${adDetail.adId}`);
                    }
                }
                
            } else {
                log.warning(`Detail Scraper: TEXT - Could not find text ad container for Ad ID: ${adDetail.adId}`);
            }
            break;
        }
        case 'EVENT': {
            log.debug(`Detail Scraper: Extracting EVENT specific content for Ad ID: ${adDetail.adId}`);
            // Ad Copy is handled by the updated generic selector: 'p.commentary__content'

            // Image URL
            const eventImageElement = $('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"] img.ad-preview__dynamic-dimensions-image');
            if (eventImageElement.length > 0) {
                const eventImgSrc = eventImageElement.attr('src');
                if (eventImgSrc) {
                    if (isPotentialPlaceholder(eventImageElement, eventImgSrc, adDetail.adDetailUrl)) {
                        log.debug(`Detail Scraper: Event image for Ad ID ${adDetail.adId} identified as placeholder. Src: ${eventImgSrc}`);
                        // adDetail.imageUrl remains undefined or as previously set
                    } else {
                        adDetail.imageUrl = ensureAbsoluteUrl(eventImgSrc, adDetail.adDetailUrl);
                        log.debug(`Detail Scraper: Event Image URL: ${adDetail.imageUrl} for Ad ID: ${adDetail.adId}`);
                        // Add to general imageUrls list if not already there (might be redundant if general scan picks it up)
                        if (adDetail.imageUrl && (!adDetail.imageUrls || !adDetail.imageUrls.includes(adDetail.imageUrl))) {
                            if (!adDetail.imageUrls) adDetail.imageUrls = [];
                            adDetail.imageUrls.push(adDetail.imageUrl);
                        }
                    }
                }
            } else {
                log.debug(`Detail Scraper: No specific event image found for Ad ID: ${adDetail.adId}. Fallback to general image might occur.`);
            }

            const eventDetailsContainer = $('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"] a[data-tracking-control-name="ad_library_ad_preview_event_content"]');
            const eventCtaButton = $('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"] a[data-tracking-control-name="ad_library_ad_detail_cta"]');


            if (eventDetailsContainer.length > 0) {
                adDetail.eventDetails = {
                    name: eventDetailsContainer.find('h2.text-color-text').text().trim() || '',
                    time: eventDetailsContainer.find('time.text-color-container-caution').text().trim() || '',
                    location: eventDetailsContainer.find('p.text-color-text.text-xs.leading-\[16px\]').text().trim() || '', // Escaped brackets
                    url: cleanLinkedInUrl(eventDetailsContainer.attr('href') || ''),
                };
                log.debug(`Detail Scraper: Event details extracted via content link for Ad ID: ${adDetail.adId}: ${JSON.stringify(adDetail.eventDetails)}`);

                // CTA might be part of this section or a separate button
                if (!adDetail.ctaText && eventCtaButton.length > 0) {
                    adDetail.ctaText = eventCtaButton.text().trim();
                    adDetail.eventUrl = cleanLinkedInUrl(eventCtaButton.attr('href') || ''); // Also capture destination URL from CTA
                    log.debug(`Detail Scraper: Event CTA (button): "${adDetail.ctaText}", URL: "${adDetail.eventUrl}" for Ad ID: ${adDetail.adId}`);
                } else if (!adDetail.ctaText && eventCtaButton.length === 0) {
                    // If no separate CTA button, the "View event" text might be implied or part of the main event link's context
                    // However, the user specifically pointed out a "View event" button.
                    // For now, if the button is not present, we won't set a CTA from the content link itself unless it's explicitly a CTA.
                    log.debug(`Detail Scraper: No separate CTA button found for event Ad ID: ${adDetail.adId}. Main event link: ${adDetail.eventDetails.url}`);
                }


            } else if (eventCtaButton.length > 0) {
                 // Fallback if the main details container isn't found but the CTA button is
                adDetail.ctaText = eventCtaButton.text().trim();
                adDetail.eventUrl = cleanLinkedInUrl(eventCtaButton.attr('href') || '');
                adDetail.eventDetails = { // Initialize with what we can get
                    name: '',
                    time: '',
                    location: '',
                    url: adDetail.eventUrl, // The CTA link is the event link in this case
                };
                log.debug(`Detail Scraper: Event CTA (button) found, but main details container missing for Ad ID: ${adDetail.adId}. CTA: "${adDetail.ctaText}", URL: "${adDetail.eventUrl}"`);
                 // We might need to find event name/time differently if this path is taken
            } else {
                log.warning(`Detail Scraper: Could not find event details container or CTA button for EVENT Ad ID: ${adDetail.adId}`);
            }
            // If destinationUrl is not set by CTA, and event URL is present, use that.
            if (!adDetail.eventUrl && adDetail.eventDetails?.url) {
                adDetail.eventUrl = adDetail.eventDetails.url;
            }

            break;
        }
        case 'SINGLE_IMAGE': {
            // Single Image content is already extracted in extractAdContent
            break;
        }
        case 'MESSAGE': {
            log.debug(`Detail Scraper: Extracting MESSAGE specific content for Ad ID: ${adDetail.adId}`);
            adDetail.messageDetails = {
                senderName: '',
                messageContent: '',
                links: [],
                buttonCtaText: '',
            };

            const messagePreviewBase = $('.sponsored-message-preview'); 

            // Advertiser Info (specific fallback for message ads if general failed)
            if (!adDetail.advertiserName && messagePreviewBase.length > 0) {
                 const topAdvertiserContainer = messagePreviewBase.find('.flex.items-center.px-1\.5.gap-1').first();
                 if (topAdvertiserContainer.length > 0) {
                     const name = topAdvertiserContainer.find('.block.text-md.text-color-text.font-bold').text().trim();
                     const logoImg = topAdvertiserContainer.find('img[alt="advertiser logo"]');
                     const logoUrl = logoImg.attr('src') || logoImg.attr('data-delayed-url') || logoImg.attr('data-ghost-url');
                     if (name) adDetail.advertiserName = name;
                     if (logoUrl) adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoUrl, adDetail.adDetailUrl);
                 }
            }

            // Sender Details
            const senderContainer = messagePreviewBase.find('.flex.py-\[18px\].px-1\.5.gap-x-1');
            if (senderContainer.length > 0) {
                const senderName = senderContainer.find('p.font-semibold.leading-\[20px\].text-md.text-color-text').first().text().trim();
                const senderImgEl = senderContainer.find('.relative.shrink-0.h-6.w-6 img.rounded-\[50\%\]').first();
                const senderImageUrlSrc = senderImgEl.attr('src') || senderImgEl.attr('data-delayed-url') || senderImgEl.attr('data-ghost-url');
                const senderImageUrl = senderImageUrlSrc ? ensureAbsoluteUrl(senderImageUrlSrc, adDetail.adDetailUrl) : undefined;

                if (senderName) {
                    adDetail.messageDetails.senderName = senderName;
                    // Populate promoterDetails as well - message ads always have a personal messenger
                    adDetail.promoterDetails = {
                        promoterName: senderName,
                        promoterProfileUrl: '', 
                        promoterProfileId: '',  
                        promoterImageUrl: senderImageUrl,
                        // promoterHeadline is not available directly here
                    };
                    // Message ads are company promotions delivered through personal channels
                    adDetail.promotionType = 'COMPANY';
                }
            }

            // Message Content - Handle both the content element and spinmail elements
            const messageContentEl = messagePreviewBase.find('.sponsored-message__content');
            const spinmailElements = messagePreviewBase.find('.spinmail-quill-editor__spin-break');
            let extractedMessageContent = '';
            
            // Try to extract from the content element first
            if (messageContentEl.length > 0 && messageContentEl.children().length > 0) {
                const tempDiv = $('<div></div>').append(messageContentEl.clone().children());
                tempDiv.find('br').replaceWith('\n');
                tempDiv.find('li').each((_, li) => {
                    $(li).prepend('    * ').append('\n');
                });
                tempDiv.find('p').append('\n');
                extractedMessageContent = tempDiv.text();
                extractedMessageContent = extractedMessageContent.replace(/(\n\s*)+/g, '\n').trim();
            }
            
            // If content element is empty or doesn't have children, try spinmail elements
            if (!extractedMessageContent && spinmailElements.length > 0) {
                const contentParts: string[] = [];
                spinmailElements.each((_, el) => {
                    const $el = $(el);
                    let text = $el.text().trim();
                    if (text && text !== '' && !text.match(/^\s*$/)) {
                        contentParts.push(text);
                    }
                });
                extractedMessageContent = contentParts.join('\n\n');
            }
            
            if (extractedMessageContent) {
                adDetail.messageDetails.messageContent = extractedMessageContent;
                adDetail.adCopy = extractedMessageContent; // Also populate the main adCopy field
            }

            // Extract links - check both content element and spinmail elements
            const linkContainers = messageContentEl.length > 0 && messageContentEl.children().length > 0 
                ? [messageContentEl] 
                : spinmailElements.length > 0 
                    ? [messagePreviewBase] // Search in the whole preview base to catch spinmail links
                    : [messageContentEl]; // Fallback to original logic

            linkContainers.forEach(container => {
                container.find('a').each((_, el) => {
                    const linkText = $(el).text().trim();
                    const linkUrl = $(el).attr('href');
                    if (linkText && linkUrl) {
                        const absLinkUrl = ensureAbsoluteUrl(linkUrl, adDetail.adDetailUrl);
                        
                        // Avoid duplicates
                        const exists = adDetail.messageDetails!.links!.some(link => 
                            link.url === absLinkUrl && link.text === linkText
                        );
                        
                        if (!exists) {
                            adDetail.messageDetails!.links!.push({ text: linkText, url: absLinkUrl });

                            if (!adDetail.messageDetails!.ctaText && $(el).attr('rel') === 'noopener') {
                                adDetail.messageDetails!.ctaText = linkText;
                                adDetail.messageDetails!.ctaUrl = absLinkUrl;
                            }
                        }
                    }
                });
            });
            
            // Fallback for message CTA if not found via rel="noopener"
            if (!adDetail.messageDetails!.ctaText && adDetail.messageDetails!.links!.length > 0) {
                // Use the first link as the primary CTA
                const firstLink = adDetail.messageDetails!.links![0];
                adDetail.messageDetails!.ctaText = firstLink.text;
                adDetail.messageDetails!.ctaUrl = firstLink.url;
            }
            
            // Extract Button CTA text (e.g., "Schedule 15-min call")
            const messageButtonCtaEl = messagePreviewBase.find('button.btn-sm.btn-secondary-emphasis.tooltip__trigger');
            if (messageButtonCtaEl.length > 0) {
                const buttonText = messageButtonCtaEl.text().trim();
                if (buttonText) {
                    adDetail.messageDetails.buttonCtaText = buttonText;
                    log.debug(`Detail Scraper: Message Ad Button CTA text: "${buttonText}" for Ad ID: ${adDetail.adId}`);
                }
            }
            // Main CTA button text ("Learn More") is handled by generic CTA extraction before switch.
            // adDetail.clickUrl for this button is not directly in the snippet.
            break;
        }
        default: {
            adDetail.adType = 'UNKNOWN'; // Default if no specific elements found
            log.warning(`Detail Scraper: Ad content for Ad ID: ${adDetail.adId} did not match any known type explicitly. Type set to UNKNOWN.`);
        }
    }

    // Fallback for image URL if not set by specific ad type logic and not a text ad
    if (!adDetail.imageUrl && adDetail.adType !== 'TEXT' && adDetail.adType !== 'MESSAGE') { // EVENT adType imageUrl is handled within its case
        const generalImageElements = $('.ad-preview-image img, .ad-image__image img, .feed-shared-article__image img, .feed-shared-event__image img, .profile-photo-edit__preview, .ivm-view-attr__img--centered img');
        let foundFallbackImage = false;
        generalImageElements.each((_, el) => {
            const imgElement = $(el);
            // Prioritize src, then data-delayed-url, etc. for fallback
            const imgSrcAttr = imgElement.attr('src') || imgElement.attr('data-delayed-url') || imgElement.attr('data-ghost-url');
            if (imgSrcAttr) {
                if (!isPotentialPlaceholder(imgElement, imgSrcAttr, adDetail.adDetailUrl)) {
                    adDetail.imageUrl = ensureAbsoluteUrl(imgSrcAttr, adDetail.adDetailUrl);
                    log.debug(`Detail Scraper: Fallback Image URL set to non-placeholder: ${adDetail.imageUrl} for Ad ID: ${adDetail.adId}`);
                    // Add to general imageUrls list if not already there
                     if (adDetail.imageUrl && (!adDetail.imageUrls || !adDetail.imageUrls.includes(adDetail.imageUrl))) {
                        if (!adDetail.imageUrls) adDetail.imageUrls = [];
                        adDetail.imageUrls.push(adDetail.imageUrl);
                     }
                    foundFallbackImage = true;
                    return false; // Break loop, found a non-placeholder
                } else {
                    log.debug(`Detail Scraper: Fallback image candidate was a placeholder. src: ${imgSrcAttr} for Ad ID: ${adDetail.adId}`);
                }
            }
            return true; // Continue loop
        });
        if (!foundFallbackImage) {
            log.debug(`Detail Scraper: Fallback Image URL could not be set (all candidates were placeholders or no images found) for Ad ID: ${adDetail.adId}`);
            // if adDetail.imageUrl was somehow set to a placeholder by a path not covered, this is a spot to ensure it's undefined.
            // However, the logic aims to prevent setting it to placeholder in the first place.
            // If adDetail.imageUrls is now potentially just placeholders, ensure it's cleaned or undefined
            if (adDetail.imageUrls && adDetail.imageUrls.every(url => isPotentialPlaceholder($(`img[src="${url}"]`),url,adDetail.adDetailUrl))) { // This check is a bit complex here
                 // Simpler: if no primary imageUrl found, and list is empty or all placeholders, ensure list is undefined if empty.
                 if (adDetail.imageUrls && adDetail.imageUrls.length === 0) adDetail.imageUrls = undefined;
            }
        }
    }

    if (adDetail.eventUrl && adDetail.adType === 'EVENT' && adDetail.eventDetails?.url) {
        adDetail.eventUrl = adDetail.eventDetails.url;
        log.debug(`Detail Scraper: Final Destination URL: ${adDetail.eventUrl} for Ad ID: ${adDetail.adId}`);
    } else if (!adDetail.eventUrl && adDetail.adType === 'EVENT' && adDetail.eventDetails?.url) {
        // Ensure event URL is used if no other destination found
        adDetail.eventUrl = adDetail.eventDetails.url;
        log.debug(`Detail Scraper: Using event URL as destination for EVENT Ad ID: ${adDetail.adId}: ${adDetail.eventUrl}`);
    }

    log.info(`Detail Scraper: Successfully extracted content for Ad ID: ${adDetail.adId}, Type: ${adDetail.adType}`);
}

/**
 * Extracts ad availability dates
 */
function extractAvailabilityDates($: CheerioAPI, adDetail: AdDetail): void {
    const datesText = $('.about-ad__availability-duration').text().trim();
    
    // Parse "Ran from Aug 7, 2024 to Sep 17, 2024" format
    const match = datesText.match(/Ran from ([^to]+) to ([^$]+)/i);
    if (match) {
        adDetail.availability = {
            start: match[1].trim(),
            end: match[2].trim()
        };
    }
}

/**
 * Extracts impression data
 */
function extractImpressionData($: CheerioAPI, adDetail: AdDetail): void {
    // Total impressions - try multiple selectors to be more robust
    let totalImpressionsEl = $('.flex.justify-between p.text-sm.leading-\\[18px\\].text-color-text.font-semibold:last-child');
    
    if (totalImpressionsEl.length === 0) {
        // Try alternative selector 
        totalImpressionsEl = $('h2:contains("Ad Impressions")').parent().parent().find('.flex.justify-between p:last-child');
    }
    
    if (totalImpressionsEl.length === 0) {
        // One more fallback
        totalImpressionsEl = $('div.mb-\\[6px\\].w-full div.flex.justify-between p:last-child');
    }
    
    if (totalImpressionsEl.length > 0) {
        const totalImpressionsText = totalImpressionsEl.text().trim();
        adDetail.totalImpressionsRaw = totalImpressionsText;
        adDetail.totalImpressions = parseImpressionRange(totalImpressionsText);
    } else {
        // Log if we still couldn't find the total impressions
        log.warning(`Could not find total impressions for ad: ${adDetail.adId}`);
    }
    
    // Impressions by country
    const impressionsByCountry: CountryImpression[] = [];
    
    // Process each country item - update selectors to match current HTML structure
    $('.ad-analytics__country-impressions').each((_, el) => {
        const country = $(el).find('div.w-\\[75\\%\\] p.text-sm.leading-\\[18px\\].font-semibold.text-color-text').text().trim();
        const percentageText = $(el).find('div.w-\\[25\\%\\] p.text-right.text-xs.leading-\\[16px\\].font-semibold').text().trim();
        
        if (country && percentageText) {
            const percentageValue = parsePercentage(percentageText);
            const countryImpression: CountryImpression = {
                country,
                percentage: percentageText,
                percentageValue,
                raw: percentageText
            };
            
            // Calculate actual impressions if total impressions are available
            if (adDetail.totalImpressions) {
                const { min, max } = adDetail.totalImpressions;
                
                if (min !== undefined) {
                    countryImpression.impressionsMin = Math.round(min * percentageValue);
                }
                
                if (max !== undefined) {
                    countryImpression.impressionsMax = Math.round(max * percentageValue);
                }
            }
            
            impressionsByCountry.push(countryImpression);
        }
    });
    
    if (impressionsByCountry.length > 0) {
        adDetail.impressionsPerCountry = impressionsByCountry;
    } else {
        log.warning(`Could not find country impressions for ad: ${adDetail.adId}`);
    }
}

/**
 * Extracts targeting information
 */
function extractTargetingInfo($: CheerioAPI, adDetail: AdDetail): void {
    adDetail.targeting = {
        language: [],
        locationIncluded: [],
        locationExcluded: [],
    };
    
    // Language targeting
    const languageSection = $('.ad-detail-right-rail h3:contains("Language") + p');
    if (languageSection.length > 0) {
        const languageText = languageSection.text().trim();
        const languageMatch = languageText.match(/Targeting includes ([^$]+)/);
        if (languageMatch) {
            adDetail.targeting.language = [languageMatch[1].trim()];
        }
    }
    
    // Location targeting
    const locationSection = $('.ad-detail-right-rail h3:contains("Location") + p');
    if (locationSection.length > 0) {
        const includedText = locationSection.find('.ad-targeting__segments:contains("Targeting includes")').text();
        if (includedText) {
            const locationsStr = includedText.replace('Targeting includes', '').trim();
            // Handle the case with "X others" - try to get the hidden list
            const othersMatch = locationsStr.match(/and\s+(\d+)\s+others/i);
            if (othersMatch) {
                const baseLocations = locationsStr.split(/\s+and\s+\d+\s+others/i)[0].split(/,\s+/).map(l => l.trim());
                
                // Try to get the hidden locations
                const hiddenLocations = locationSection.find('.ad-targeting__other-segments').text().split(',').map(l => l.trim());
                
                adDetail.targeting.locationIncluded = [...baseLocations, ...hiddenLocations].filter(Boolean);
            } else {
                adDetail.targeting.locationIncluded = locationsStr.split(/,\s+and\s+|,\s+/).map(l => l.trim()).filter(Boolean);
            }
        }
        
        const excludedText = locationSection.find('.ad-targeting__segments:contains("Targeting excludes")').text();
        if (excludedText) {
            const locationsStr = excludedText.replace('Targeting excludes', '').trim();
            adDetail.targeting.locationExcluded = locationsStr.split(/,\s+and\s+|,\s+/).map(l => l.trim()).filter(Boolean);
        }
    }
    
    // Audience targeting
    const audienceSection = $('.ad-detail-right-rail h3:contains("Audience") + p');
    if (audienceSection.length > 0) {
        adDetail.targeting.audienceTargeting = audienceSection.text().trim();
    }
    
    // Job targeting
    const jobSection = $('.ad-detail-right-rail h3:contains("Job") + p');
    if (jobSection.length > 0) {
        adDetail.targeting.jobTargeting = jobSection.text().trim();
    }
    
    // Company targeting
    const companySection = $('.ad-detail-right-rail h3:contains("Company") + p');
    if (companySection.length > 0) {
        adDetail.targeting.companyTargeting = companySection.text().trim();
    }

    try {
        const locationText = findDdContent($, 'Location') || '';
        if (locationText) {
            if (adDetail.targeting) { // Ensure targeting object exists
                adDetail.targeting.locationIncluded.push(locationText);
            }
        }

        const languageText = findDdContent($, 'Language') || '';
        if (languageText) {
            if (adDetail.targeting) { // Ensure targeting object exists
                adDetail.targeting.language.push(languageText);
            }
        }
    } catch (e: any) {
        log.error(`Detail Scraper: Error extracting targeting info for Ad ID ${adDetail.adId}: ${e.message}`, { error: e });
    }
}

// Helper function to find text content of a dt/dd pair, looking for specific dt text
function findDdContent($: CheerioAPI, dtText: string): string | null {
    const dtElement = $(`dt:contains("${dtText}")`);
    if (dtElement.length > 0) {
        return dtElement.next('dd').text().trim() || null;
    }
    return null;
}