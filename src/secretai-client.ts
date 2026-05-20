import { ethers } from 'ethers';
import crypto from 'crypto';
import fetch from 'node-fetch';

interface SecretAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface SecretAiChatOptions {
  model: string;
  messages: SecretAiChatMessage[];
  stream?: boolean;
  think?: boolean;
}

interface SecretAiChatResponse {
  message?: { content?: string; thinking?: string };
  response?: string;
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * SecretAI Client
 * Handles communication with SecretAI API using wallet-signed agent headers
 */
export class SecretAiClient {
  private wallet: ethers.HDNodeWallet | ethers.Wallet;
  private baseUrl: string;

  constructor(
    wallet: ethers.HDNodeWallet | ethers.Wallet,
    baseUrl: string = 'https://ovh1.scrtlabs.com:21434'
  ) {
    this.wallet = wallet;
    this.baseUrl = baseUrl;
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
    const signaturePath = path.split('?')[0];
    const payload = `${method}${signaturePath}${body}${timestamp}`;
    const requestHash = this.sha256Hex(payload);
    const signature = await this.wallet.signMessage(ethers.getBytes(`0x${requestHash}`));

    return {
      'x-agent-address': this.wallet.address,
      'x-agent-signature': signature,
      'x-agent-timestamp': timestamp,
    };
  }

  /**
   * Fetch available models from SecretAI
   */
  async fetchModels(): Promise<string[]> {
    try {
      console.log('[SecretAiClient] Fetching models from:', this.baseUrl);
      console.log('[SecretAiClient] Using wallet address:', this.wallet.address);

      const method = 'GET';
      const path = '/api/tags';
      const body = '';
      const headers = await this.buildAgentHeaders(method, path, body);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
      });

      console.log('[SecretAiClient] Models response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.error('[SecretAiClient] Error response:', errorText);
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data: any = await response.json();

      if (data && Array.isArray(data.models)) {
        console.log('[SecretAiClient] Found', data.models.length, 'models');
        return data.models.map((m: any) => m.name);
      }

      return [];
    } catch (error: any) {
      console.error('[SecretAiClient] Error fetching models:', error.message);
      throw error;
    }
  }

  /**
   * Send chat request to SecretAI
   */
  async chat(options: SecretAiChatOptions): Promise<SecretAiChatResponse | any> {
    try {
      const method = 'POST';
      const path = '/api/chat';
      const body = JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: options.stream || false,
        think: options.think || false,
      });
      const headers = await this.buildAgentHeaders(method, path, body);

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`SecretAI chat failed: ${response.status} - ${errorText}`);
      }

      if (options.stream) {
        // Return the response for streaming
        return response;
      }

      return await response.json();
    } catch (error: any) {
      console.error('[SecretAiClient] Error in chat:', error.message);
      throw error;
    }
  }

  /**
   * Extract content from chat response
   */
  extractContent(response: SecretAiChatResponse): string {
    if (response.message?.content) {
      return response.message.content;
    }
    if (response.response) {
      return response.response;
    }
    if (response.choices?.[0]?.message?.content) {
      return response.choices[0].message.content;
    }
    return '';
  }

  /**
   * Check if wallet is available
   */
  hasWallet(): boolean {
    return Boolean(this.wallet?.address);
  }

  /**
   * Get current wallet address
   */
  getWalletAddress(): string | null {
    return this.wallet?.address || null;
  }
}
