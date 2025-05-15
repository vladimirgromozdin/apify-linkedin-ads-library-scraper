/**
 * Utility functions for the LinkedIn Ads Library Scraper
 */
import crypto from 'crypto';
import { log } from 'crawlee';

/**
 * Extracts a profile ID from a LinkedIn profile URL.
 * @param url LinkedIn profile URL
 * @returns The extracted profile ID or undefined if not found
 */
export function extractProfileId(url: string): string | undefined {
    if (!url) return undefined;
    
    // Company profile format: https://www.linkedin.com/company/1234567?trk=...
    const companyMatch = url.match(/\/company\/(\d+)/);
    if (companyMatch) return companyMatch[1];
    
    // Personal profile format: https://www.linkedin.com/in/username?trk=...
    const personalMatch = url.match(/\/in\/([^/?]+)/);
    if (personalMatch) return personalMatch[1];
    
    return undefined;
}

/**
 * Generates a random delay between min and max milliseconds
 * @param min Minimum delay in milliseconds
 * @param max Maximum delay in milliseconds
 * @returns Promise that resolves after the delay
 */
export function randomDelay(min = 3000, max = 4000): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    log.debug(`Random delay: ${delay}ms`);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Parses impression ranges like "10k-50k" into numerical min/max values.
 * @param impressionRange The raw impression range string
 * @returns Object with min and max values
 */
export function parseImpressionRange(impressionRange: string): { min?: number; max?: number } {
    if (!impressionRange) return {};
    
    // Handle formats like "10k-50k", "< 1k", etc.
    const result: { min?: number; max?: number } = {};
    
    // Convert abbreviations to numerical values
    const parseValue = (val: string): number => {
        val = val.trim().toLowerCase();
        if (val.endsWith('k')) {
            return parseFloat(val.slice(0, -1)) * 1000;
        } else if (val.endsWith('m')) {
            return parseFloat(val.slice(0, -1)) * 1000000;
        }
        return parseFloat(val);
    };
    
    // Handle "< X" format
    if (impressionRange.startsWith('<')) {
        result.max = parseValue(impressionRange.substring(1));
        return result;
    }
    
    // Handle "X-Y" format
    const parts = impressionRange.split('-');
    if (parts.length === 2) {
        result.min = parseValue(parts[0]);
        result.max = parseValue(parts[1]);
    } else {
        // Handle single value like "10k"
        const value = parseValue(impressionRange);
        result.min = value;
        result.max = value;
    }
    
    return result;
}

/**
 * Parses a percentage string (e.g., "26%", "< 1%") into a decimal value
 * @param percentageStr The percentage string
 * @returns The decimal value (e.g., 0.26 for "26%")
 */
export function parsePercentage(percentageStr: string): number {
    if (!percentageStr) return 0;
    
    percentageStr = percentageStr.trim();
    
    // Handle "< 1%" case
    if (percentageStr.startsWith('<')) {
        return 0.005; // Approximate as 0.5%
    }
    
    // Handle normal percentage, e.g., "26%"
    const match = percentageStr.match(/(\d+)/);
    if (match) {
        return parseInt(match[1], 10) / 100;
    }
    
    return 0;
}

/**
 * Generates a content fingerprint (hash) to help detect changes in page structure
 * @param html HTML content to fingerprint
 * @returns A hash string representing the content structure
 */
export function generateContentFingerprint(html: string): string {
    // Strip out variable content like timestamps, unique IDs, etc.
    // This is a simplified version - you might need to customize based on the actual content
    const normalizedHtml = html
        .replace(/\s+/g, ' ')           // Normalize whitespace
        .replace(/\d{10,}/g, 'ID')      // Replace long numbers with ID
        .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE') // Replace dates
        .replace(/[a-f0-9]{32}/g, 'HASH');  // Replace MD5-like hashes
    
    // Generate a SHA-256 hash of the normalized content
    return crypto
        .createHash('sha256')
        .update(normalizedHtml)
        .digest('hex')
        .substring(0, 16); // Only keep first 16 chars for readability
}

/**
 * Removes LinkedIn's tracking parameters from URLs
 * Removes '?trk=...' or '&trk=...' from LinkedIn profile URLs
 * @param url URL to clean
 * @returns Cleaned URL
 */
export function cleanLinkedInUrl(url: string): string {
    if (!url) return url;
    
    // Remove LinkedIn tracking parameters (trk=...)
    return url.replace(/[?&]trk=[^&]+(&|$)/g, (_match, p1) => {
        // If this was the only parameter (starting with ?) or the last parameter, return empty string
        // Otherwise keep the & for the next parameter
        return p1 === '&' ? '&' : '';
    }).replace(/&$/, ''); // Remove trailing ampersand if exists
}