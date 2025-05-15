/**
 * Ad detail scraper for LinkedIn Ads Library
 */
import { CheerioAPI, load, Cheerio, Element } from 'cheerio';
import { log } from 'crawlee';
import { AdDetail, CountryImpression, CarouselItem } from './types.js';
import { extractProfileId, parseImpressionRange, parsePercentage, generateContentFingerprint, cleanLinkedInUrl } from './utils.js';

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
                break;
            }
        }
        
        if (!advertiserFound) {
            log.warning(`Detail Scraper: Could not find advertiser info for Ad ID: ${adId}`);
            
            // Try to get it from the logo
            const advertiserLogo = $('a[data-tracking-control-name="ad_library_ad_preview_advertiser_image"] img');
            if (advertiserLogo.length > 0) {
                const logoAlt = advertiserLogo.attr('alt');
                if (logoAlt && logoAlt.includes('logo')) {
                    adDetail.advertiserName = logoAlt.replace(' logo', '').trim();
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
            const promoterHeadline = $('p.text-xs.text-color-text-secondary:not(:contains("Promoted"))').first().text().trim();
            
            // Simple, targeted approach for promoter image
            const promoterImageEl = $('img.inline-block.relative.w-6.h-6, img[alt="member logo"]');
            
            // Debug the image element to understand what we're finding
            if (promoterImageEl.length > 0) {
                // Get all attributes of the element for debugging
                const attrs: Record<string, string> = {};
                const el = promoterImageEl[0];
                
                if (el.attribs) {
                    Object.keys(el.attribs).forEach(key => {
                        attrs[key] = el.attribs[key];
                    });
                }
                
                log.debug(`Found promoter image for Ad ID: ${adId}`, attrs);
            } else {
                log.debug(`No promoter image found for Ad ID: ${adId}`);
            }
            
            // Try different attributes that might contain the image URL
            let promoterImageUrl = '';
            if (promoterImageEl.length > 0) {
                // LinkedIn consistently uses data-delayed-url for the real image
                promoterImageUrl = promoterImageEl.attr('data-delayed-url') || '';
                
                log.debug(`Extracted promoter image URL: "${promoterImageUrl}"`);
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

        if (videoElement.length > 0) {
            adDetail.adType = 'VIDEO';
            adDetail.videoUrl = videoElement.attr('src') || '';
        } else if (carouselElement.length > 0 || carouselClass.length > 0) {
            adDetail.adType = 'CAROUSEL';
            adDetail.imageUrls = [];
            adDetail.carouselItems = extractCarouselItems($);
            
            // Also collect image URLs separately for backward compatibility
            $('img.ad-preview__dynamic-dimensions-image').each((_, img) => {
                const imgUrl = $(img).attr('src');
                if (imgUrl && !imgUrl.includes('ghost-url')) adDetail.imageUrls?.push(imgUrl);
            });
        } else if (documentElement.length > 0) {
            adDetail.adType = 'DOCUMENT';
            adDetail.documentUrl = documentElement.attr('src') || '';
        } else if (eventElement.length > 0) {
            adDetail.adType = 'EVENT';
            adDetail.eventName = eventElement.find('h3').text().trim();
            adDetail.eventUrl = eventElement.find('a').attr('href') || '';
        } else if (messageAdCreativeType.length > 0 || messageAdClass.length > 0 || messageAdContent.length > 0 || aboutAdMessageLabel.length > 0) {
            adDetail.adType = 'MESSAGE';
            log.debug(`Detail Scraper: Identified message ad for Ad ID: ${adId}`);
            
            // Extract message details
            const messageDetails: AdDetail['messageDetails'] = {
                senderName: '',
                messageContent: ''
            };
            
            // Extract sender name
            const senderNameEl = $('.font-semibold.leading-\\[20px\\].text-md.text-color-text').first();
            if (senderNameEl.length > 0) {
                messageDetails.senderName = senderNameEl.text().trim();
            }
            
            // Extract message content
            if (messageAdContent.length > 0) {
                messageDetails.messageContent = messageAdContent.text().trim();
                
                // Also set adCopy for backward compatibility
                adDetail.adCopy = messageDetails.messageContent;
            }
            
            // Extract CTA button
            const ctaButton = $('.btn-sm.btn-secondary-emphasis');
            if (ctaButton.length > 0) {
                messageDetails.ctaText = ctaButton.text().trim();
                
                // Try to find the tooltip that might contain URL info
                const tooltipText = $('.tooltip__popup').text().trim();
                if (tooltipText.includes('external landing page')) {
                    // We don't have the exact URL in the preview, but note that it has one
                    messageDetails.ctaUrl = '[External landing page]';
                }
            }
            
            // Extract links from the message
            const links: { text: string, url: string }[] = [];
            messageAdContent.find('a').each((_, el) => {
                const linkEl = $(el);
                const text = linkEl.text().trim();
                const url = linkEl.attr('href') || '';
                
                if (text && url) {
                    links.push({ text, url });
                }
            });
            
            if (links.length > 0) {
                messageDetails.links = links;
            }
            
            adDetail.messageDetails = messageDetails;
        } else if (singleImageCreativeType.length > 0 || aboutAdSingleImageLabel.length > 0 || 
                  (singleImageContent.length > 0 && sponsoredContentHeadline.length > 0)) {
            adDetail.adType = 'SINGLE_IMAGE';
            log.debug(`Detail Scraper: Identified single image ad for Ad ID: ${adId}`);
            
            // Extract image URL
            const imageUrl = singleImageContent.attr('src');
            if (imageUrl) {
                adDetail.imageUrl = imageUrl;
            }
        } else if (textAdCreativeType.length > 0 || textAdClass.length > 0 || textAdContainer.length > 0) {
            adDetail.adType = 'TEXT';
            log.debug(`Detail Scraper: Identified text ad for Ad ID: ${adId}`);
        } else if (imageElement.length > 0) {
            adDetail.adType = 'SINGLE_IMAGE';
            adDetail.imageUrl = imageElement.first().attr('src') || '';
        } else if (textOnlyElement.length > 0 && !imageElement.length && !videoElement.length) {
            adDetail.adType = 'TEXT';
        } else {
            adDetail.adType = 'UNKNOWN';
            log.warning(`Detail Scraper: Could not determine ad type for Ad ID: ${adId}`);
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
 * Extracts carousel items with their titles, images and links
 */
function extractCarouselItems($: CheerioAPI): CarouselItem[] {
    const items: CarouselItem[] = [];
    
    // Try different selectors for carousel items based on LinkedIn's varying HTML structures
    const carouselItemSelectors = [
        '.slide-list__list > div', // Modern carousel structure
        '.ad-carousel-item', // Legacy carousel structure
    ];
    
    let carouselElements;
    
    // Find which selector works
    for (const selector of carouselItemSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            carouselElements = elements;
            break;
        }
    }
    
    if (!carouselElements || carouselElements.length === 0) {
        return items;
    }
    
    carouselElements.each((i, el) => {
        const item: CarouselItem = {
            position: i + 1
        };
        
        // Try to get image
        const img = $(el).find('img.ad-preview__dynamic-dimensions-image');
        if (img.length > 0) {
            item.imageUrl = img.attr('src') || undefined;
            item.imageAlt = img.attr('alt') || undefined;
        }
        
        // Try to get title
        const title = $(el).find('.text-xs.font-semibold');
        if (title.length > 0) {
            item.title = title.text().trim();
        }
        
        // Try to get link and clean it
        const link = $(el).find('a[data-tracking-control-name="ad_library_ad_preview_carousel_item_image"], a[data-tracking-control-name="ad_library_ad_preview_carousel_item_title"]').first();
        if (link.length > 0) {
            const rawUrl = link.attr('href') || undefined;
            if (rawUrl) {
                // Clean the URL to remove tracking parameters
                item.linkUrl = cleanLinkedInUrl(rawUrl);
            }
        }
        
        if (item.imageUrl || item.title || item.linkUrl) {
            items.push(item);
        }
    });
    
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
    // Extract ad copy (main text)
    const adCopyEl = $('.commentary__content');
    
    // Get all links first and replace them with their text content in the DOM
    // This ensures we don't lose link text when extracting the content
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
    
    // Check if there's a "see more" button and the full text is truncated
    const seeMoreButton = $('.commentary__truncation-button:contains("see more")');
    if (seeMoreButton.length > 0) {
        // Get the full text with links preserved
        adCopy = preserveLinksAndGetText(adCopyEl);
        
        // If the above approach doesn't work well, try a more aggressive approach
        if (!adCopy || adCopy.length < 20) {
            // This is a fallback - we'll try to keep link text by replacing links with their text content
            const html = adCopyEl.html() || '';
            adCopy = html
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')  // Replace <a href="...">Link Text</a> with just "Link Text"
                .replace(/<[^>]*>/g, '')
                .trim();
        }
    } else {
        // If there's no "see more" button, we can use our link-preserving function
        adCopy = preserveLinksAndGetText(adCopyEl);
    }
    
    adDetail.adCopy = adCopy;
    
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
        const mainImageUrl = mainImage.attr('src');
        if (mainImageUrl) imageUrls.push(mainImageUrl);
    }
    
    // Add all images
    $('.ad-preview img').each((_, el) => {
        const src = $(el).attr('src');
        if (src && !imageUrls.includes(src) && !src.includes('ghost-url')) {
            imageUrls.push(src);
        }
    });
    
    if (imageUrls.length > 0) {
        adDetail.imageUrls = imageUrls;
    }
    
    // Extract video URL if present
    const videoElement = $('.share-native-video video');
    if (videoElement.length > 0) {
        const videoUrl = videoElement.attr('src');
        if (videoUrl) {
            adDetail.videoUrl = videoUrl;
        } else {
            // Sometimes the URL is in a data attribute
            const videoSources = videoElement.attr('data-sources');
            if (videoSources) {
                try {
                    const sources = JSON.parse(videoSources);
                    if (Array.isArray(sources) && sources.length > 0) {
                        // Use the highest quality source
                        const highestQualitySource = sources.reduce((prev, current) => {
                            return (current.bitrate > prev.bitrate) ? current : prev;
                        });
                        adDetail.videoUrl = highestQualitySource.src;
                    }
                } catch (e) {
                    log.debug('Error parsing video sources', { error: (e as Error).message });
                }
            }
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
        }
    }
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
}