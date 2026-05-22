import crypto from 'crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

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

  constructor(options: OnchainChatStorageOptions) {
    this.options = options;
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

  async store(record: ChatHistoryRecord): Promise<string | null> {
    if (!this.options.enabled) {
      return null;
    }

    const objectKey = this.buildObjectKey(record);
    const payload = JSON.stringify({
      version: '1.0',
      storedAt: new Date().toISOString(),
      ...record,
    });

    await this.putObjectWithRetry(objectKey, payload);
    return objectKey;
  }

  private buildObjectKey(record: ChatHistoryRecord): string {
    const eventDate = new Date(record.timestamp);
    const year = String(eventDate.getUTCFullYear());
    const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eventDate.getUTCDate()).padStart(2, '0');
    const safeRequestId = (record.requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${eventDate.getTime()}-${safeRequestId}.json`;

    return [this.options.keyPrefix, year, month, day, fileName].filter(Boolean).join('/');
  }

  private async putObjectWithRetry(objectKey: string, payload: string): Promise<void> {
    const maxAttempts = Math.max(this.options.retryCount, 1);
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        if (attempt > 0) {
          console.log(
            `[OnchainChatStorage] Retry attempt ${attempt + 1}/${maxAttempts} for ${objectKey}`,
          );
        }
        await this.putObject(objectKey, payload);
        return;
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
  }

  private async putObject(objectKey: string, payload: string): Promise<void> {
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const contentType = 'application/octet-stream';
    const { client, bucket } = this.getS3Client();

    console.log(
      `[OnchainChatStorage] Uploading chat history (bucket=${bucket}, key=${objectKey})`,
    );

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: payloadBuffer,
          ContentType: contentType,
          ContentLength: payloadBuffer.length,
        }),
      );
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

    const { client, bucket } = this.getS3Client();
    const prefix = this.options.keyPrefix;

    const allRecords: ChatHistoryRecord[] = [];
    let continuationToken: string | undefined;

    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix + '/',
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const response = await client.send(listCommand);
      const objects = response.Contents || [];

      for (const obj of objects) {
        if (!obj.Key || !obj.Key.endsWith('.json')) continue;

        try {
          const getCommand = new GetObjectCommand({
            Bucket: bucket,
            Key: obj.Key,
          });
          const objResponse = await client.send(getCommand);

          if (objResponse.Body) {
            const bodyString = await this.streamToString(objResponse.Body as Readable);
            const parsed = JSON.parse(bodyString);

            const record: ChatHistoryRecord = {
              requestId: parsed.requestId,
              endpoint: parsed.endpoint,
              timestamp: parsed.timestamp,
              request: parsed.request,
              response: parsed.response,
              error: parsed.error,
              metadata: parsed.metadata,
            };

            allRecords.push(record);
          }
        } catch (err) {
          console.warn(`[OnchainChatStorage] Failed to fetch ${obj.Key}:`, err);
        }
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    let filtered = allRecords;

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

  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
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
