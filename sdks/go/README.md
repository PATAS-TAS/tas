# TAS SDK for Go

Go client library for TAS (Transmodal Anti-Spam) API.

## Installation

```bash
go get github.com/kiku-jw/tas-sdk-go
```

## Usage

```go
package main

import (
    "fmt"
    "log"
    "github.com/kiku-jw/tas-sdk-go/tas"
)

func main() {
    client := tas.NewClient("YOUR_API_KEY", "")
    
    // Single classification
    result, err := client.Classify(tas.ClassifyRequest{
        Text: "Скидки -70% сегодня, пишите в тг @sale_best!",
        Lang: "ru",
    })
    if err != nil {
        log.Fatal(err)
    }
    
    fmt.Printf("Spam: %v, Score: %.2f\n", result.Spam, result.Score)
    fmt.Printf("Path: %s, Request ID: %s\n", result.Path, result.RequestID)
    
    // Batch classification
    texts := []string{
        "Продам iPhone 12",
        "Hello, how are you?",
    }
    results, err := client.Batch(texts, "en")
    if err != nil {
        log.Fatal(err)
    }
    
    for i, r := range results {
        fmt.Printf("Text %d: Spam=%v, Score=%.2f\n", i+1, r.Spam, r.Score)
    }
    
    // Health check
    health, err := client.Health()
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Status: %s, Version: %s\n", health.Status, health.Version)
}
```

## API Reference

See [TAS API Documentation](https://kiku-jw.github.io/tas/) for full API details.

