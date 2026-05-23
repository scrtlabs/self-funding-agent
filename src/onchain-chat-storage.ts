import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';

export interface ChatHistoryRecord {
  requestId: string;
  endpoint: string;
  timestamp: string;
  request: unknown;
  response?: unknown;
  error?: {
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
  sessionId?: string;
  messageIndex?: number;
  cid?: string;
}

interface ChatHistoryIndex {
  records: ChatHistoryRecord[];
  lastUpdated: string;
}

interface OnchainChatStorageOptions {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  keyPrefix: string;
  forcePathStyle: boolean;
  retryCount: number;
  retryBaseDelayMs: number;
}

type Logger = (...args: any[]) => void;

/**
 * Persists chat transcripts to Autonomys Auto Drive via the S3-compatible API.
 * Uses the AWS S3 SDK configured for Auto Drive.
 */
export class OnchainChatStorage {
  private readonly options: OnchainChatStorageOptions;
  private s3Client: S3Client | null = null;
  private s3Bucket: string | null = null;
  private indexPath: string;
  private index: ChatHistoryIndex;

  constructor(options: OnchainChatStorageOptions) {
    this.options = options;
    this.indexPath = process.env.CHAT_HISTORY_INDEX_PATH || path.join(process.cwd(), 'data', 'chat-history-index.json');
    this.index = this.loadIndex();
  }

