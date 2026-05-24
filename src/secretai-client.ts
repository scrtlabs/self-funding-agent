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

type AuthMethod = 'api-key' | 'wallet-signature';

interface SecretAiClientOptions {
  wallet?: ethers.HDNodeWallet | ethers.Wallet;
  apiKey?: string;
  baseUrl?: string;
  authMethod?: AuthMethod;
}

/**
 * Resolve the appropriate SecretAI base URL based on the model
 */
async function resolveSecretAiBaseUrl(model: string): Promise<string> {
  // Use separate base URL for gpt-oss:120b model
  const normalizedModel = model.toLowerCase().trim();
  if (normalizedModel === 'gpt-oss:120b' || normalizedModel === 'gpt-oss' || normalizedModel === 'gptoss:120b' || normalizedModel === 'gptoss') {
    return 'https://secretai-jedi.scrtlabs.com:21434';
  }
  return 'https://secretai-rytn.scrtlabs.com:21434';
}

/**
 * SecretAI Client
 * Handles communication with SecretAI API using either API key or wallet-signed agent headers
 */
export class SecretAiClient {
  private wallet?: ethers.HDNodeWallet | ethers.Wallet;
  private apiKey?: string;
  private baseUrl: string;
  private authMethod: AuthMethod;

  constructor(options: SecretAiClientOptions) {
    this.wallet = options.wallet;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://ovh1.scrtlabs.com:21434';
    this.authMethod = options.authMethod || 'api-key';

    // Validate authentication configuration
    if (this.authMethod === 'api-key' && !this.apiKey) {
      throw new Error('API key is required when using api-key authentication method');
    }
    if (this.authMethod === 'wallet-signature' && !this.wallet) {
      throw new Error('Wallet is required when using wallet-signature authentication method');
    }
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
    if (this.authMethod === 'api-key') {
      return {
        'Authorization': `Bearer ${this.apiKey}`,
      };
    }

    // wallet-signature method
    if (!this.wallet) {
      throw new Error('Wallet is not available for signature authentication');
    }

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
      if (this.wallet) {
        console.log('[SecretAiClient] Using wallet address:', this.wallet.address);
      } else {
        console.log('[SecretAiClient] Using API key authentication');
      }

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
      // Resolve the appropriate base URL based on the model
      const targetBaseUrl = await resolveSecretAiBaseUrl(options.model);
      
      const method = 'POST';
      const path = '/api/chat';
      const body = JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: options.stream || false,
        think: options.think || false,
      });
      const headers = await this.buildAgentHeaders(method, path, body);

      const response = await fetch(`${targetBaseUrl}${path}`, {
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

  /**
   * Get current authentication method
   */
  getAuthMethod(): AuthMethod {
    return this.authMethod;
  }
}
