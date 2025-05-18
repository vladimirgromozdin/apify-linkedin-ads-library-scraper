/**
 * Ad detail scraper for LinkedIn Ads Library
 */
import { CheerioAPI, load, Cheerio, Element as CheerioElement } from 'cheerio';
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
                        adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoImg.attr('src') || '', url);
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
                    adDetail.advertiserLogoUrl = ensureAbsoluteUrl(advertiserLogo.attr('src') || '', url);
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
            // Use common ancestor of promoterLink and promoter image link for scoping
            const commonParentForPromoter = promoterLink.closest('.flex.items-center.px-1\.5.gap-1');
            const promoterImageAnchor = commonParentForPromoter.find('a[data-tracking-control-name="ad_library_ad_preview_member_image"]');

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
                    log.debug(`No img[alt="member logo"] tag found within promoterImageAnchor for Ad ID: ${adId}`);
                }
            } else {
                log.debug(`No promoter image anchor (a[data-tracking-control-name="ad_library_ad_preview_member_image"]) found relative to promoterLink for Ad ID: ${adId}.`);
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

        // --- Ad Type Detection based on data-creative-type ---
        const creativeType = $('.ad-preview').attr('data-creative-type');
        log.debug(`Detail Scraper: Detected data-creative-type: ${creativeType} for Ad ID: ${adId}`);

        if (creativeType === 'FOLLOW_COMPANY_V2' || aboutAdFollowCompanyLabel.length > 0) {
            adDetail.adType = 'FOLLOW_COMPANY';
        } else if (creativeType === 'SPOTLIGHT_V2' || aboutAdSpotlightLabel.length > 0) { // ADDED: Spotlight Ad detection
            adDetail.adType = 'SPOTLIGHT';
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
        } else if (creativeType === 'TEXT_AD' || textAdClass.length > 0 || textAdContainer.length > 0) {
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
                 log.warning(`Detail Scraper: Could not determine ad type for Ad ID: ${adId} after all checks.`);
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

    const preserveLinksAndGetText = (element: Cheerio<Element>): string => {
        // Create a clone to work with
        const clone = element.clone();
        
        // Replace all links with their text content
        clone.find('a').each((_, el: Element) => {
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
    const mainImage = $('.ad-preview img.ad-preview__dynamic-dimensions-image');
    if (mainImage.length > 0) {
        // Prioritize src attribute for the main image
        let mainImageUrl = mainImage.attr('src');
        
        // Only use alternatives if src is completely missing
        if (!mainImageUrl) {
            // Try other attributes first
            mainImageUrl = mainImage.attr('data-delayed-url') || 
                           mainImage.attr('data-src');
                           
            // Use ghost-url as last resort
            if (!mainImageUrl) {
                mainImageUrl = mainImage.attr('data-ghost-url');
            }
        }
        
        if (mainImageUrl) {
            // Convert to absolute URL
            mainImageUrl = ensureAbsoluteUrl(mainImageUrl, adDetail.adDetailUrl);
            imageUrls.push(mainImageUrl);
            
            // If we didn't find imageUrl before, set it now
            if (!adDetail.imageUrl) {
                adDetail.imageUrl = mainImageUrl;
                log.debug(`extractAdContent: Set imageUrl from main image for Ad ID: ${adDetail.adId}`);
            }
        }
    }
    
    // Add all images
    $('.ad-preview img').each((_, el) => {
        // First try src attribute
        const src = $(el).attr('src');
        if (src && !imageUrls.includes(src)) {
            const absoluteUrl = ensureAbsoluteUrl(src, adDetail.adDetailUrl);
            imageUrls.push(absoluteUrl);
        } else {
            // If src attribute not available, try others in priority order
            const altSrc = $(el).attr('data-delayed-url') || 
                          $(el).attr('data-src') || 
                          $(el).attr('data-ghost-url');
                          
            if (altSrc && !imageUrls.includes(altSrc)) {
                const absoluteUrl = ensureAbsoluteUrl(altSrc, adDetail.adDetailUrl);
                imageUrls.push(absoluteUrl);
            }
        }
        
        // Check for srcset attribute (responsive images)
        const srcset = $(el).attr('srcset');
        if (srcset) {
            // Extract highest resolution image from srcset
            const srcsetParts = srcset.split(',');
            for (const part of srcsetParts) {
                const [url] = part.trim().split(' ');
                if (url && !imageUrls.includes(url)) {
                    const absoluteUrl = ensureAbsoluteUrl(url, adDetail.adDetailUrl);
                    imageUrls.push(absoluteUrl);
                    break; // Just take the first one for simplicity
                }
            }
        }
    });
    
    if (imageUrls.length > 0) {
        adDetail.imageUrls = imageUrls;
        
        // If we still don't have a main imageUrl but we found images, use the first one
        if (!adDetail.imageUrl && imageUrls.length > 0) {
            adDetail.imageUrl = imageUrls[0];
            log.debug(`extractAdContent: Set imageUrl from imageUrls for Ad ID: ${adDetail.adId}`);
        }
    }
    
    // Extract video URL if present
    const videoContainer = $('.share-native-video');
    if (videoContainer.length > 0) {
        let extractedVideoUrl: string | undefined;
        const videoSourcesAttr = videoContainer.attr('data-sources');

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

        if (extractedVideoUrl) {
            adDetail.videoUrl = ensureAbsoluteUrl(extractedVideoUrl, adDetail.adDetailUrl);
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

        if (videoElement.length > 0) {
            adDetail.adType = 'VIDEO';
        } else if (carouselElement.length > 0) {
            adDetail.adType = 'CAROUSEL';
        } else if (documentElement.length > 0) {
            adDetail.adType = 'DOCUMENT';
        } else if ($('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"]').length > 0) { // Check specifically for event ad structure
            adDetail.adType = 'EVENT';
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
            const spotlightAdPreview = $('.ad-preview[data-creative-type="SPOTLIGHT_V2"]');

            if (spotlightAdPreview.length > 0) {
                const contentContainer = spotlightAdPreview.find('.container-lined'); // Matches FOLLOW_COMPANY structure

                if (contentContainer.length > 0) {
                    // Ad Description
                    const descriptionEl = contentContainer.find('p.text-xs.leading-\[16px\].text-color-text-low-emphasis');
                    if (descriptionEl.length > 0) {
                        adDetail.adCopy = descriptionEl.text().trim();
                        log.debug(`Detail Scraper: SPOTLIGHT - AdCopy: "${adDetail.adCopy}" for Ad ID: ${adDetail.adId}`);
                    } else {
                        log.debug(`Detail Scraper: SPOTLIGHT - Description element not found for Ad ID: ${adDetail.adId}`);
                    }

                    // Advertiser Logo URL
                    // General advertiser extraction (lines 82-127) should handle this.
                    // This is a fallback / double check specifically within the spotlight container.
                    if (!adDetail.advertiserLogoUrl) {
                        const logoImgEl = contentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
                        if (logoImgEl.length > 0) {
                            const logoSrc = logoImgEl.attr('src');
                            if (logoSrc) {
                                adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrc, adDetail.adDetailUrl);
                                log.debug(`Detail Scraper: SPOTLIGHT - Fallback advertiserLogoUrl extracted: ${adDetail.advertiserLogoUrl} for Ad ID: ${adDetail.adId}`);
                            }
                        }
                    }
                     // Advertiser Name and Profile URL are expected to be picked up by general logic or "About the ad" section.

                    // Ad Headline
                    const headlineElSpotlight = contentContainer.find('h2.text-sm.text-color-text.leading-\[18px\].font-semibold');
                    if (headlineElSpotlight.length > 0) {
                        adDetail.headline = headlineElSpotlight.text().trim();
                        log.debug(`Detail Scraper: SPOTLIGHT - Headline: "${adDetail.headline}" for Ad ID: ${adDetail.adId}`);
                    } else {
                        log.debug(`Detail Scraper: SPOTLIGHT - Headline element not found for Ad ID: ${adDetail.adId}`);
                    }

                    // CTA Button Link and Text
                    const ctaLinkEl = contentContainer.find('a.btn-sm.btn-secondary-emphasis[data-tracking-control-name="ad_library_ad_detail_cta"]');
                    if (ctaLinkEl.length > 0) {
                        adDetail.ctaText = ctaLinkEl.text().trim();
                        const href = ctaLinkEl.attr('href');
                        if (href) {
                            adDetail.clickUrl = ensureAbsoluteUrl(href, adDetail.adDetailUrl); // Using ensureAbsoluteUrl for consistency, though it might be an external link.
                        }
                        log.debug(`Detail Scraper: SPOTLIGHT - CTA: "${adDetail.ctaText}", URL: "${adDetail.clickUrl}" for Ad ID: ${adDetail.adId}`);
                    } else {
                        log.debug(`Detail Scraper: SPOTLIGHT - CTA link element not found for Ad ID: ${adDetail.adId}`);
                    }
                } else {
                     log.warning(`Detail Scraper: SPOTLIGHT - Content container (.container-lined) not found within .ad-preview[data-creative-type="SPOTLIGHT_V2"] for Ad ID: ${adDetail.adId}`);
                }
            } else {
                // Fallback if SPOTLIGHT_V2 data-creative-type is not present, but adType was set via "About the ad" label
                const genericContentContainer = $('.container-raised .container-lined'); // More generic path based on provided HTML
                if (genericContentContainer.length > 0 && adDetail.adType === 'SPOTLIGHT') {
                    log.debug(`Detail Scraper: SPOTLIGHT - Using generic content container for Ad ID: ${adDetail.adId} as SPOTLIGHT_V2 attribute not found on ad-preview.`);
                     // Ad Description
                    const descriptionEl = genericContentContainer.find('p.text-xs.leading-\[16px\].text-color-text-low-emphasis');
                    if (descriptionEl.length > 0) {
                        adDetail.adCopy = descriptionEl.text().trim();
                    }
                     // Advertiser Logo URL (rely on general extraction)

                    // Ad Headline
                    const headlineElSpotlight = genericContentContainer.find('h2.text-sm.text-color-text.leading-\[18px\].font-semibold');
                    if (headlineElSpotlight.length > 0) {
                        adDetail.headline = headlineElSpotlight.text().trim();
                    }
                    // CTA Button Link and Text
                    const ctaLinkEl = genericContentContainer.find('a.btn-sm.btn-secondary-emphasis[data-tracking-control-name="ad_library_ad_detail_cta"]');
                    if (ctaLinkEl.length > 0) {
                        adDetail.ctaText = ctaLinkEl.text().trim();
                        const href = ctaLinkEl.attr('href');
                        if (href) {
                            adDetail.clickUrl = ensureAbsoluteUrl(href, adDetail.adDetailUrl);
                        }
                    }
                } else if (adDetail.adType === 'SPOTLIGHT') {
                     log.warning(`Detail Scraper: SPOTLIGHT - Ad preview element (.ad-preview[data-creative-type="SPOTLIGHT_V2"]) and generic content not found for Ad ID: ${adDetail.adId}`);
                }
            }
            break;
        }
        case 'FOLLOW_COMPANY': {
            log.debug(`Detail Scraper: Extracting FOLLOW_COMPANY specific content for Ad ID: ${adDetail.adId}`);
            // Scope to the specific ad preview container for FOLLOW_COMPANY_V2
            const followCompanyAdPreview = $('.ad-preview[data-creative-type="FOLLOW_COMPANY_V2"]');

            if (followCompanyAdPreview.length > 0) {
                const contentContainer = followCompanyAdPreview.find('.container-lined');

                if (contentContainer.length > 0) {
                    // Description (top paragraph)
                    const descriptionEl = contentContainer.find('p.text-xs.leading-\[16px\].text-color-text-low-emphasis').first();
                    if (descriptionEl.length > 0) {
                        adDetail.adCopy = descriptionEl.text().trim();
                        log.debug(`Detail Scraper: FOLLOW_COMPANY - AdCopy: "${adDetail.adCopy}" for Ad ID: ${adDetail.adId}`);
                    } else {
                        log.debug(`Detail Scraper: FOLLOW_COMPANY - Description element not found for Ad ID: ${adDetail.adId}`);
                    }

                    // Headline (h2 element)
                    const headlineElFollow = contentContainer.find('h2.text-sm.text-color-text.leading-\[18px\].font-semibold');
                    if (headlineElFollow.length > 0) {
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
                    // The general advertiser extraction (lines 82-127) should handle this.
                    // This is a fallback / double check.
                    if (!adDetail.advertiserLogoUrl) {
                        // The logo within FOLLOW_COMPANY_V2 is inside the .container-lined, then .flex.gap-x-2, then the 'a' tag
                        const logoImgEl = contentContainer.find('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
                        if (logoImgEl.length > 0) {
                            const logoSrc = logoImgEl.attr('src');
                            if (logoSrc) {
                                adDetail.advertiserLogoUrl = ensureAbsoluteUrl(logoSrc, adDetail.adDetailUrl);
                                log.debug(`Detail Scraper: FOLLOW_COMPANY - Fallback advertiserLogoUrl extracted: ${adDetail.advertiserLogoUrl} for Ad ID: ${adDetail.adId}`);
                            }
                        }
                    }
                     // The advertiser name and profile URL are expected to be picked by the generic section
                     // using selectors like 'a[data-tracking-control-name="ad_library_about_ad_advertiser"]'
                     // from the "About the ad" section, or from the alt text of the logo.

                } else {
                     log.warning(`Detail Scraper: FOLLOW_COMPANY - Content container (.container-lined) not found within .ad-preview[data-creative-type="FOLLOW_COMPANY_V2"] for Ad ID: ${adDetail.adId}`);
                }
            } else {
                log.warning(`Detail Scraper: FOLLOW_COMPANY - Ad preview element (.ad-preview[data-creative-type="FOLLOW_COMPANY_V2"]) not found for Ad ID: ${adDetail.adId}`);
            }
            break;
        }
        case 'DOCUMENT': {
            // Document URL is already extracted in extractAdContent
            break;
        }
        case 'EVENT': {
            log.debug(`Detail Scraper: Extracting EVENT specific content for Ad ID: ${adDetail.adId}`);
            // Ad Copy is handled by the updated generic selector: 'p.commentary__content'

            // Image URL
            const eventImageElement = $('.ad-preview[data-creative-type="SPONSORED_UPDATE_EVENT"] img.ad-preview__dynamic-dimensions-image');
            if (eventImageElement.length > 0) {
                adDetail.imageUrl = ensureAbsoluteUrl(eventImageElement.attr('src') || '', adDetail.adDetailUrl);
                log.debug(`Detail Scraper: Event Image URL: ${adDetail.imageUrl} for Ad ID: ${adDetail.adId}`);
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
                    // Populate promoterDetails as well
                    adDetail.promoterDetails = {
                        promoterName: senderName,
                        promoterProfileUrl: '', 
                        promoterProfileId: '',  
                        promoterImageUrl: senderImageUrl,
                        // promoterHeadline is not available directly here
                    };
                     // If this is a message ad with a specific sender, it's effectively 'THOUGHT_LEADERSHIP'
                    adDetail.promotionType = 'THOUGHT_LEADERSHIP';
                }
            }

            // Message Content
            const messageContentEl = messagePreviewBase.find('.sponsored-message__content');
            let extractedMessageContent = '';
            if (messageContentEl.length > 0) {
                const tempDiv = $('<div></div>').append(messageContentEl.clone().children());

                tempDiv.find('br').replaceWith('\n');
                tempDiv.find('li').each((_, li) => {
                    $(li).prepend('    * ').append('\n');
                });
                tempDiv.find('p').append('\n'); // Add newline after each paragraph

                // Consolidate text, then clean up for final assignment
                extractedMessageContent = tempDiv.text();
                // Replace multiple newlines (and those with only spaces) with a single newline
                extractedMessageContent = extractedMessageContent.replace(/(\n\s*)+/g, '\n').trim();


                adDetail.messageDetails.messageContent = extractedMessageContent;
                adDetail.adCopy = extractedMessageContent; // Also populate the main adCopy field

                // Extract links and the specific in-message CTA
                messageContentEl.find('a').each((_, el) => {
                    const linkText = $(el).text().trim();
                    const linkUrl = $(el).attr('href');
                    if (linkText && linkUrl) {
                        const absLinkUrl = ensureAbsoluteUrl(linkUrl, adDetail.adDetailUrl);
                        adDetail.messageDetails!.links!.push({ text: linkText, url: absLinkUrl });

                        if (!adDetail.messageDetails!.ctaText && $(el).attr('rel') === 'noopener') {
                            adDetail.messageDetails!.ctaText = linkText;
                            adDetail.messageDetails!.ctaUrl = absLinkUrl;
                        }
                    }
                });
                 // Fallback for message CTA if not found via rel="noopener" but user mentioned specific text
                if (!adDetail.messageDetails!.ctaText && adDetail.messageDetails!.links!.length > 0) {
                    const specificCtaFromUser = "Book a free consultation";
                    const userCta = adDetail.messageDetails!.links!.find(l => l.text === specificCtaFromUser);
                    if (userCta) {
                        adDetail.messageDetails!.ctaText = userCta.text;
                        adDetail.messageDetails!.ctaUrl = userCta.url;
                    }
                }
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
    if (!adDetail.imageUrl && adDetail.adType !== 'TEXT' && adDetail.adType !== 'MESSAGE' && adDetail.adType !== 'EVENT') { // Don't overwrite if EVENT already got it
        const generalImageElement = $('.ad-preview-image img, .ad-image__image img, .feed-shared-article__image img, .feed-shared-event__image img, .profile-photo-edit__preview, .ivm-view-attr__img--centered img');
        if (generalImageElement.length > 0) {
            adDetail.imageUrl = ensureAbsoluteUrl(generalImageElement.first().attr('src') || '', adDetail.adDetailUrl);
            log.debug(`Detail Scraper: Fallback Image URL: ${adDetail.imageUrl} for Ad ID: ${adDetail.adId}`);
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
function findDdContent($, dtText: string): string | null {
    const dtElement = $(`dt:contains("${dtText}")`);
    if (dtElement.length > 0) {
        return dtElement.next('dd').text().trim() || null;
    }
    return null;
}