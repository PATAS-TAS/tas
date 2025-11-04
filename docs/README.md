# TAS Demo - Troubleshooting

## API Not Available Error

If you see "Failed to fetch" or "API might be unavailable" error:

### Option 1: Run API Locally

1. Install dependencies:
```bash
cd tas
poetry install
```

2. Run the API:
```bash
poetry run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

3. The demo will automatically try `http://localhost:8000` when running locally.

### Option 2: Deploy to Fly.io

1. Install Fly CLI:
```bash
curl -L https://fly.io/install.sh | sh
```

2. Login:
```bash
flyctl auth login
```

3. Deploy:
```bash
cd tas
flyctl deploy
```

4. Update the API URL in `docs/index.html` if needed.

### Option 3: Use Alternative API

You can modify `API_URLS` array in `docs/index.html` to point to your own API endpoint.

## Testing API Manually

Test the API directly:

```bash
curl -X POST https://tas.fly.dev/classify \
  -H "Content-Type: application/json" \
  -d '{"text": "Sell iPhone 12, cheap!", "lang": "en"}'
```

Or check health:
```bash
curl https://tas.fly.dev/health
```

## Common Issues

1. **CORS errors**: Make sure API has CORS enabled (already configured)
2. **Timeout**: API might be slow to respond, timeout is set to 10 seconds
3. **Network errors**: Check your internet connection
4. **API not deployed**: Deploy to Fly.io or run locally

