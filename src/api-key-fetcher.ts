import { ethers } from 'ethers';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { ApiKeyStorageManager } from './api-key-storage.js';

interface ApiKeyDetail {
  api_key: string;
  name: string;
  created: number;
}

interface ApiKeysResponse {
  api_keys: ApiKeyDetail[];
  error?: string;
}

/**
 * API Key Fetcher
 * Fetches API keys from the devportal endpoint using agent authentication
 */
export class ApiKeyFetcher {
  private wallet: ethers.HDNodeWallet | ethers.Wallet;
  private baseUrl: string;
  private storage: ApiKeyStorageManager;

  constructor(
    wallet: ethers.HDNodeWallet | ethers.Wallet,
    baseUrl: string,
    storage: ApiKeyStorageManager
  ) {
    this.wallet = wallet;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.storage = storage;
  }

  /**
   * Generate SHA256 hash
   */
  private sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  /**
   * Build authentication headers for agent requests
   */
  private async buildAgentHeaders(method: string, path: string, body: string): Promise<Record<string, string>> {
    const timestamp = Date.now().toString();
    const payload = `${method}${path}${body}${timestamp}`;
    const requestHash = this.sha256Hex(payload);
    const signature = await this.wallet.signMessage(ethers.getBytes(`0x${requestHash}`));

    return {
      'x-agent-address': this.wallet.address,
      'x-agent-signature': signature,
      'x-agent-timestamp': timestamp,
    };
  }

  /**
   * Fetch API keys from the devportal endpoint
   */
  async fetchApiKeys(): Promise<ApiKeyDetail[]> {
    try {
      const method = 'GET';
      const path = '/api/agent/api-key';
      const url = `${this.baseUrl}${path}`;
      const body = '';

      console.log(`[ApiKeyFetcher] Fetching API keys from: ${url}`);

      const headers = await this.buildAgentHeaders(method, path, body);

      const response = await fetch(url, {
        method,
        headers,
      });

      console.log(`[ApiKeyFetcher] Response status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[ApiKeyFetcher] Error response:', errorData);
        throw new Error(`Failed to fetch API keys: ${response.status} - ${(errorData as any).message || 'Unknown error'}`);
      }

      const data = await response.json() as ApiKeysResponse;

      if (data.error) {
        throw new Error(`API returned error: ${data.error}`);
      }

      console.log(`[ApiKeyFetcher] Successfully fetched ${data.api_keys?.length || 0} API key(s)`);

      return data.api_keys || [];
    } catch (error: any) {
      console.error('[ApiKeyFetcher] Error fetching API keys:', error.message);
      throw error;
    }
  }

  /**
   * Fetch and store API keys
   * Only fetches if storage is empty
   */
  async fetchAndStoreIfEmpty(): Promise<void> {
    try {
      // Check if storage already has keys
      if (!this.storage.isEmpty()) {
        console.log(`[ApiKeyFetcher] Storage already contains ${this.storage.getCount()} API key(s), skipping fetch`);
        return;
      }

      console.log('[ApiKeyFetcher] Storage is empty, fetching API keys from endpoint...');

      // Fetch API keys from endpoint
      const apiKeys = await this.fetchApiKeys();

      if (apiKeys.length === 0) {
        console.log('[ApiKeyFetcher] No API keys found on endpoint');
        return;
      }

      // Store each API key
      for (const keyDetail of apiKeys) {
        await this.storage.setKey(keyDetail.name, keyDetail.api_key);
        console.log(`[ApiKeyFetcher] Stored API key: ${keyDetail.name}`);
      }

      console.log(`[ApiKeyFetcher] ✅ Successfully stored ${apiKeys.length} API key(s)`);
    } catch (error: any) {
      console.error('[ApiKeyFetcher] Failed to fetch and store API keys:', error.message);
      throw error;
    }
  }

  /**
   * Force refresh API keys from endpoint
   * Clears existing storage and fetches fresh keys
   */
  async refreshApiKeys(): Promise<void> {
    try {
      console.log('[ApiKeyFetcher] Refreshing API keys from endpoint...');

      // Fetch API keys from endpoint
      const apiKeys = await this.fetchApiKeys();

      if (apiKeys.length === 0) {
        console.log('[ApiKeyFetcher] No API keys found on endpoint');
        return;
      }

      // Clear existing storage
      await this.storage.clearAll();

      // Store each API key
      for (const keyDetail of apiKeys) {
        await this.storage.setKey(keyDetail.name, keyDetail.api_key);
        console.log(`[ApiKeyFetcher] Stored API key: ${keyDetail.name}`);
      }

      console.log(`[ApiKeyFetcher] ✅ Successfully refreshed ${apiKeys.length} API key(s)`);
    } catch (error: any) {
      console.error('[ApiKeyFetcher] Failed to refresh API keys:', error.message);
      throw error;
    }
  }
}
