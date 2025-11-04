# TAS Testing Plan

## Test Categories

### 1. API Endpoints Testing
- [ ] Health check endpoint
- [ ] Classify endpoint (single text)
- [ ] Batch classify endpoint
- [ ] Patterns endpoint
- [ ] Stats endpoint
- [ ] Root endpoint
- [ ] Error handling (invalid input, missing fields)
- [ ] Rate limiting
- [ ] CORS headers

### 2. Pipeline Logic Testing
- [ ] Rules layer only cases
- [ ] ML layer activation
- [ ] LLM fallback cases
- [ ] ML safe threshold (skip LLM)
- [ ] Cache functionality
- [ ] Empty text handling
- [ ] Very long text handling
- [ ] Edge cases (special characters, unicode)

### 3. Performance & Stress Testing
- [ ] Single request latency
- [ ] Batch request performance
- [ ] Concurrent requests (10, 50, 100)
- [ ] Memory usage under load
- [ ] Cache hit/miss rates
- [ ] Rate limiting enforcement

### 4. Demo Page Testing (UX)
- [ ] Page load
- [ ] Input validation
- [ ] API connection (multiple endpoints fallback)
- [ ] Error display
- [ ] Result display
- [ ] Keyboard shortcuts (Ctrl+Enter)
- [ ] Mobile responsiveness
- [ ] Browser compatibility
- [ ] Loading states
- [ ] Empty states

### 5. Integration Testing
- [ ] End-to-end flow (demo → API → response)
- [ ] Cache consistency
- [ ] Multi-request handling
- [ ] Session persistence

### 6. Security Testing
- [ ] SQL injection attempts
- [ ] XSS attempts
- [ ] Large payload attacks
- [ ] Rate limit bypass attempts
- [ ] CORS validation

### 7. Edge Cases & Bug Hunting
- [ ] Unicode characters
- [ ] Emoji handling
- [ ] Very long messages (8192+ chars)
- [ ] Special characters
- [ ] Empty strings
- [ ] Whitespace only
- [ ] Multiple languages mixed
- [ ] Null/undefined values
- [ ] Invalid JSON

## Test Execution Order

1. API Endpoints (basic functionality)
2. Pipeline Logic (core business logic)
3. Performance & Stress (scalability)
4. Demo Page UX (user experience)
5. Integration (end-to-end)
6. Security (vulnerabilities)
7. Edge Cases (bug hunting)

## Test Tools

- pytest for API tests
- curl/httpx for manual API testing
- Browser automation for demo testing
- Load testing tools
- Manual testing

