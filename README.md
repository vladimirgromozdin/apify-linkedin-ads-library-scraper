# LinkedIn Ads Library Scraper

This Apify actor scrapes ads from the LinkedIn Ads Library for specified advertisers. It extracts both the list of ads and detailed information about each ad, including advertiser details, ad content, performance metrics, and targeting parameters.

## Features

- Scrape ads for any advertiser on LinkedIn's Ad Library
- Handle pagination automatically to get all available ads
- Extract detailed information for each ad:
  - Core ad identifiers and advertiser information
  - Ad type and promotion type (company vs. thought leadership)
  - Complete ad content (text, images, videos, documents)
  - Performance data (impression ranges, geographic distribution)
  - Targeting parameters (languages, locations, audiences)
  - Availability dates
- Parallel processing for efficient scraping
- Set limits on the number of ads to extract
- Optional keyword filtering

## Usage

### Input Parameters

The actor accepts the following input parameters:

- **accountOwner** - LinkedIn advertiser name or company to search for (e.g., 'seomonitor'). Either this or keyword must be provided.
- **keyword** - Keyword to search for ads. Either this or accountOwner must be provided.
- **maxUrlsCount** (optional) - Maximum number of ad URLs to extract (default: 500)
- **scrapeAdDetails** (optional) - Whether to scrape detailed information about ads (default: true)
- **minDetailDelay** (optional) - Minimum delay between detail page requests (ms, default: 3000)
- **maxDetailDelay** (optional) - Maximum delay between detail page requests (ms, default: 5000)
- **maxDetailConcurrency** (optional) - Maximum number of concurrent detail requests (default: 3)
- **requestDelay** (optional) - Delay between search result page requests (ms, default: 3000)
- **debugMode** (optional) - Enable detailed debug logging (default: true)
- **unlimitedMode** (optional) - Disable URL count limit (default: false)
- **localMode** (optional) - Enable local mode for testing (default: false)

### Example Input with Company Name

```json
{
  "accountOwner": "seomonitor",
  "maxUrlsCount": 50,
  "scrapeAdDetails": true,
  "minDetailDelay": 3000,
  "maxDetailDelay": 5000,
  "localMode": true
}
```

### Example Input with Keyword

```json
{
  "keyword": "SEO software",
  "maxUrlsCount": 50,
  "scrapeAdDetails": true,
  "minDetailDelay": 3000,
  "maxDetailDelay": 5000,
  "localMode": true
}
```

### Example Input with Both Parameters

```json
{
  "accountOwner": "seomonitor",
  "keyword": "SEO",
  "maxUrlsCount": 50,
  "scrapeAdDetails": true,
  "minDetailDelay": 3000,
  "maxDetailDelay": 5000,
  "localMode": true
}
```

### Output

The actor saves results to the default dataset in three forms:

1. **ad_urls** - A simple array of ad detail URLs
2. **ad_details** - Complete ad details with all extracted information
3. **scrape_metadata** - Information about the scraping run

#### Ad Detail Structure

Each ad is stored as a separate object with the following structure:

```json
{
  "adId": "598709994",
  "adDetailUrl": "https://www.linkedin.com/ad-library/detail/598709994",
  "capturedAt": "2024-04-26T12:34:56.789Z",
  
  "advertiserName": "SEOmonitor",
  "advertiserProfileUrl": "https://www.linkedin.com/company/6387193",
  "advertiserProfileId": "6387193",
  "advertiserLogoUrl": "https://media.licdn.com/dms/image/v2/C4E0BAQHKiAy7t6jDRg/company-logo_100_100/company-logo_100_100/0/1634481235326/seomonitor_application_logo?e=1751500800&v=beta&t=tP0vy9ONWGCG-8K6jJYQBVGqrUeX7AhhgPSBnVKkrf0",
  "paidBy": "SC SEOmonitor Software SRL",
  
  "adType": "SINGLE_IMAGE",
  "promotionType": "COMPANY",
  
  "adCopy": "Drowning in disconnected SEO tools while finding it hard to prove ROI for your SEO programs? You're not alone.",
  "headline": "See how enterprise teams are cutting costs while scaling performance. Let's talk!",
  "imageUrls": ["https://media.licdn.com/dms/image/v2/D4E10AQEdiPQ4gjGZNA/image-shrink_1280/B4EZVmutl2HgAQ-/0/1741185277492/never-worry?e=2147483647&v=beta&t=K_9pcPlZA2GLbc7xyjiqOdd9Kuc70wviT-ZjCFY8knA"],
  "ctaText": "Learn more",
  "clickUrl": "http://seomonitor.com?utm_campaign=NAM_In-House-Content_Website-Visits_Single-Images_Intelligent-Platform_Demand-Generation&utm_source=linkedin&utm_medium=paid",
  
  "availability": {
    "start": "Aug 7, 2024",
    "end": "Sep 17, 2024"
  },
  
  "totalImpressionsRaw": "10k-50k",
  "totalImpressions": {
    "min": 10000,
    "max": 50000
  },
  
  "impressionsPerCountry": [
    {
      "country": "United Kingdom",
      "percentage": "26%",
      "percentageValue": 0.26
    },
    {
      "country": "United States",
      "percentage": "16%",
      "percentageValue": 0.16
    }
    // ... more countries
  ],
  
  "targeting": {
    "language": ["English"],
    "locationIncluded": ["Slovakia", "Lithuania", "Italy", "United States"],
    "locationExcluded": ["Türkiye", "Romania"],
    "audienceTargeting": "Exclusion targeting applied"
  },
  
  "htmlVersion": "a1b2c3d4e5f6g7h8"
}
```

