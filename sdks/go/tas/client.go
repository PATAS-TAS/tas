package tas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client represents a TAS API client
type Client struct {
	apiKey    string
	baseURL   string
	apiVersion string
	httpClient *http.Client
}

// NewClient creates a new TAS API client
func NewClient(apiKey, baseURL string) *Client {
	if baseURL == "" {
		baseURL = "https://tas.fly.dev"
	}
	
	return &Client{
		apiKey:     apiKey,
		baseURL:    baseURL,
		apiVersion: "v1",
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ClassifyRequest represents a classification request
type ClassifyRequest struct {
	Text      string `json:"text"`
	Lang      string `json:"lang,omitempty"`
	SenderID  string `json:"sender_id,omitempty"`
	MessageID string `json:"message_id,omitempty"`
}

// Reason represents a classification reason
type Reason struct {
	Code   string  `json:"code"`
	Text   string  `json:"text"`
	Weight float64 `json:"weight"`
}

// ClassifyResponse represents a classification response
type ClassifyResponse struct {
	// New schema
	Spam      bool     `json:"spam"`
	Score     float64  `json:"score"`
	Reasons   []Reason `json:"reasons"`
	Path      string   `json:"path"`
	RequestID string   `json:"request_id"`
	
	// Legacy fields (deprecated)
	IsSpam     bool    `json:"is_spam"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
}

// Classify classifies a single text message
func (c *Client) Classify(req ClassifyRequest) (*ClassifyResponse, error) {
	if req.Lang == "" {
		req.Lang = "en"
	}
	
	url := fmt.Sprintf("%s/%s/classify", c.baseURL, c.apiVersion)
	
	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	
	httpReq, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	
	c.setHeaders(httpReq)
	
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error: %d - %s", resp.StatusCode, string(body))
	}
	
	var result ClassifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	
	// Extract request_id from header if available
	if requestID := resp.Header.Get("X-TAS-Request-ID"); requestID != "" {
		result.RequestID = requestID
	}
	
	return &result, nil
}

// BatchRequest represents a batch classification request
type BatchRequest []ClassifyRequest

// Batch classifies multiple texts
func (c *Client) Batch(texts []string, lang string) ([]ClassifyResponse, error) {
	if len(texts) > 100 {
		return nil, fmt.Errorf("maximum 100 texts per batch request")
	}
	
	if lang == "" {
		lang = "en"
	}
	
	requests := make(BatchRequest, len(texts))
	for i, text := range texts {
		requests[i] = ClassifyRequest{
			Text: text,
			Lang: lang,
		}
	}
	
	url := fmt.Sprintf("%s/%s/batch", c.baseURL, c.apiVersion)
	
	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, err
	}
	
	httpReq, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}
	
	c.setHeaders(httpReq)
	httpReq.Header.Set("Content-Type", "application/json")
	
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error: %d - %s", resp.StatusCode, string(body))
	}
	
	var results []ClassifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&results); err != nil {
		return nil, err
	}
	
	return results, nil
}

// HealthResponse represents health check response
type HealthResponse struct {
	Status         string `json:"status"`
	Version        string `json:"version"`
	Build          string `json:"build"`
	RulesetVersion string `json:"ruleset_version"`
	LLMStatus      string `json:"llm_status"`
}

// Health checks API health status
func (c *Client) Health() (*HealthResponse, error) {
	url := fmt.Sprintf("%s/%s/health", c.baseURL, c.apiVersion)
	
	httpReq, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	
	c.setHeaders(httpReq)
	
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error: %d - %s", resp.StatusCode, string(body))
	}
	
	var result HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	
	return &result, nil
}

func (c *Client) setHeaders(req *http.Request) {
	// Support both RapidAPI and direct API key formats
	if len(c.apiKey) < 50 || contains(c.apiKey, "x-api-key") {
		req.Header.Set("x-api-key", c.apiKey)
	} else {
		req.Header.Set("X-RapidAPI-Key", c.apiKey)
		req.Header.Set("X-RapidAPI-Host", "tas.fly.dev")
	}
	req.Header.Set("Content-Type", "application/json")
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || 
		(len(s) > len(substr) && 
			(s[:len(substr)] == substr || 
			 s[len(s)-len(substr):] == substr || 
			 containsMiddle(s, substr))))
}

func containsMiddle(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

