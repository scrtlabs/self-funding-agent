import fetch from 'node-fetch';
import { ApiKeyStorageManager } from './api-key-storage.js';

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
 * Handles communication with SecretAI API using stored API keys
 */
export class SecretAiClient {
  private apiKeyStorage: ApiKeyStorageManager;
  private baseUrl: string;
  private defaultApiKeyName: string | null = null;

  constructor(apiKeyStorage: ApiKeyStorageManager, baseUrl: string = 'https://secretai-rytn.scrtlabs.com:21434') {
    this.apiKeyStorage = apiKeyStorage;
    this.baseUrl = baseUrl;
  }

  /**
   * Get the default API key (first available key)
   */
  private getDefaultApiKey(): string | null {
    if (this.defaultApiKeyName && this.apiKeyStorage.hasKey(this.defaultApiKeyName)) {
      return this.apiKeyStorage.getKey(this.defaultApiKeyName) || null;
    }

    // Find first available key
    const keyNames = this.apiKeyStorage.getKeyNames();
    if (keyNames.length === 0) {
      return null;
    }

    this.defaultApiKeyName = keyNames[0];
    return this.apiKeyStorage.getKey(this.defaultApiKeyName) || null;
  }

  /**
   * Fetch available models from SecretAI
   */
  async fetchModels(): Promise<string[]> {
    try {
      const apiKey = this.getDefaultApiKey();
      if (!apiKey) {
        throw new Error('No API key available. Please ensure API keys are fetched and stored.');
      }

      console.log('[SecretAiClient] Fetching models from:', this.baseUrl);
      console.log('[SecretAiClient] API key name:', this.defaultApiKeyName);
      console.log('[SecretAiClient] API key length:', apiKey.length);
      console.log('[SecretAiClient] API key format check:', apiKey.startsWith('sk-') ? 'Valid (sk- prefix)' : 'Invalid format');

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
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
      const apiKey = this.getDefaultApiKey();
      if (!apiKey) {
        throw new Error('No API key available. Please ensure API keys are fetched and stored.');
      }

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          stream: options.stream || false,
          think: options.think || false,
        }),
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
   * Check if API key is available
   */
  hasApiKey(): boolean {
    return this.getDefaultApiKey() !== null;
  }

  /**
   * Get current API key name
   */
  getCurrentApiKeyName(): string | null {
    if (this.defaultApiKeyName) {
      return this.defaultApiKeyName;
    }
    const keyNames = this.apiKeyStorage.getKeyNames();
    return keyNames.length > 0 ? keyNames[0] : null;
  }
}
