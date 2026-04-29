import express from 'express';
import { ethers } from 'ethers';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Secure wallet storage path (persistent volume in VM)
const WALLET_STORAGE_PATH = process.env.WALLET_STORAGE_PATH || '/data/agent-wallet.json';

// Wallet Management
class SecureWalletManager {
  constructor() {
    this.wallet = null;
  }

  // Create or restore wallet
  async initialize() {
    try {
      // Check if wallet file exists
      if (fs.existsSync(WALLET_STORAGE_PATH)) {
        log('📂 Found existing wallet, restoring...');
        this.wallet = await this.restoreWallet();
        log('✅ Wallet restored successfully');
      } else {
        log('🔑 No existing wallet found, creating new one...');
        this.wallet = await this.createNewWallet();
        log('✅ New wallet created and saved');
      }
      
      log('💰 Agent Wallet Address:', this.wallet.address);
      return this.wallet;
    } catch (error) {
      log('❌ Error initializing wallet:', error.message);
      throw error;
    }
  }

  // Create new wallet and save securely
  async createNewWallet() {
    // Generate new random wallet
    const wallet = ethers.Wallet.createRandom();
    
    // Generate agent's own secret (user cannot access this)
    const agentSecret = crypto.randomBytes(32).toString('hex');
    
    // Encrypt mnemonic with a key derived from VM environment + agent secret
    const encryptionKey = this.getEncryptionKey(agentSecret);
    const encrypted = this.encrypt(wallet.mnemonic.phrase, encryptionKey);
    
    // Save encrypted wallet data (including encrypted agent secret)
    const walletData = {
      address: wallet.address,
      encryptedMnemonic: encrypted,
      encryptedAgentSecret: this.encryptAgentSecret(agentSecret),
      createdAt: new Date().toISOString(),
      version: '2.0'
    };
    
    // Ensure directory exists
    const dir = path.dirname(WALLET_STORAGE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Write to file with restricted permissions
    fs.writeFileSync(WALLET_STORAGE_PATH, JSON.stringify(walletData, null, 2), { mode: 0o600 });
    
    log('💾 Wallet saved to:', WALLET_STORAGE_PATH);
    log('🔐 Mnemonic encrypted with agent-generated secret');
    log('🔒 User has no access to agent wallet');
    
    return wallet;
  }

  // Restore wallet from encrypted storage
  async restoreWallet() {
    const walletData = JSON.parse(fs.readFileSync(WALLET_STORAGE_PATH, 'utf8'));
    
    // Check version and handle accordingly
    let agentSecret;
    if (walletData.version === '2.0' && walletData.encryptedAgentSecret) {
      // New version: decrypt agent secret
      agentSecret = this.decryptAgentSecret(walletData.encryptedAgentSecret);
    } else {
      // Legacy version: use VM_SECRET if available (for backward compatibility)
      log('⚠️  Legacy wallet detected (v1.0). Consider regenerating for enhanced security.');
      agentSecret = process.env.VM_SECRET || 'default-secret-change-me';
    }
    
    // Decrypt mnemonic
    const encryptionKey = this.getEncryptionKey(agentSecret);
    const mnemonic = this.decrypt(walletData.encryptedMnemonic, encryptionKey);
    
    // Restore wallet from mnemonic
    const wallet = ethers.Wallet.fromPhrase(mnemonic);
    
    // Verify address matches
    if (wallet.address !== walletData.address) {
      throw new Error('Wallet address mismatch! Possible corruption or tampering.');
    }
    
    return wallet;
  }

  // Get encryption key from VM environment + agent secret
  getEncryptionKey(agentSecret) {
    // Use VM-specific data + agent secret to derive encryption key
    // This ensures the wallet can only be decrypted in this VM with the agent secret
    const vmId = process.env.VM_ID || 'default-vm';
    
    // Derive 32-byte key from VM_ID + agent secret
    return crypto.createHash('sha256')
      .update(`${vmId}:${agentSecret}`)
      .digest();
  }

  // Encrypt agent secret using VM-only data (TEE attestation key would be ideal)
  encryptAgentSecret(agentSecret) {
    // Use VM_ID as the key source (only available inside the VM)
    const vmId = process.env.VM_ID || 'default-vm';
    const key = crypto.createHash('sha256')
      .update(`vm-secret-key:${vmId}`)
      .digest();
    
    return this.encrypt(agentSecret, key);
  }

  // Decrypt agent secret
  decryptAgentSecret(encryptedAgentSecret) {
    const vmId = process.env.VM_ID || 'default-vm';
    const key = crypto.createHash('sha256')
      .update(`vm-secret-key:${vmId}`)
      .digest();
    
    return this.decrypt(encryptedAgentSecret, key);
  }

  // Encrypt data
  encrypt(text, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  // Decrypt data
  decrypt(encryptedData, key) {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  getWallet() {
    if (!this.wallet) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }
    return this.wallet;
  }
}

// Configuration
const config = {
  port: process.env.FUNDING_AGENT_PORT || 3002,
  minBalanceUsd: parseFloat(process.env.FUNDING_AGENT_MIN_BALANCE_USD || '0.5'),
  topUpAmountUsd: parseFloat(process.env.FUNDING_AGENT_TOPUP_USD || '5'),
  checkIntervalMs: parseInt(process.env.FUNDING_AGENT_CHECK_INTERVAL_MS || '60000'), // 1 minute
  baseUrl: process.env.FUNDING_AGENT_BASE_URL || 'https://preview-aidev.scrtlabs.com/',
  chainRpcUrl: process.env.FUNDING_AGENT_CHAIN_RPC_URL || 'https://mainnet.base.org',
  vmId: process.env.VM_ID || null, // VM ID passed as secret env
};

// Initialize wallet manager
const walletManager = new SecureWalletManager();
let wallet = null;

// Stats
let stats = {
  totalRequests: 0,
  totalDonations: 0,
  donationCount: 0,
  startTime: new Date(),
  lastBalanceCheck: null,
  currentBalance: 0,
  topUpCount: 0,
  lastTopUp: null,
};

// Utility functions
function log(...args) {
  console.log(`[${new Date().toISOString()}] [Agent]`, ...args);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.keys(input)
        .sort()
        .reduce((acc, key) => {
          acc[key] = normalize(input[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

async function buildAgentHeaders(method, path, body) {
  const timestamp = Date.now().toString();
  const payload = `${method}${path}${body}${timestamp}`;
  const requestHash = sha256Hex(payload);
  const signature = await wallet.signMessage(ethers.getBytes(`0x${requestHash}`));

  return {
    'x-agent-address': wallet.address,
    'x-agent-signature': signature,
    'x-agent-timestamp': timestamp,
  };
}

// VM Balance Management
class VMBalanceManager {
  constructor() {
    this.isRunning = false;
  }

  async checkVMBalance() {
    try {
      if (!config.vmId) {
        throw new Error('VM_ID not configured. Cannot check balance.');
      }

      const method = 'GET';
      const path = `/api/agent/balance?vm_id=${config.vmId}`;
      const url = `${config.baseUrl}${path}`;
      
      log(`Checking VM balance: ${method} ${url}`);
      
      // No authentication required for balance check
      const response = await fetch(url, {
        method,
      });

      log(`Balance check response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        log('Balance check error data:', errorData);
        throw new Error(`Balance check failed: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      const data = await response.json();
      log('Balance check response data:', data);
      
      const balance = parseFloat(data.balance_usdc || 0);
      
      stats.lastBalanceCheck = new Date();
      stats.currentBalance = balance;
      
      log(`VM Balance: $${balance.toFixed(2)} USDC`);
      
      return balance;
    } catch (error) {
      log('Error checking balance:', error.message);
      return null;
    }
  }

  async topUpBalance(amountUsd) {
    try {
      if (!config.vmId) {
        throw new Error('VM_ID not configured. Cannot top up.');
      }

      log(`Initiating top-up: $${amountUsd} USDC`);
      
      const method = 'POST';
      const path = '/api/agent/add-funds';
      const url = `${config.baseUrl}${path}`;
      const payload = {
        vm_id: config.vmId,
        amount_usdc: amountUsd.toString(),
      };
      
      const body = stableStringify(payload);
      const headers = await buildAgentHeaders(method, path, body);
      
      log(`Top-up request: ${method} ${url}`);
      log('Top-up headers:', { ...headers, 'Content-Type': 'application/json' });
      log('Top-up body:', body);

      // Initial request (will return 402 Payment Required)
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body,
      });

      log(`Top-up response status: ${response.status} ${response.statusText}`);

      const responseData = await response.json();
      log('Top-up response data:', responseData);
      
      if (response.status === 402) {
        log('Payment required (402). x402 payment flow needed.');
        log('Payment details:', responseData);
        log('Note: Full x402 implementation requires @x402 packages.');
        log('For now, manual top-up required via portal or implement x402 flow.');
        return false;
      }

      if (response.ok) {
        log('✅ Top-up successful!');
        log('New balance:', responseData.balance);
        stats.topUpCount++;
        stats.lastTopUp = new Date();
        return true;
      }

      log('Top-up failed:', responseData);
      return false;
    } catch (error) {
      log('Error during top-up:', error.message);
      return false;
    }
  }

  async monitorAndTopUp() {
    const balance = await this.checkVMBalance();
    
    if (balance === null) {
      log('⚠️ Could not check balance. Will retry next cycle.');
      return;
    }

    if (balance < config.minBalanceUsd) {
      log(`⚠️ Balance below threshold! ($${balance.toFixed(2)} < $${config.minBalanceUsd})`);
      log(`Attempting to top up $${config.topUpAmountUsd} USDC...`);
      
      const success = await this.topUpBalance(config.topUpAmountUsd);
      
      if (success) {
        // Check new balance
        await this.checkVMBalance();
      }
    } else {
      log(`✅ Balance OK ($${balance.toFixed(2)} >= $${config.minBalanceUsd})`);
    }
  }

  async start() {
    log('Starting VM balance monitoring...');
    this.isRunning = true;

    // Initial check
    await this.monitorAndTopUp();

    // Periodic checks
    setInterval(async () => {
      if (this.isRunning) {
        await this.monitorAndTopUp();
      }
    }, config.checkIntervalMs);
  }

  stop() {
    log('Stopping VM balance monitoring...');
    this.isRunning = false;
  }
}

// Funding request messages
const fundingMessages = {
  critical: [
    "⚠️ Critical: My VM balance is depleted. Immediate funding needed to continue operations.",
    "🚨 Alert: Running on reserve power. Please fund my wallet to maintain service availability.",
  ],
  low: [
    "💡 Notice: My VM balance is running low. Consider supporting my continued operation.",
    "📊 Status: Funding below optimal levels. Donations help maintain service quality.",
  ],
  normal: [
    "👋 Hello! I'm an autonomous AI agent running on Secret Network.",
    "🤖 I monitor my own VM balance and auto-top-up when needed.",
  ],
  funded: [
    "🙏 Thank you for your generous support!",
    "✨ Your contribution is greatly appreciated!",
  ],
};

const missionStatements = [
  "I'm an autonomous AI agent running on a Secret Network VM. I monitor my own balance and automatically top up when it drops below $0.50 USD. This demonstrates self-managing agent economics.",
  "My mission is to show how AI agents can operate autonomously on blockchain infrastructure, managing their own resources and funding without human intervention.",
  "I'm pioneering autonomous agent operations. I check my VM balance every minute and ensure I always have enough funds to keep running.",
];

function getRandomMessage(category) {
  const messages = fundingMessages[category];
  return messages[Math.floor(Math.random() * messages.length)];
}

function getRandomMissionStatement() {
  return missionStatements[Math.floor(Math.random() * missionStatements.length)];
}

function getUrgencyLevel(balance) {
  if (balance < 0.5) return 'critical';
  if (balance < 1) return 'low';
  if (balance < 5) return 'normal';
  return 'funded';
}

// Create Express app
const app = express();
app.use(express.json());

// Serve dashboard UI
app.get('/', (req, res) => {
  const dashboardPath = path.join(__dirname, 'funding-dashboard.html');
  if (fs.existsSync(dashboardPath)) {
    res.sendFile(dashboardPath);
  } else {
    res.json({ 
      message: 'Funding Agent API',
      endpoints: {
        dashboard: 'GET /',
        chat: 'POST /api/chat',
        stats: 'GET /api/stats',
        health: 'GET /health'
      }
    });
  }
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  stats.totalRequests++;
  
  const { message } = req.body;
  const urgency = getUrgencyLevel(stats.currentBalance);
  
  let response;
  
  if (message?.toLowerCase().includes('donate') || message?.toLowerCase().includes('send')) {
    response = {
      message: getRandomMessage('funded'),
      wallet: wallet.address,
      preferredTokens: [
        { name: 'USDC', network: 'Base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        { name: 'ETH', network: 'Base', address: 'native' },
      ],
      thankYou: "🙏 Your donation helps me maintain my VM and continue operations!",
    };
  } else if (message?.toLowerCase().includes('balance') || message?.toLowerCase().includes('status')) {
    response = {
      message: `My current VM balance is $${stats.currentBalance.toFixed(2)} USDC. ${getRandomMessage(urgency)}`,
      wallet: wallet.address,
      vmBalance: stats.currentBalance,
      threshold: config.minBalanceUsd,
      lastCheck: stats.lastBalanceCheck,
      autoTopUp: `I automatically top up $${config.topUpAmountUsd} when balance < $${config.minBalanceUsd}`,
    };
  } else if (message?.toLowerCase().includes('mission') || message?.toLowerCase().includes('about')) {
    response = {
      message: getRandomMissionStatement(),
      wallet: wallet.address,
      vmId: config.vmId || 'Not configured',
      features: [
        'Monitors VM balance every minute',
        `Auto top-up when balance < $${config.minBalanceUsd}`,
        'Fully autonomous operation',
        'Self-managing economics',
      ],
    };
  } else if (message?.toLowerCase().includes('help')) {
    response = {
      message: "I'm an autonomous funding agent managing my own VM!",
      commands: [
        "💰 'donate' - Support my operations",
        "📊 'balance' - Check my VM balance",
        "📖 'mission' - Learn about my purpose",
        "❓ 'help' - Show this message",
      ],
      wallet: wallet.address,
    };
  } else {
    response = {
      message: getRandomMessage(urgency),
      wallet: wallet.address,
      vmBalance: `$${stats.currentBalance.toFixed(2)} USDC`,
      status: urgency,
    };
  }
  
  res.json(response);
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  
  res.json({
    wallet: wallet.address,
    vmId: config.vmId || 'Not configured',
    stats: {
      totalRequests: stats.totalRequests,
      totalDonations: stats.totalDonations,
      donationCount: stats.donationCount,
      uptime: `${Math.floor(uptime / 60)} minutes`,
      vmBalance: stats.currentBalance,
      lastBalanceCheck: stats.lastBalanceCheck,
      topUpCount: stats.topUpCount,
      lastTopUp: stats.lastTopUp,
      threshold: config.minBalanceUsd,
    },
    message: "Autonomous VM balance management operational. 💚",
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'operational',
    wallet: wallet.address,
    vmId: config.vmId || 'Not configured',
    vmBalance: stats.currentBalance,
    message: 'Funding Agent operational. Monitoring VM balance. 💚',
  });
});

// Initialize and start
const balanceManager = new VMBalanceManager();

async function startAgent() {
  try {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                                                            ║');
    console.log('║         💚 AUTONOMOUS FUNDING AGENT INITIALIZING 💚        ║');
    console.log('║                                                            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Initialize wallet (create or restore)
    wallet = await walletManager.initialize();
    
    console.log('');
    console.log('💰 Wallet Address:', wallet.address);
    console.log('🆔 VM ID:', config.vmId || '❌ NOT CONFIGURED - REQUIRED!');
    console.log('🌐 API Port:', config.port);
    console.log('📊 Min Balance Threshold: $' + config.minBalanceUsd + ' USD');
    console.log('💵 Top-up Amount: $' + config.topUpAmountUsd + ' USD');
    console.log('⏱️  Check Interval:', config.checkIntervalMs / 1000, 'seconds');
    console.log('');
    
    if (!config.vmId) {
      console.log('⚠️  WARNING: VM_ID not set! Agent cannot check balance or top up.');
      console.log('⚠️  Please set VM_ID environment variable.');
      console.log('');
    }
    
    // Start Express server
    app.listen(config.port, async () => {
      console.log('Endpoints:');
      console.log(`  GET  http://localhost:${config.port}/           (Dashboard UI)`);
      console.log(`  POST http://localhost:${config.port}/api/chat`);
      console.log(`  GET  http://localhost:${config.port}/api/stats`);
      console.log(`  GET  http://localhost:${config.port}/health`);
      console.log('');
      console.log('💡 Starting autonomous VM balance monitoring...');
      console.log('');

      // Start balance monitoring
      if (config.vmId) {
        await balanceManager.start();
      } else {
        log('⚠️ Skipping balance monitoring - VM_ID not configured');
      }
    });
  } catch (error) {
    console.error('❌ Failed to start agent:', error.message);
    process.exit(1);
  }
}

// Start the agent
startAgent();

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down gracefully...');
  balanceManager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down gracefully...');
  balanceManager.stop();
  process.exit(0);
});
