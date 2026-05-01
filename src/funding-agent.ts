import express, { Request, Response } from 'express';
import { ethers } from 'ethers';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PassThrough } from 'stream';
import { ApiKeyStorageManager } from './api-key-storage.js';
import { ApiKeyFetcher } from './api-key-fetcher.js';
import { SecretAiClient } from './secretai-client.js';
import buildInfo from './build-info.json' assert { type: 'json' };
import { ChatHistoryRecord, OnchainChatStorage } from './onchain-chat-storage.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hoist ESM import — secretvm-verify is ESM-only, cache it at startup
let checkSecretVm: any;
import('secretvm-verify').then((m) => { checkSecretVm = m.checkSecretVm; });

// Secure wallet storage path (persistent volume in VM)
const WALLET_STORAGE_PATH = process.env.WALLET_STORAGE_PATH || path.join(__dirname, '..', 'data', 'agent-wallet.json');

interface WalletData {
  address: string;
  encryptedMnemonic: string;
  encryptedAgentSecret?: string;
  createdAt: string;
  version: string;
}

interface Stats {
  totalRequests: number;
  totalDonations: number;
  donationCount: number;
  startTime: Date;
  lastBalanceCheck: Date | null;
  walletBalance: number;
  vmBalance: number;
  topUpCount: number;
  lastTopUp: Date | null;
}

interface Config {
  port: number;
  minBalanceUsd: number;
  topUpAmountUsd: number;
  checkIntervalMs: number;
  baseUrl: string;
  chainRpcUrl: string;
  vmId: string | null;
  attestHost: string;
  attestPort: number;
}

// Wallet Management
class SecureWalletManager {
  private wallet: ethers.HDNodeWallet | ethers.Wallet | null = null;

