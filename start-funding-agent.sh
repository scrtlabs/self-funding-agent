#!/bin/bash

echo "💚 Starting Funding Agent..."
echo ""

cd "$(dirname "$0")"

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    exit 1
fi

# Build if dist doesn't exist
if [ ! -d "dist" ]; then
    echo "📦 Building TypeScript project..."
    npm run build
fi

# Start the funding agent
node dist/funding-agent.js