For Thought Leadership ads (promoted by individuals on behalf of companies), the structure includes:

```json
{
  "promotionType": "THOUGHT_LEADERSHIP",
  "promoterDetails": {
    "promoterName": "James Finlayson",
    "promoterHeadline": "Founder @Light Emitting Data | Helping SEOs, Teams & Agencies Create Powerful Marketing Campaigns",
    "promoterProfileUrl": "https://www.linkedin.com/in/jamesifinlayson",
    "promoterProfileId": "jamesifinlayson",
    "promoterImageUrl": "https://media.licdn.com/dms/image/v2/D4E03AQG5VrcCQoiLTg/profile-displayphoto-shrink_100_100/0/1728292099114..."
  }
}
```

## How It Works

1. The actor loads the main LinkedIn Ads Library search page with the specified account owner and optional keyword
2. It extracts ad URLs from the initial page and enqueues them for detail scraping
3. In parallel, it processes the detail pages to extract comprehensive ad information
4. It continues pagination through search results until all ads are found or limits are reached
5. Results are saved periodically to prevent data loss and combined in the final output

## Performance & Rate Limiting

To avoid getting blocked or rate-limited by LinkedIn:

- The actor uses random delays between requests (3-5 seconds by default)
- Detail pages are processed with controlled concurrency (3 at a time by default)
- Proxies are automatically rotated to distribute requests

You can adjust these parameters to balance between speed and safety.

## Performance Optimizations

The LinkedIn Ads Library Scraper has been optimized for high performance and efficient data extraction:

1. **Parallel Processing**:
   - Separate crawlers for listing pages and ad details running in parallel
   - Immediate queuing of ad detail pages as soon as they are discovered
   - Elimination of bottlenecks where all ads needed to be extracted before proceeding to next page

2. **Dynamic Concurrency**:
   - Autoscaled pool for intelligent concurrency management
   - Adjusts concurrency based on CPU, memory, and event loop metrics
   - Scales up during light loads and down during heavy processing

3. **Session Management**:
   - Uses a session pool to manage multiple sessions efficiently
   - Sessions are persisted between runs for better stability
   - Bad sessions are automatically retired to maintain scraping quality

4. **Configurable Parameters**:
   - `maxDetailConcurrency`: Control how many ad details are scraped simultaneously
   - `minDetailDelay`/`maxDetailDelay`: Fine-tune delays between requests
   - Customizable system utilization thresholds

5. **Rate Limiting Protection**:
   - Exponential backoff for 429 (Too Many Requests) errors
   - Local mode for testing with a single IP address
   - Enforced minimum delays between requests
   - Request prioritization (listing pages before detail pages)

These optimizations enable the scraper to efficiently process hundreds or thousands of ads while maintaining stability and respecting rate limits.

## Local Testing vs. Production

The scraper supports two operation modes for different environments:

### Local Mode
Designed for development and testing on a single IP address with no proxy rotation:

- Set `localMode: true` in the input (default setting)
- Uses sequential processing: completes all listing pages first, then processes ad details
- Enforces stricter rate limiting (5-8 second delays)
- Uses lower concurrency (1 crawler at a time)
- Implements exponential backoff after rate limit errors (10s → 15s → 22.5s → etc.)

### Production Mode
Optimized for Apify or environments with proper proxy rotation:

- Set `localMode: false` in the input
- Uses parallel processing with both crawlers running simultaneously
- Uses configured concurrency and delay settings
- Better suited for high-volume scraping

**Example for local testing:**
```json
{
  "accountOwner": "seomonitor",
  "keyword": "SEO",
  "maxUrlsCount": 50,
  "scrapeAdDetails": true,
  "localMode": true
}
```

## Scraping Flow

The scraper follows different flows depending on the mode:

### Local Mode Flow:
1. Collect all ad URLs from listing pages (one page at a time)
2. Wait 5-8 seconds between listing page requests
3. After collecting all URLs, start processing ad details
4. Process details with 5-8 seconds between requests
5. Apply exponential backoff if rate limits are hit

### Production Mode Flow:
1. Process listing pages and detail pages in parallel
2. Maintain higher concurrency based on settings
3. Dynamically adjust concurrency based on system load
4. Apply configured delays between requests

## Limitations

- The actor depends on LinkedIn's HTML structure, which may change over time
- LinkedIn may impose rate limiting if too many requests are made too quickly
- Only publicly available ad data is extracted
- Some ad data may be incomplete if LinkedIn doesn't provide it (e.g., US-targeted ads may not show targeting details)

## Development

This actor is built using TypeScript, Apify SDK, and Crawlee. To modify or extend:

1. Clone the repository
2. Install dependencies: `npm install`
3. Make your changes to the source code
4. Run locally: `npm run start:dev`
5. Build: `npm run build`

## License

ISC