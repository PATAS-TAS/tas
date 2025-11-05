package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

var (
	API_KEY  = getEnv("TAS_API_KEY", "your-api-key")
	BASE_URL = getEnv("TAS_BASE_URL", "https://tas.fly.dev")
)

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

type ClassifyRequest struct {
	Text string `json:"text"`
	Lang string `json:"lang"`
}

type ClassifyResponse struct {
	Spam    bool     `json:"spam"`
	Score   float64  `json:"score"`
	Reasons []string `json:"reasons"`
}

func classify(text, lang string) (*ClassifyResponse, error) {
	reqBody := ClassifyRequest{Text: text, Lang: lang}
	jsonData, _ := json.Marshal(reqBody)

	req, _ := http.NewRequest("POST", BASE_URL+"/v1/classify", bytes.NewBuffer(jsonData))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-API-Key", API_KEY)

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result ClassifyResponse
	json.Unmarshal(body, &result)

	return &result, nil
}

func main() {
	result, err := classify("Earn $1000/day working from home! Click https://scam.com", "en")
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	fmt.Printf("Spam: %v\n", result.Spam)
	fmt.Printf("Score: %.2f\n", result.Score)
	fmt.Printf("Reasons: %v\n", result.Reasons)
}

