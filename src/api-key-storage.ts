import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API key storage path (persistent volume in VM)
const API_KEY_STORAGE_PATH = process.env.API_KEY_STORAGE_PATH || path.join(__dirname, '..', 'data', 'api-keys.json');

interface ApiKeyEntry {
  name: string;
  encryptedValue: string;
  createdAt: string;
  lastUsed?: string;
}

interface ApiKeyStorageData {
  keys: Record<string, ApiKeyEntry>;
  version: string;
  updatedAt: string;
}

/**
 * Secure API Key Storage Manager
 * Stores API keys as name-value pairs with encryption
 * Similar pattern to SecureWalletManager
 */
export class ApiKeyStorageManager {
  private keys: Map<string, string> = new Map();
  private encryptionKey: Buffer | null = null;

  /**
   * Initialize the API key storage
   * Creates storage file if it doesn't exist
   */
  async initialize(): Promise<void> {
    try {
      // Generate encryption key from VM environment
      this.encryptionKey = this.getEncryptionKey();

      // Check if storage file exists
      if (fs.existsSync(API_KEY_STORAGE_PATH)) {
        console.log('[ApiKeyStorage] Found existing API key storage, loading...');
        await this.loadKeys();
        console.log(`[ApiKeyStorage] Loaded ${this.keys.size} API key(s)`);
      } else {
        console.log('[ApiKeyStorage] No existing API key storage found, creating new one...');
        await this.createEmptyStorage();
        console.log('[ApiKeyStorage] Empty API key storage created');
      }
    } catch (error: any) {
      console.error('[ApiKeyStorage] Error initializing API key storage:', error.message);
      throw error;
    }
  }

  /**
   * Create empty storage file
   */
  private async createEmptyStorage(): Promise<void> {
    const storageData: ApiKeyStorageData = {
      keys: {},
      version: '1.0',
      updatedAt: new Date().toISOString(),
    };

    // Ensure directory exists
    const dir = path.dirname(API_KEY_STORAGE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to file with restricted permissions
    fs.writeFileSync(API_KEY_STORAGE_PATH, JSON.stringify(storageData, null, 2), { mode: 0o600 });
    console.log('[ApiKeyStorage] Storage file created at:', API_KEY_STORAGE_PATH);
  }

  /**
   * Load API keys from encrypted storage
   */
  private async loadKeys(): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    const storageData: ApiKeyStorageData = JSON.parse(fs.readFileSync(API_KEY_STORAGE_PATH, 'utf8'));

    // Decrypt and load all keys
    for (const [name, entry] of Object.entries(storageData.keys)) {
      try {
        const decryptedValue = this.decrypt(entry.encryptedValue, this.encryptionKey);
        this.keys.set(name, decryptedValue);
      } catch (error: any) {
        console.error(`[ApiKeyStorage] Failed to decrypt key "${name}":`, error.message);
      }
    }
  }

  /**
   * Save API keys to encrypted storage
   */
  private async saveKeys(): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not initialized');
    }

    const keysObject: Record<string, ApiKeyEntry> = {};

    // Encrypt all keys
    for (const [name, value] of this.keys.entries()) {
      keysObject[name] = {
        name,
        encryptedValue: this.encrypt(value, this.encryptionKey),
        createdAt: new Date().toISOString(),
      };
    }

    const storageData: ApiKeyStorageData = {
      keys: keysObject,
      version: '1.0',
      updatedAt: new Date().toISOString(),
    };

    // Write to file with restricted permissions
    fs.writeFileSync(API_KEY_STORAGE_PATH, JSON.stringify(storageData, null, 2), { mode: 0o600 });
  }

  /**
   * Get encryption key from VM environment
   * Uses VM_ID to ensure keys can only be decrypted in this VM
   */
  private getEncryptionKey(): Buffer {
    const vmId = process.env.VM_ID || 'default-vm';
    const vmSecret = process.env.VM_SECRET || 'default-secret-change-me';

    // Derive 32-byte key from VM_ID + VM_SECRET
    return crypto.createHash('sha256')
      .update(`api-keys:${vmId}:${vmSecret}`)
      .digest();
  }

  /**
   * Encrypt data using AES-256-CBC
   */
  private encrypt(text: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt data using AES-256-CBC
   */
  private decrypt(encryptedData: string, key: Buffer): string {
    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * Add or update an API key
   */
  async setKey(name: string, value: string): Promise<void> {
    this.keys.set(name, value);
    await this.saveKeys();
    console.log(`[ApiKeyStorage] API key "${name}" saved (length: ${value.length}, format: ${value.startsWith('sk-') ? 'valid' : 'invalid'})`);
  }

  /**
   * Get an API key by name
   */
  getKey(name: string): string | undefined {
    const key = this.keys.get(name);
    if (key) {
      console.log(`[ApiKeyStorage] Retrieved API key "${name}" (length: ${key.length}, format: ${key.startsWith('sk-') ? 'valid' : 'invalid'})`);
    }
    return key;
  }

  /**
   * Check if an API key exists
   */
  hasKey(name: string): boolean {
    return this.keys.has(name);
  }

  /**
   * Get all API key names
   */
  getKeyNames(): string[] {
    return Array.from(this.keys.keys());
  }

  /**
   * Delete an API key
   */
  async deleteKey(name: string): Promise<boolean> {
    const deleted = this.keys.delete(name);
    if (deleted) {
      await this.saveKeys();
      console.log(`[ApiKeyStorage] API key "${name}" deleted`);
    }
    return deleted;
  }

  /**
   * Check if storage is empty
   */
  isEmpty(): boolean {
    return this.keys.size === 0;
  }

  /**
   * Get count of stored keys
   */
  getCount(): number {
    return this.keys.size;
  }

  /**
   * Clear all API keys
   */
  async clearAll(): Promise<void> {
    this.keys.clear();
    await this.saveKeys();
    console.log('[ApiKeyStorage] All API keys cleared');
  }
}
