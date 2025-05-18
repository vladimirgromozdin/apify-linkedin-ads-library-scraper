// Types for the LinkedIn Ads Library Scraper

/**
 * Input options for the actor
 */
export interface Input {
    accountOwner?: string;
    keyword?: string;
    maxUrlsCount?: number;
    requestDelay?: number;
    debugMode?: boolean;
    unlimitedMode?: boolean;
    scrapeAdDetails?: boolean; // Whether to scrape detailed ad info
    minDetailDelay?: number;   // Minimum delay between detail requests (ms)
    maxDetailDelay?: number;   // Maximum delay between detail requests (ms)
    maxDetailConcurrency?: number; // Maximum concurrent detail page requests // DEPRECATED - use maxCrawlerConcurrency
    maxCrawlerConcurrency?: number; // Maximum concurrent requests for the unified crawler
    localMode?: boolean; // Whether to use more conservative settings for local testing
}

/**
 * Metadata about the scraping process
 */
export interface ScrapeMetadata {
    totalAdsAvailable: number;
    adsCollected: number;
    detailsCollected: number;
    accountOwner: string;
    keyword?: string;
    timestamp: string;
    durationSeconds?: number; // Add duration in seconds
}

/**
 * Country impression data
 */
export interface CountryImpression {
    country: string;
    percentage: string;
    percentageValue: number;
    raw?: string;
    impressionsMin?: number;
    impressionsMax?: number;
}

/**
 * Carousel item in carousel ads
 */
export interface CarouselItem {
    position: number;
    title?: string;
    imageUrl?: string;
    imageAlt?: string;
    linkUrl?: string;
}

/**
 * Main ad detail object type
 */
export interface AdDetail {
    adId: string;
    adDetailUrl: string;
    capturedAt: string;
    htmlVersion: string;
    
    advertiserName: string;
    advertiserProfileUrl: string;
    advertiserProfileId: string;
    advertiserLogoUrl?: string;
    paidBy?: string;
    
    adType: string;
    promotionType: 'COMPANY' | 'THOUGHT_LEADERSHIP';
    promoterDetails?: {
        promoterName: string;
        promoterHeadline?: string;
        promoterProfileUrl: string;
        promoterProfileId: string;
        promoterImageUrl?: string;
    };
    
    adCopy?: string;
    headline?: string;
    ctaText?: string;
    imageUrls?: string[];
    videoUrl?: string;
    documentUrl?: string;
    documentTitle?: string;
    clickUrl?: string;
    eventName?: string;
    eventUrl?: string;
    imageUrl?: string;
    carouselItems?: CarouselItem[];
    
    // New field for event ad details
    eventDetails?: {
        name: string;
        time: string;
        location: string;
        url: string;
    };
    
    // New field for message ad details
    messageDetails?: {
        senderName: string;
        messageContent: string;
        ctaText?: string;
        ctaUrl?: string;
        buttonCtaText?: string;
        links?: {
            text: string;
            url: string;
        }[];
    };
    
    availability?: {
        start: string;
        end: string;
    };
    
    totalImpressionsRaw?: string;
    totalImpressions?: {
        min?: number;
        max?: number;
    };
    impressionsPerCountry?: CountryImpression[];
    
    targeting?: {
        language: string[];
        locationIncluded: string[];
        locationExcluded: string[];
        audienceTargeting?: string;
        jobTargeting?: string;
        companyTargeting?: string;
    };
    
    errorDuringScraping?: string;
}