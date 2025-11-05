/**
 * TAS SDK for Node.js - Transmodal Anti-Spam API Client
 */

const axios = require('axios');

class TASClient {
    /**
     * Initialize TAS client
     * @param {string} apiKey - Your RapidAPI API key or direct API key
     * @param {string} baseUrl - Base URL of TAS API (default: https://tas.fly.dev)
     * @param {string} apiVersion - API version to use (default: v1)
     */
    constructor(apiKey, baseUrl = 'https://tas.fly.dev', apiVersion = 'v1') {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiVersion = apiVersion;
        
        // Support both RapidAPI and direct API key formats
        const headers = {
            'Content-Type': 'application/json'
        };
        if (apiKey.toLowerCase().includes('x-api-key') || apiKey.length < 50) {
            headers['x-api-key'] = apiKey;
        } else {
            headers['X-RapidAPI-Key'] = apiKey;
            headers['X-RapidAPI-Host'] = 'tas.fly.dev';
        }
        
        this.client = axios.create({
            baseURL: `${this.baseUrl}/${this.apiVersion}`,
            headers: headers,
            timeout: 10000
        });
    }

    /**
     * Classify text as spam or not spam
     * @param {string} text - Text message to classify (1-8192 characters)
     * @param {string} lang - Language code (default: "en")
     * @param {string} senderId - Optional sender identifier
     * @param {string} messageId - Optional message identifier
     * @returns {Promise<Object>} Classification result with spam, score, reasons[], path, request_id (and legacy fields)
     */
    async classify(text, lang = 'en', senderId = null, messageId = null) {
        const payload = {
            text: text,
            lang: lang
        };

        if (senderId) payload.sender_id = senderId;
        if (messageId) payload.message_id = messageId;

        try {
            const response = await this.client.post('/classify', payload);
            const result = response.data;
            
            // Extract request_id from header if available
            if (response.headers['x-tas-request-id']) {
                result.request_id = response.headers['x-tas-request-id'];
            }
            
            return result;
        } catch (error) {
            if (error.response) {
                throw new Error(`API Error: ${error.response.status} - ${error.response.data?.detail || error.message}`);
            }
            throw error;
        }
    }

    /**
     * Batch classify multiple texts
     * @param {Array<string>} texts - Array of text messages (max 100, each ≤ 2000 chars)
     * @param {string} lang - Language code (default: "en")
     * @returns {Promise<Array<Object>>} Array of classification results
     */
    async batch(texts, lang = 'en') {
        if (!Array.isArray(texts)) {
            throw new Error('texts must be an array');
        }
        if (texts.length > 100) {
            throw new Error('Maximum 100 texts per batch request');
        }

        const payload = texts.map(text => ({ text, lang }));

        try {
            const response = await this.client.post('/batch', payload, { timeout: 30000 });
            return response.data;
        } catch (error) {
            if (error.response) {
                throw new Error(`API Error: ${error.response.status} - ${error.response.data?.detail || error.message}`);
            }
            throw error;
        }
    }

    /**
     * Check API health status
     * @returns {Promise<Object>} Health status, version, and metrics
     */
    async health() {
        try {
            const response = await this.client.get('/health');
            return response.data;
        } catch (error) {
            if (error.response) {
                throw new Error(`API Error: ${error.response.status} - ${error.response.data?.detail || error.message}`);
            }
            throw error;
        }
    }

    /**
     * Get API version information
     * @returns {Promise<Object>} Version and API version
     */
    async version() {
        try {
            const response = await this.client.get('/version');
            return response.data;
        } catch (error) {
            if (error.response) {
                throw new Error(`API Error: ${error.response.status} - ${error.response.data?.detail || error.message}`);
            }
            throw error;
        }
    }
}

/**
 * Quick function to classify text without creating a client
 * @param {string} text - Text to classify
 * @param {string} apiKey - API key
 * @param {string} lang - Language code (default: "en")
 * @param {string} baseUrl - Base URL (default: https://tas.fly.dev)
 * @returns {Promise<Object>} Classification result
 */
async function classifyText(text, apiKey, lang = 'en', baseUrl = 'https://tas.fly.dev') {
    const client = new TASClient(apiKey, baseUrl);
    return await client.classify(text, lang);
}

module.exports = {
    TASClient,
    classifyText
};

