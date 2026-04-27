#!/bin/bash

# Self-Funding Agent Deployment Script
# This script generates a docker-compose.yml file for deploying the agent from GHCR

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║     Self-Funding Agent Deployment Generator                ║"
echo "║                                                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Configuration
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/scrtlabs/self-funding-agent:latest}"
OUTPUT_FILE="${OUTPUT_FILE:-docker-compose.yml}"
PORT="${PORT:-3002}"
MIN_BALANCE="${MIN_BALANCE:-0.5}"
TOPUP_AMOUNT="${TOPUP_AMOUNT:-5}"
CHECK_INTERVAL="${CHECK_INTERVAL:-60000}"
BASE_URL="${BASE_URL:-https://preview-aidev.scrtlabs.com/}"
CHAIN_RPC="${CHAIN_RPC:-https://mainnet.base.org}"

echo "📦 Image: $IMAGE_NAME"
echo "📄 Output: $OUTPUT_FILE"
echo "🌐 Port: $PORT"
echo "💰 Min Balance: \$$MIN_BALANCE USD"
echo "💵 Top-up Amount: \$$TOPUP_AMOUNT USD"
echo "⏱️  Check Interval: ${CHECK_INTERVAL}ms"
echo ""

# Generate docker-compose.yml
cat > "$OUTPUT_FILE" <<EOF
version: '3.8'

services:
  funding-agent:
    image: $IMAGE_NAME
    ports:
      - "$PORT:$PORT"
    environment:
      # VM Configuration (REQUIRED - passed as secret)
      - VM_ID=\${VM_ID}
      
      # Wallet Security (REQUIRED - unique per VM)
      - VM_SECRET=\${VM_SECRET}
      
      # Agent Configuration
      - FUNDING_AGENT_PORT=$PORT
      - FUNDING_AGENT_MIN_BALANCE_USD=$MIN_BALANCE
      - FUNDING_AGENT_TOPUP_USD=$TOPUP_AMOUNT
      - FUNDING_AGENT_CHECK_INTERVAL_MS=$CHECK_INTERVAL
      - FUNDING_AGENT_BASE_URL=$BASE_URL
      - FUNDING_AGENT_CHAIN_RPC_URL=$CHAIN_RPC
      
      # Wallet Storage Path (persistent volume)
      - WALLET_STORAGE_PATH=/data/agent-wallet.json
    
    volumes:
      # Persistent storage for wallet
      - agent-data:/data
    
    restart: unless-stopped
    
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:$PORT/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s

volumes:
  agent-data:
    driver: local
EOF

echo "✅ Generated $OUTPUT_FILE"
echo ""
echo "📋 Next Steps:"
echo ""
echo "1. Upload this docker-compose.yml to Secret Network Portal"
echo "2. Enable 'Self-Funding Agent' in Agentic Settings"
echo "3. Add encrypted secrets:"
echo "   - VM_ID: (will be auto-filled after VM creation)"
echo "   - VM_SECRET: (generate a strong random password)"
echo ""
echo "4. Deploy the VM"
echo "5. Agent will create its wallet on first run"
echo "6. Fund the agent's wallet with USDC on Base network"
echo ""
echo "🔗 Portal: https://preview-aidev.scrtlabs.com/"
echo ""
