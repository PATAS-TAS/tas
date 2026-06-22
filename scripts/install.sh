#!/bin/bash
# One-line installer for TAS
# Usage: curl -fsSL https://raw.githubusercontent.com/kiku-jw/tas/main/scripts/install.sh | bash

set -e

REPO_URL="https://github.com/kiku-jw/tas.git"
INSTALL_DIR="${TAS_INSTALL_DIR:-$HOME/.tas}"
CLONE_DIR="$INSTALL_DIR/repo"

echo "🚀 TAS Installation"
echo "==================="
echo ""

# Check dependencies
echo "📋 Checking dependencies..."
command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3 required. Install Python 3.10+ first."; exit 1; }
command -v poetry >/dev/null 2>&1 || { 
    echo "⚠️  Poetry not found. Installing Poetry..."
    curl -sSL https://install.python-poetry.org | python3 -
    export PATH="$HOME/.local/bin:$PATH"
}

# Clone repository
echo "📥 Cloning repository..."
if [ -d "$CLONE_DIR" ]; then
    echo "   Repository exists, updating..."
    cd "$CLONE_DIR"
    git pull || true
else
    mkdir -p "$INSTALL_DIR"
    git clone "$REPO_URL" "$CLONE_DIR"
    cd "$CLONE_DIR/tas"
fi

# Install dependencies
echo "📦 Installing dependencies..."
poetry install --no-dev

# Create .env from template
echo "⚙️  Setting up configuration..."
if [ ! -f ".env" ]; then
    if [ -f "env.example" ]; then
        cp env.example .env
        echo "✅ Created .env from template"
        echo "   ⚠️  Please edit .env and set OPENAI_API_KEY if using managed mode"
    else
        touch .env
        echo "# TAS Configuration" >> .env
        echo "OPENAI_API_KEY=your-key-here" >> .env
        echo "LLM_MODE=managed" >> .env
        echo "✅ Created .env file"
    fi
else
    echo "✅ .env already exists"
fi

# Create symlink to tas command
echo "🔗 Creating tas command..."
TAS_BIN="$INSTALL_DIR/bin/tas"
mkdir -p "$INSTALL_DIR/bin"
cat > "$TAS_BIN" << 'EOF'
#!/bin/bash
cd "$HOME/.tas/repo/tas"
exec poetry run python -m app.cli "$@"
EOF
chmod +x "$TAS_BIN"

# Add to PATH
if ! echo "$PATH" | grep -q "$INSTALL_DIR/bin"; then
    echo ""
    echo "⚠️  Add to your ~/.bashrc or ~/.zshrc:"
    echo "   export PATH=\"\$HOME/.tas/bin:\$PATH\""
    echo ""
    echo "Or run:"
    echo "   export PATH=\"\$HOME/.tas/bin:\$PATH\""
    echo ""
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Add to PATH: export PATH=\"\$HOME/.tas/bin:\$PATH\""
echo "2. Run quickstart: tas quickstart"
echo "3. Test API: tas test"
echo ""

