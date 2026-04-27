#!/bin/bash

echo "💚 Starting Funding Agent..."
echo ""

cd "$(dirname "$0")"

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed!"
    exit 1
fi

# Start the funding agent
node funding-agent.js