  static fromEnv(logger: Logger = console.log): OnchainChatStorage {
    let endpoint = (process.env.AUTONOMYS_S3_ENDPOINT || '').trim();
    let bucket = (process.env.AUTONOMYS_S3_BUCKET || '').trim();
    const accessKeyId = (process.env.AUTONOMYS_S3_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.AUTONOMYS_S3_SECRET_ACCESS_KEY || '').trim();
    const region = (process.env.AUTONOMYS_S3_REGION || 'us-east-1').trim();
    const keyPrefix = (process.env.AUTONOMYS_CHAT_HISTORY_PREFIX || 'chat-history')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const forcePathStyleEnv = (process.env.AUTONOMYS_S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';
    const retryCount = Math.max(
      parseInt(process.env.AUTONOMYS_S3_RETRY_COUNT || '3', 10) || 3,
      0,
    );
    const retryBaseDelayMs = Math.max(
      parseInt(process.env.AUTONOMYS_S3_RETRY_BASE_DELAY_MS || '750', 10) || 750,
      100,
    );
    const enabledFlag = (process.env.AUTONOMYS_CHAT_HISTORY_ENABLED || 'false').toLowerCase() === 'true';

    const isBucketUrl = (value: string): boolean => /^https?:\/\//i.test(value);

    if (bucket && isBucketUrl(bucket)) {
      if (endpoint) {
        logger('[OnchainChatStorage] AUTONOMYS_S3_BUCKET is a URL; ignoring AUTONOMYS_S3_ENDPOINT.');
      }
      endpoint = '';
    }

    if (!bucket && endpoint) {
      bucket = endpoint;
      endpoint = '';
    }

    const bucketIsUrl = bucket ? isBucketUrl(bucket) : false;

    if (endpoint && bucket && !bucketIsUrl) {
      try {
        const endpointUrl = new URL(endpoint);
        const endpointPath = endpointUrl.pathname.replace(/^\/+|\/+$/g, '');
        const bucketPath = bucket.replace(/^\/+|\/+$/g, '');
        if (endpointPath && (endpointPath === bucketPath || endpointPath.endsWith(`/${bucketPath}`))) {
          logger('[OnchainChatStorage] Bucket path is already included in endpoint; ignoring AUTONOMYS_S3_BUCKET.');
          bucket = '';
        }
      } catch (error: unknown) {
        logger('[OnchainChatStorage] Invalid AUTONOMYS_S3_ENDPOINT URL; leaving bucket configuration unchanged.');
      }
    }

    const hasRequiredConfig = Boolean(accessKeyId && (endpoint || bucket));
    const enabled = enabledFlag && hasRequiredConfig;

    if (enabledFlag && !hasRequiredConfig) {
      logger('[OnchainChatStorage] AUTONOMYS_CHAT_HISTORY_ENABLED=true but required S3 config is missing. Storage disabled.');
    }

    if (enabledFlag && endpoint && accessKeyId && !secretAccessKey) {
      logger('[OnchainChatStorage] AUTONOMYS_S3_SECRET_ACCESS_KEY is empty. Using SigV4 with empty secret (Auto Drive auth).');
    }

    if (enabledFlag) {
      const maskedAccessKey = accessKeyId
        ? `${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}`
        : '(empty)';
      logger('[OnchainChatStorage] Config snapshot', {
        enabledFlag,
        endpoint: endpoint || '(empty)',
        bucket: bucket || '(empty)',
        accessKeyId: maskedAccessKey,
        accessKeyLength: accessKeyId.length,
        secretKeyLength: secretAccessKey.length,
        region,
        keyPrefix: keyPrefix || 'chat-history',
        forcePathStyle: forcePathStyleEnv || !bucket,
      });
    }

    return new OnchainChatStorage({
      enabled,
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region,
      keyPrefix: keyPrefix || 'chat-history',
      forcePathStyle: forcePathStyleEnv || !bucket,
      retryCount,
      retryBaseDelayMs,
    });
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  private loadIndex(): ChatHistoryIndex {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = fs.readFileSync(this.indexPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn('[OnchainChatStorage] Failed to load index:', err);
    }
    return { records: [], lastUpdated: new Date().toISOString() };
  }

  private saveIndex(): void {
    try {
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.index.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
    } catch (err) {
      console.warn('[OnchainChatStorage] Failed to save index:', err);
    }
  }

  async store(record: ChatHistoryRecord): Promise<string | null> {
    if (!this.options.enabled) {
      return null;
    }

    const objectKey = this.buildObjectKey(record);
    
    // Create lightweight payload - remove system prompts and unnecessary data
    const lightweightPayload = this.createLightweightPayload(record);
    const payload = JSON.stringify(lightweightPayload, null, 2);

    const cid = await this.putObjectWithRetry(objectKey, payload);
    
    // Store CID in the record
    if (cid) {
      record.cid = cid;
    }
    
    // Add to local index
    this.index.records.push(record);
    this.saveIndex();
    
    return objectKey;
  }

  private createLightweightPayload(record: ChatHistoryRecord): any {
    const request = record.request as any;
    const response = record.response as any;
    
    // Extract only user messages and assistant responses, filter out system prompts
    let cleanMessages = [];
    if (request?.messages && Array.isArray(request.messages)) {
      cleanMessages = request.messages
        .filter((msg: any) => msg.role !== 'system')
        .map((msg: any) => ({
          role: msg.role,
          content: msg.content,
        }));
    }
    
    // Extract assistant response content
    let assistantResponse = null;
    if (response?.message?.content) {
      assistantResponse = {
        content: response.message.content,
        thinking: response.message.thinking || undefined,
      };
    } else if (response?.response) {
      assistantResponse = { content: response.response };
    } else if (response?.choices?.[0]?.message?.content) {
      assistantResponse = { content: response.choices[0].message.content };
    }
    
    return {
      version: '2.0',
      sessionId: record.sessionId || record.metadata?.sessionId || null,
      messageIndex: record.messageIndex || null,
      timestamp: record.timestamp,
      messages: cleanMessages,
      response: assistantResponse,
      model: request?.model || null,
      error: record.error || null,
    };
  }

  private buildObjectKey(record: ChatHistoryRecord): string {
    const eventDate = new Date(record.timestamp);
    const year = String(eventDate.getUTCFullYear());
    const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eventDate.getUTCDate()).padStart(2, '0');
    
    // Extract session ID from record or metadata
    const sessionId = record.sessionId || (record.metadata?.sessionId as string) || 'no-session';
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    
    // Use message index if available, otherwise use timestamp
    const messageIndex = record.messageIndex !== undefined ? String(record.messageIndex).padStart(4, '0') : null;
    
    // Build filename: sessionId-messageIndex-timestamp.json or sessionId-timestamp-requestId.json
    let fileName: string;
    if (messageIndex !== null) {
      fileName = `${safeSessionId}-${messageIndex}-${eventDate.getTime()}.json`;
    } else {
      const safeRequestId = (record.requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
      fileName = `${safeSessionId}-${eventDate.getTime()}-${safeRequestId}.json`;
    }

    return [this.options.keyPrefix, year, month, day, fileName].filter(Boolean).join('/');
  }

  private async putObjectWithRetry(objectKey: string, payload: string): Promise<string | null> {
    const maxAttempts = Math.max(this.options.retryCount, 1);
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        if (attempt > 0) {
          console.log(
            `[OnchainChatStorage] Retry attempt ${attempt + 1}/${maxAttempts} for ${objectKey}`,
          );
        }
        const cid = await this.putObject(objectKey, payload);
        return cid;
      } catch (error: unknown) {
        attempt += 1;
        if (attempt >= maxAttempts || !this.shouldRetry(error)) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.warn(
            `[OnchainChatStorage] Upload failed after ${attempt}/${maxAttempts} attempts for ${objectKey}: ${message}`,
          );
          throw error;
        }

        const delay = this.options.retryBaseDelayMs * Math.pow(2, attempt - 1);
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.warn(
          `[OnchainChatStorage] Upload attempt ${attempt}/${maxAttempts} failed for ${objectKey}: ${message}. Retrying in ${delay}ms.`,
        );
        await this.sleep(delay);
      }
    }
    
