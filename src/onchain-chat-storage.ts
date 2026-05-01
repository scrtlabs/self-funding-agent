import crypto from 'crypto';
import fetch from 'node-fetch';

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
}

type Logger = (...args: any[]) => void;

/**
 * Persists chat transcripts to Autonomys Auto Drive via the S3-compatible API.
 * Uses AWS Signature V4 so no extra SDK dependency is required.
 */
export class OnchainChatStorage {
  private readonly options: OnchainChatStorageOptions;

  constructor(options: OnchainChatStorageOptions) {
    this.options = options;
  }

  static fromEnv(logger: Logger = console.log): OnchainChatStorage {
    const endpoint = (process.env.AUTONOMYS_S3_ENDPOINT || '').trim();
    const bucket = (process.env.AUTONOMYS_S3_BUCKET || '').trim();
    const accessKeyId = (process.env.AUTONOMYS_S3_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.AUTONOMYS_S3_SECRET_ACCESS_KEY || '').trim();
    const region = (process.env.AUTONOMYS_S3_REGION || 'us-east-1').trim();
    const keyPrefix = (process.env.AUTONOMYS_CHAT_HISTORY_PREFIX || 'chat-history')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const forcePathStyle = (process.env.AUTONOMYS_S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false';
    const enabledFlag = (process.env.AUTONOMYS_CHAT_HISTORY_ENABLED || 'false').toLowerCase() === 'true';

    const hasRequiredConfig = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
    const enabled = enabledFlag && hasRequiredConfig;

    if (enabledFlag && !hasRequiredConfig) {
      logger('[OnchainChatStorage] AUTONOMYS_CHAT_HISTORY_ENABLED=true but required S3 config is missing. Storage disabled.');
    }

    return new OnchainChatStorage({
      enabled,
      endpoint,
      bucket,
      accessKeyId,
      secretAccessKey,
      region,
      keyPrefix: keyPrefix || 'chat-history',
      forcePathStyle,
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

    await this.putObject(objectKey, payload);
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

  private async putObject(objectKey: string, payload: string): Promise<void> {
    const endpoint = new URL(this.options.endpoint);
    const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '');
    const encodedBucket = this.encodePath(this.options.bucket);
    const encodedKey = this.encodePath(objectKey);

    const objectPath = this.options.forcePathStyle
      ? `/${encodedBucket}/${encodedKey}`
      : `/${encodedKey}`;
    const canonicalUri = `${basePath}${objectPath}` || '/';
    const host = this.options.forcePathStyle
      ? endpoint.host
      : `${this.options.bucket}.${endpoint.host}`;
    const requestUrl = `${endpoint.protocol}//${host}${canonicalUri}`;

    const amzDate = this.toAmzDate(new Date());
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = this.sha256Hex(payload);

    const canonicalHeaders = [
      'content-type:application/json',
      `host:${host}`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${amzDate}`,
    ].join('\n') + '\n';

    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = this.getSignatureKey(
      this.options.secretAccessKey,
      dateStamp,
      this.options.region,
      's3',
    );
    const signature = crypto
      .createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8')
      .digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const response = await fetch(requestUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Host: host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        Authorization: authorization,
      },
      body: payload,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Autonomys upload failed: ${response.status} ${response.statusText} ${errorText}`.trim());
    }
  }

  private toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  }

  private sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private hmacSha256(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
  }

  private getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = this.hmacSha256(`AWS4${secretKey}`, dateStamp);
    const kRegion = this.hmacSha256(kDate, region);
    const kService = this.hmacSha256(kRegion, service);
    return this.hmacSha256(kService, 'aws4_request');
  }

  private encodePath(rawPath: string): string {
    return rawPath
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => this.encodePathSegment(segment))
      .join('/');
  }

  private encodePathSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  }
}
