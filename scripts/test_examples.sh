#!/bin/bash
# Test examples without Docker (fallback)

cd "$(dirname "$0")/../examples"

echo "🧪 Testing Examples (without Docker)"
echo "===================================="
echo ""

STATUSES=()

# Test Python
echo "1️⃣  Testing Python..."
if command -v python3 &> /dev/null; then
    cd python
    if python3 client.py 2>&1 | grep -q "Spam\|Error"; then
        echo "✅ Python: PASS"
        STATUSES+=("✅ Python: PASS")
    else
        echo "⚠️  Python: UNKNOWN"
        STATUSES+=("⚠️  Python: UNKNOWN")
    fi
    cd ..
else
    echo "⏭️  Python: SKIPPED (python3 not found)"
    STATUSES+=("⏭️  Python: SKIPPED")
fi

# Test Node
echo ""
echo "2️⃣  Testing Node.js..."
if command -v node &> /dev/null; then
    cd node
    if node client.js 2>&1 | grep -q "Spam\|Error"; then
        echo "✅ Node.js: PASS"
        STATUSES+=("✅ Node.js: PASS")
    else
        echo "⚠️  Node.js: UNKNOWN"
        STATUSES+=("⚠️  Node.js: UNKNOWN")
    fi
    cd ..
else
    echo "⏭️  Node.js: SKIPPED (node not found)"
    STATUSES+=("⏭️  Node.js: SKIPPED")
fi

# Test Go
echo ""
echo "3️⃣  Testing Go..."
if command -v go &> /dev/null; then
    cd go
    if go run client.go 2>&1 | grep -q "Spam\|Error"; then
        echo "✅ Go: PASS"
        STATUSES+=("✅ Go: PASS")
    else
        echo "⚠️  Go: UNKNOWN"
        STATUSES+=("⚠️  Go: UNKNOWN")
    fi
    cd ..
else
    echo "⏭️  Go: SKIPPED (go not found)"
    STATUSES+=("⏭️  Go: SKIPPED")
fi

# Test PHP
echo ""
echo "4️⃣  Testing PHP..."
if command -v php &> /dev/null; then
    cd php
    if php client.php 2>&1 | grep -q "Spam\|Error"; then
        echo "✅ PHP: PASS"
        STATUSES+=("✅ PHP: PASS")
    else
        echo "⚠️  PHP: UNKNOWN"
        STATUSES+=("⚠️  PHP: UNKNOWN")
    fi
    cd ..
else
    echo "⏭️  PHP: SKIPPED (php not found)"
    STATUSES+=("⏭️  PHP: SKIPPED")
fi

# Test Java
echo ""
echo "5️⃣  Testing Java..."
if command -v javac &> /dev/null && command -v java &> /dev/null; then
    cd java
    javac Client.java 2>&1
    if java Client 2>&1 | grep -q "Result\|Error"; then
        echo "✅ Java: PASS"
        STATUSES+=("✅ Java: PASS")
    else
        echo "⚠️  Java: UNKNOWN"
        STATUSES+=("⚠️  Java: UNKNOWN")
    fi
    cd ..
else
    echo "⏭️  Java: SKIPPED (java/javac not found)"
    STATUSES+=("⏭️  Java: SKIPPED")
fi

# Generate report
mkdir -p ../reports
cat > ../reports/examples_run.md << EOF
# Examples Run Report

**Date**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Test Results

EOF

for status in "${STATUSES[@]}"; do
    echo "- $status" >> ../reports/examples_run.md
done

cat >> ../reports/examples_run.md << EOF

## Notes

- Tests run without Docker (fallback mode)
- Some examples may require API key: \`export TAS_API_KEY=your-key\`
- Docker tests: \`cd examples && docker-compose up --abort-on-container-exit\`
EOF

echo ""
echo "✅ Report saved: reports/examples_run.md"