    return null;
  }

  private async putObject(objectKey: string, payload: string): Promise<string | null> {
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const contentType = 'application/octet-stream';
    const { client, bucket } = this.getS3Client();

    console.log(
      `[OnchainChatStorage] Uploading chat history (bucket=${bucket}, key=${objectKey})`,
    );

    try {
      const response = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: payloadBuffer,
          ContentType: contentType,
          ContentLength: payloadBuffer.length,
        }),
      );
      
      // Extract CID from response headers if available
      const cid = (response as any).ETag?.replace(/"/g, '') || null;
      
      if (cid) {
        console.log(`[OnchainChatStorage] Upload successful, CID: ${cid}`);
      }
      
      return cid;
    } catch (error: unknown) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
      const message = error instanceof Error ? error.message : String(error);
      throw new AutonomysUploadError(`Autonomys upload failed: ${message}`.trim(), status);
    }
  }

  private getS3Client(): { client: S3Client; bucket: string } {
    if (this.s3Client && this.s3Bucket) {
      return { client: this.s3Client, bucket: this.s3Bucket };
    }

    let bucket = this.options.bucket;
    let endpoint = this.options.endpoint;

    if (!bucket && endpoint) {
      bucket = endpoint;
      endpoint = '';
    }

    if (!bucket) {
      throw new Error('Autonomys S3 bucket/endpoint is missing.');
    }

    const bucketIsUrl = /^https?:\/\//i.test(bucket);

    const client = new S3Client({
      region: this.options.region,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
      ...(bucketIsUrl ? { bucketEndpoint: true } : {}),
      ...(bucketIsUrl ? {} : endpoint ? { endpoint, forcePathStyle: this.options.forcePathStyle } : {}),
    });

    this.s3Client = client;
    this.s3Bucket = bucket;

    return { client, bucket };
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof AutonomysUploadError) {
      if (!error.status) {
        return true;
      }
      return error.status >= 500 || error.status === 429;
    }

    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status) {
      return status >= 500 || status === 429;
    }

    return true;
  }

  private sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  async listChatHistory(options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ records: ChatHistoryRecord[]; total: number }> {
    if (!this.options.enabled) {
      return { records: [], total: 0 };
    }

    // Use local index (Autonomys SDK has download issues with webcrypto dependencies)
    // Files are uploaded to Autonomys but we maintain a local index for fast retrieval
    let filtered = [...this.index.records];

    if (options?.startDate) {
      const start = new Date(options.startDate).getTime();
      filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= start);
    }

    if (options?.endDate) {
      const end = new Date(options.endDate).getTime();
      filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= end);
    }

    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const offset = options?.offset || 0;
    const limit = options?.limit || 50;
    const paginated = filtered.slice(offset, offset + limit);

    return { records: paginated, total };
  }
}

class AutonomysUploadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AutonomysUploadError';
    this.status = status;
  }
}
