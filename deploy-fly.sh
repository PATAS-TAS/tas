#!/bin/bash

set -e

echo "🚀 Deploying TAS API to Fly.io"
echo ""

export FLYCTL_INSTALL="/Users/nick/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

cd "$(dirname "$0")"

echo "1️⃣ Checking Fly CLI..."
if ! command -v fly &> /dev/null; then
    echo "❌ Fly CLI not found. Installing..."
    curl -L https://fly.io/install.sh | sh
    export FLYCTL_INSTALL="/Users/nick/.fly"
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
fi

echo "2️⃣ Checking authentication..."
if ! fly auth whoami &> /dev/null; then
    echo "⚠️  Not logged in. Opening browser for authentication..."
    fly auth login
fi

echo "3️⃣ Creating/updating Fly.io app..."
fly launch --name tas-api --region iad --no-deploy --copy-config || true

echo "4️⃣ Setting secrets (if OPENAI_API_KEY is set)..."
if [ -n "$OPENAI_API_KEY" ]; then
    fly secrets set OPENAI_API_KEY="$OPENAI_API_KEY"
    echo "✅ OPENAI_API_KEY set"
else
    echo "⚠️  OPENAI_API_KEY not set. Set it manually:"
    echo "   fly secrets set OPENAI_API_KEY=your_key_here"
fi

echo "5️⃣ Deploying..."
fly deploy

echo ""
echo "✅ Deployment complete!"
echo "🌐 API will be available at: https://tas-api.fly.dev"
echo ""
echo "📝 Next steps:"
echo "   1. Update docs/index.html with API URL"
echo "   2. Test API: curl https://tas-api.fly.dev/health"