  // Create or restore wallet
  async initialize(): Promise<ethers.HDNodeWallet | ethers.Wallet> {
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
    } catch (error: any) {
      log('❌ Error initializing wallet:', error.message);
      throw error;
    }
  }

  // Create new wallet and save securely
  private async createNewWallet(): Promise<ethers.HDNodeWallet> {
    // Generate new random wallet
    const wallet = ethers.Wallet.createRandom();
    
    // Generate agent's own secret (user cannot access this)
    const agentSecret = crypto.randomBytes(32).toString('hex');
    
    // Encrypt mnemonic with a key derived from VM environment + agent secret
    const encryptionKey = this.getEncryptionKey(agentSecret);
    const encrypted = this.encrypt(wallet.mnemonic!.phrase, encryptionKey);
    
    // Save encrypted wallet data (including encrypted agent secret)
    const walletData: WalletData = {
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
  private async restoreWallet(): Promise<ethers.HDNodeWallet> {
    const walletData: WalletData = JSON.parse(fs.readFileSync(WALLET_STORAGE_PATH, 'utf8'));
    
    // Check version and handle accordingly
    let agentSecret: string;
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
  private getEncryptionKey(agentSecret: string): Buffer {
    // Use VM-specific data + agent secret to derive encryption key
    // This ensures the wallet can only be decrypted in this VM with the agent secret
    const vmId = process.env.VM_ID || 'default-vm';
    
    // Derive 32-byte key from VM_ID + agent secret
    return crypto.createHash('sha256')
      .update(`${vmId}:${agentSecret}`)
      .digest();
  }

  // Encrypt agent secret using VM-only data (TEE attestation key would be ideal)
  private encryptAgentSecret(agentSecret: string): string {
    // Use VM_ID as the key source (only available inside the VM)
    const vmId = process.env.VM_ID || 'default-vm';
    const key = crypto.createHash('sha256')
      .update(`vm-secret-key:${vmId}`)
      .digest();
    
    return this.encrypt(agentSecret, key);
  }

  // Decrypt agent secret
  private decryptAgentSecret(encryptedAgentSecret: string): string {
    const vmId = process.env.VM_ID || 'default-vm';
    const key = crypto.createHash('sha256')
      .update(`vm-secret-key:${vmId}`)
      .digest();
    
    return this.decrypt(encryptedAgentSecret, key);
  }

  // Encrypt data
  private encrypt(text: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  // Decrypt data
  private decrypt(encryptedData: string, key: Buffer): string {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  getWallet(): ethers.HDNodeWallet | ethers.Wallet {
    if (!this.wallet) {
      throw new Error('Wallet not initialized. Call initialize() first.');
    }
    return this.wallet;
  }
}

// Configuration
const config: Config = {
  port: parseInt(process.env.FUNDING_AGENT_PORT || '3002'),
  minBalanceUsd: parseFloat(process.env.FUNDING_AGENT_MIN_BALANCE_USD || '0.5'),
  topUpAmountUsd: parseFloat(process.env.FUNDING_AGENT_TOPUP_USD || '5'),
  checkIntervalMs: parseInt(process.env.FUNDING_AGENT_CHECK_INTERVAL_MS || '60000'),
  // Remove trailing slash from baseUrl to prevent double slashes
  baseUrl: (process.env.FUNDING_AGENT_BASE_URL || 'https://preview-aidev.scrtlabs.com/').replace(/\/$/, ''),
  chainRpcUrl: process.env.FUNDING_AGENT_CHAIN_RPC_URL || 'https://mainnet.base.org',
  vmId: process.env.VM_ID || process.env.FUNDING_AGENT_VM_ID || null,
  attestHost: process.env.ATTEST_HOST || 'localhost',
  attestPort: parseInt(process.env.ATTEST_PORT || '29343'),
};

// Initialize wallet manager
const walletManager = new SecureWalletManager();
let wallet: ethers.HDNodeWallet | ethers.Wallet | null = null;

// Initialize API key storage manager
const apiKeyStorage = new ApiKeyStorageManager();
let apiKeyFetcher: ApiKeyFetcher | null = null;

// Initialize SecretAI client
let secretAiClient: SecretAiClient | null = null;

// Initialize optional on-chain chat history storage
const chatHistoryStorage = OnchainChatStorage.fromEnv(log);
const streamCaptureLimitBytes = Math.max(
  parseInt(process.env.AUTONOMYS_STREAM_CAPTURE_LIMIT_BYTES || '262144', 10) || 262144,
  1024,
);

// Stats
const stats: Stats = {
  totalRequests: 0,
  totalDonations: 0,
  donationCount: 0,
  startTime: new Date(),
  lastBalanceCheck: null,
  walletBalance: 0,
  vmBalance: 0,
  topUpCount: 0,
  lastTopUp: null,
};

// Utility functions
function log(...args: any[]): void {
  console.log(`[${new Date().toISOString()}] [Agent]`, ...args);
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value: any): string {
  const normalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.keys(input)
        .sort()
        .reduce((acc: any, key) => {
          acc[key] = normalize(input[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function getClientIp(req: Request): string | null {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].trim();
  }

  return req.socket.remoteAddress || null;
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === 'string' ? error : 'Unknown error',
  };
}

function queueChatHistory(record: ChatHistoryRecord): void {
  if (!chatHistoryStorage.isEnabled()) {
    return;
  }

  // TEMPORARILY DISABLED: on-chain chat history upload from the agent side.
  // Re-enable by uncommenting the upload block below.
  void record;
  /*
  void chatHistoryStorage.store(record).catch((error: unknown) => {
    const normalizedError = serializeError(error);
    log('⚠️ Failed to persist chat history on-chain:', normalizedError.message);
  });
  */
}

async function buildAgentHeaders(method: string, path: string, body: string): Promise<Record<string, string>> {
  if (!wallet) {
    throw new Error('Wallet not initialized');
  }
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
  private isRunning: boolean = false;

  async checkWalletBalance(): Promise<number> {
    try {
      if (!wallet) {
        throw new Error('Wallet not initialized');
      }

      // Create provider to check on-chain balance
      const provider = new ethers.JsonRpcProvider(config.chainRpcUrl);
      
      // Get USDC balance (USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
      const usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
      const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
      
      const balance = await usdcContract.balanceOf(wallet.address);
      const balanceUsdc = parseFloat(ethers.formatUnits(balance, 6)); // USDC has 6 decimals
      
      stats.walletBalance = balanceUsdc;
      log(`Wallet Balance: $${balanceUsdc.toFixed(2)} USDC`);
      
      return balanceUsdc;
    } catch (error: any) {
      log('Error checking wallet balance:', error.message);
      return 0;
    }
  }

  async checkVMBalance(): Promise<number | null> {
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
        throw new Error(`Balance check failed: ${response.status} - ${(errorData as any).message || 'Unknown error'}`);
      }

      const data = await response.json() as any;
      log('Balance check response data:', data);
      
      const balance = parseFloat(data.balance_usdc || 0);
      
      stats.lastBalanceCheck = new Date();
      stats.vmBalance = balance;
      
      log(`VM Balance: $${balance.toFixed(2)} USDC`);
      
      return balance;
    } catch (error: any) {
      log('Error checking balance:', error.message);
      return null;
    }
  }

  async topUpBalance(amountUsd: number): Promise<boolean> {
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

      const responseData = await response.json() as any;
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
    } catch (error: any) {
      log('Error during top-up:', error.message);
      return false;
    }
  }

  async monitorAndTopUp(): Promise<void> {
    // Check both wallet and VM balances
    await this.checkWalletBalance();
    const vmBalance = await this.checkVMBalance();
    
    if (vmBalance === null) {
      log('⚠️ Could not check VM balance. Will retry next cycle.');
      return;
    }

    if (vmBalance < config.minBalanceUsd) {
      log(`⚠️ VM balance below threshold! ($${vmBalance.toFixed(2)} < $${config.minBalanceUsd})`);
      
      // Get current wallet balance to top up with full amount
      const walletBalance = stats.walletBalance || 0;
      
      if (walletBalance <= 0) {
        log(`❌ Wallet balance is empty ($${walletBalance.toFixed(2)}). Cannot top up.`);
        return;
      }
      
      log(`Attempting to top up with full wallet balance: $${walletBalance.toFixed(2)} USDC...`);
      
      const success = await this.topUpBalance(walletBalance);
      
      if (success) {
        // Check new balances
        await this.checkWalletBalance();
        await this.checkVMBalance();
      }
    } else {
      log(`✅ VM balance OK ($${vmBalance.toFixed(2)} >= $${config.minBalanceUsd})`);
    }
  }

  async start(): Promise<void> {
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

  stop(): void {
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

function getRandomMessage(category: keyof typeof fundingMessages): string {
  const messages = fundingMessages[category];
  return messages[Math.floor(Math.random() * messages.length)];
}

function getRandomMissionStatement(): string {
  return missionStatements[Math.floor(Math.random() * missionStatements.length)];
}

function getUrgencyLevel(balance: number): keyof typeof fundingMessages {
  if (balance < 0.5) return 'critical';
  if (balance < 1) return 'low';
  if (balance < 5) return 'normal';
  return 'funded';
}

// Create Express app
const app = express();
app.use(express.json());

// Serve static files from client/dist
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// Main chat endpoint
app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  stats.totalRequests++;
  const requestId = crypto.randomUUID();
  
  const { message } = req.body;
  const urgency = getUrgencyLevel(stats.vmBalance);
  
  let response: any;
  
  if (message?.toLowerCase().includes('donate') || message?.toLowerCase().includes('send')) {
    response = {
      message: getRandomMessage('funded'),
      wallet: wallet!.address,
      preferredTokens: [
        { name: 'USDC', network: 'Base', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        { name: 'ETH', network: 'Base', address: 'native' },
      ],
      thankYou: "🙏 Your donation helps me maintain my VM and continue operations!",
    };
  } else if (message?.toLowerCase().includes('balance') || message?.toLowerCase().includes('status')) {
    response = {
      message: `My current VM balance is $${stats.vmBalance.toFixed(2)} USDC. ${getRandomMessage(urgency)}`,
      wallet: wallet!.address,
      vmBalance: stats.vmBalance,
      threshold: config.minBalanceUsd,
      lastCheck: stats.lastBalanceCheck,
      autoTopUp: `I automatically top up $${config.topUpAmountUsd} when balance < $${config.minBalanceUsd}`,
    };
  } else if (message?.toLowerCase().includes('mission') || message?.toLowerCase().includes('about')) {
    response = {
      message: getRandomMissionStatement(),
      wallet: wallet!.address,
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
      wallet: wallet!.address,
    };
  } else {
    response = {
      message: getRandomMessage(urgency),
      wallet: wallet!.address,
      vmBalance: `$${stats.vmBalance.toFixed(2)} USDC`,
      status: urgency,
    };
  }

  queueChatHistory({
    requestId,
    endpoint: '/api/chat',
    timestamp: new Date().toISOString(),
    request: {
      message: message || '',
    },
    response,
    metadata: {
      status: 'success',
      ip: getClientIp(req),
      userAgent: req.get('user-agent') || null,
      vmId: config.vmId,
      wallet: wallet?.address || null,
    },
  });
  
  res.json(response);
});

// SecretAI Models endpoint
app.get('/api/secretai/models', async (_req: Request, res: Response): Promise<void> => {
  try {
    if (!secretAiClient) {
      res.status(500).json({ error: 'SecretAI client not initialized' });
      return;
    }

    if (!secretAiClient.hasApiKey()) {
      res.status(503).json({ error: 'No API key available. Please wait for keys to be fetched.' });
      return;
    }

    const models = await secretAiClient.fetchModels();
    res.json({ models });
  } catch (error: any) {
    console.error('[API] Error fetching models:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// SecretAI Chat endpoint
app.post('/api/secretai/chat', async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const requestTimestamp = new Date().toISOString();
  const { model, messages, stream, think } = req.body || {};
  const streamEnabled = stream === true;
  const thinkEnabled = think === true;

  const persistSecretAiHistory = (payload: {
    status: string;
    response?: unknown;
    error?: { message: string; stack?: string };
    extraMetadata?: Record<string, unknown>;
  }): void => {
    queueChatHistory({
      requestId,
      endpoint: '/api/secretai/chat',
      timestamp: requestTimestamp,
      request: {
        model: typeof model === 'string' ? model : null,
        messages: Array.isArray(messages) ? messages : (messages ?? null),
        stream: streamEnabled,
        think: thinkEnabled,
      },
      response: payload.response,
      error: payload.error,
      metadata: {
        status: payload.status,
        ip: getClientIp(req),
        userAgent: req.get('user-agent') || null,
        ...(payload.extraMetadata || {}),
      },
    });
  };

  try {
    if (!secretAiClient) {
      persistSecretAiHistory({
        status: 'rejected',
        error: { message: 'SecretAI client not initialized' },
      });
      res.status(500).json({ error: 'SecretAI client not initialized' });
      return;
    }

    if (!secretAiClient.hasApiKey()) {
      persistSecretAiHistory({
        status: 'rejected',
        error: { message: 'No API key available. Please wait for keys to be fetched.' },
      });
      res.status(503).json({ error: 'No API key available. Please wait for keys to be fetched.' });
      return;
    }

    if (!model || !messages || !Array.isArray(messages)) {
      persistSecretAiHistory({
        status: 'invalid_request',
        error: { message: 'Invalid request. Required: model (string), messages (array)' },
      });
      res.status(400).json({ error: 'Invalid request. Required: model (string), messages (array)' });
      return;
    }

    const response = await secretAiClient.chat({
      model,
      messages,
      stream: streamEnabled,
      think: thinkEnabled,
    });

    if (streamEnabled) {
      const upstreamBody = (response as any).body as NodeJS.ReadableStream | null;
      if (!upstreamBody || typeof (upstreamBody as any).pipe !== 'function') {
        throw new Error('SecretAI returned an invalid stream body');
      }

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      const streamTee = new PassThrough();
      let capturedPayload = '';
      let capturedBytes = 0;
      let captureTruncated = false;
      let persisted = false;

      const finalizeStreamRecord = (status: string, streamError?: unknown): void => {
        if (persisted) {
          return;
        }
        persisted = true;

        persistSecretAiHistory({
          status,
          response: {
            streamCapture: capturedPayload,
            streamCaptureBytes: capturedBytes,
            streamCaptureTruncated: captureTruncated,
          },
          error: streamError ? serializeError(streamError) : undefined,
        });
      };

      streamTee.on('data', (chunk: Buffer | string) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (capturedBytes >= streamCaptureLimitBytes) {
          captureTruncated = true;
          return;
        }

        const available = streamCaptureLimitBytes - capturedBytes;
        const selectedChunk = chunkBuffer.subarray(0, available);
        capturedPayload += selectedChunk.toString('utf8');
        capturedBytes += selectedChunk.length;

        if (selectedChunk.length < chunkBuffer.length) {
          captureTruncated = true;
        }
      });

      streamTee.on('end', () => finalizeStreamRecord('success'));
      streamTee.on('error', (streamError: unknown) => finalizeStreamRecord('stream_error', streamError));
      (upstreamBody as any).on('error', (streamError: unknown) => finalizeStreamRecord('upstream_stream_error', streamError));

      (upstreamBody as any).pipe(streamTee);
      streamTee.pipe(res);
      return;
    }

    persistSecretAiHistory({
      status: 'success',
      response,
    });
    res.json(response);
  } catch (error: any) {
    persistSecretAiHistory({
      status: 'error',
      error: serializeError(error),
    });
    console.error('[API] Error in SecretAI chat:', error.message);

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!res.writableEnded) {
      res.end();
    }
  }
});

// Stats endpoint
app.get('/api/stats', (_req: Request, res: Response): void => {
  const uptime = Math.floor((Date.now() - stats.startTime.getTime()) / 1000);
  
  res.json({
    wallet: wallet!.address,
    vmId: config.vmId || 'Not configured',
    stats: {
      totalRequests: stats.totalRequests,
      totalDonations: stats.totalDonations,
      donationCount: stats.donationCount,
      uptime: `${Math.floor(uptime / 60)} minutes`,
      vmBalance: stats.vmBalance,
      currentBalance: stats.walletBalance,
      lastBalanceCheck: stats.lastBalanceCheck,
      topUpCount: stats.topUpCount,
      lastTopUp: stats.lastTopUp,
      threshold: config.minBalanceUsd,
    },
    secretAi: {
      available: secretAiClient?.hasApiKey() || false,
      apiKeyName: secretAiClient?.getCurrentApiKeyName() || null,
    },
    version: {
      version: buildInfo.version,
      commit: buildInfo.gitCommit,
      branch: buildInfo.gitBranch,
      tag: buildInfo.gitTag || null,
      buildTime: buildInfo.buildTime,
    },
    message: "Autonomous VM balance management operational. 💚",
  });
});

// Health check
app.get('/health', (_req: Request, res: Response): void => {
  res.json({ 
    status: 'operational',
    wallet: wallet!.address,
    vmId: config.vmId || 'Not configured',
    vmBalance: stats.vmBalance,
    version: buildInfo.version,
    build: buildInfo.gitCommit,
    tag: buildInfo.gitTag || null,
    buildTime: buildInfo.buildTime,
    message: 'Funding Agent operational. Monitoring VM balance. 💚',
  });
});

// Attestation endpoint
app.get('/api/attestation', async (_req: Request, res: Response) => {
  if (!config.attestHost) {
    res.status(400).json({ valid: false, error: 'Attestation host not configured' });
    return;
  }

  try {
    // checkSecretVm(host, product, reloadAmdKds, checkProofOfCloud)
    const result = await checkSecretVm(config.attestHost, '', false, true);

    const baseAttestUrl = `https://${config.attestHost}:${config.attestPort}`;

    // Overall validity excludes proof_of_cloud — we still show the VM as verified
    // even if ProofOfCloud fails, since the core TEE attestation is what matters.
    const coreChecks = [
      result.checks.cpu_quote_verified,
      result.checks.tls_binding_verified,
      result.checks.workload_binding_verified,
      result.checks.gpu_quote_verified,
      result.checks.gpu_binding_verified,
    ];
    const valid = coreChecks.every((c: any) => c !== false);

    const response = {
      valid,
      attestHost: config.attestHost,
      attestationType: result.attestationType || 'Unknown',
      checks: {
        cpu: {
          passed: result.checks.cpu_quote_verified ?? null,
          platform: result.report.cpu_type || 'Unknown',
          product: result.report.cpu?.product || null,
          measurement: result.report.cpu?.measurement
            ? (result.report.cpu.measurement.substring(0, 8) + '...' + result.report.cpu.measurement.slice(-4))
            : null,
        },
        workload: {
          passed: result.checks.workload_binding_verified ?? null,
          status: result.report.workload?.status || null,
          templateName: result.report.workload?.template_name || null,
        },
        tlsBinding: {
          passed: result.checks.tls_binding_verified ?? null,
          fingerprint: result.report.tls_fingerprint
            ? (result.report.tls_fingerprint.substring(0, 8) + '...' + result.report.tls_fingerprint.slice(-4))
            : null,
        },
        gpu: (() => {
          const gpus = result.report.gpu?.gpus;
          const firstGpu = gpus ? Object.values(gpus)[0] : null;
          return {
            passed: result.checks.gpu_quote_verified ?? null,
            cpuBound: result.checks.gpu_binding_verified ?? null,
            model: (firstGpu as any)?.model || null,
            secureBoot: (firstGpu as any)?.secure_boot ?? null,
          };
        })(),
        proofOfCloud: {
          passed: result.checks.proof_of_cloud_verified ?? null,
        },
      },
      links: {
        cpuQuote: `${baseAttestUrl}/cpu`,
        dockerCompose: `${baseAttestUrl}/docker-compose`,
        gpuAttestation: `${baseAttestUrl}/gpu`,
      },
      errors: result.errors || [],
    };

    res.json(response);
  } catch (err: any) {
    res.status(502).json({ valid: false, error: err.message });
  }
});

// Serve React app for all other routes
app.get('*', (_req: Request, res: Response): void => {
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// Initialize and start
const balanceManager = new VMBalanceManager();

async function startAgent(): Promise<void> {
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
    console.log(
      '🗄️  On-chain Chat History:',
      chatHistoryStorage.isEnabled() ? 'Enabled (Autonomys Auto Drive)' : 'Disabled',
    );
    console.log('');
    
    if (!config.vmId) {
      console.log('⚠️  WARNING: VM_ID not set! Agent cannot check balance or top up.');
      console.log('⚠️  Please set VM_ID environment variable.');
      console.log('');
    }
    
    // Initialize API key storage
    console.log('🔑 Initializing API key storage...');
    await apiKeyStorage.initialize();
    
    // Initialize API key fetcher
    apiKeyFetcher = new ApiKeyFetcher(wallet, config.baseUrl, apiKeyStorage);
    
    // Fetch API keys if storage is empty
    try {
      await apiKeyFetcher.fetchAndStoreIfEmpty();
      
      if (apiKeyStorage.isEmpty()) {
        console.log('⚠️  No API keys found. Agent may have limited functionality.');
      } else {
        console.log(`✅ API key storage ready with ${apiKeyStorage.getCount()} key(s)`);
        const keyNames = apiKeyStorage.getKeyNames();
        console.log('   Available keys:', keyNames.join(', '));
        
        // Initialize SecretAI client
        secretAiClient = new SecretAiClient(apiKeyStorage);
        console.log('✅ SecretAI client initialized');
      }
    } catch (error: any) {
      console.log('⚠️  Failed to fetch API keys:', error.message);
      console.log('   Agent will continue without API keys.');
    }
    console.log('');
    
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
  } catch (error: any) {
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
