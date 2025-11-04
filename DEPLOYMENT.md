# Deployment Guide

## GitHub Pages (Demo)

**Pros:**
- Free
- Automatic deployment
- HTTPS out of the box
- Good for static demos

**Cons:**
- Only static content (HTML/JS)
- API must be on another server

### Setup

1. Repository must be **public**
2. Settings → Pages → Source: `main` branch → `/docs` folder
3. Demo will be available at: `https://kiku-jw.github.io/tas/`

## Fly.io (API Backend)

**Pros:**
- Free tier (3 shared-cpu VMs)
- Automatic deployment
- HTTPS out of the box
- Fast start

**Cons:**
- Registration required
- Limitations on free tier

### Setup

1. Install Fly CLI:
```bash
curl -L https://fly.io/install.sh | sh
```

2. Login:
```bash
fly auth login
```

3. Deploy:
```bash
cd tas
fly launch --name tas-api
```

4. Set environment variables:
```bash
fly secrets set OPENAI_API_KEY=your_key_here
```

5. Update URL in `docs/index.html`:
```javascript
const API_URL = 'https://tas-api.fly.dev';
```

## Render.com (Alternative)

**Pros:**
- Free tier
- Simple deployment from GitHub
- Automatic HTTPS

### Setup

1. Create new Web Service on Render
2. Connect GitHub repository
3. Build Command: `poetry install && poetry run uvicorn app.main:app --host 0.0.0.0 --port $PORT`
4. Start Command: `poetry run uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Add environment variables in Dashboard

## Recommendation

For RapidAPI best:
- **GitHub**: Public repository + Pages (demo)
- **Fly.io**: API backend (fast, free tier)

Or:
- **GitHub**: Public repository + Pages (demo)
- **Render.com**: API backend (easier for beginners)
