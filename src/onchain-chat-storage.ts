import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createAutoDriveApi } from '@autonomys/auto-drive';
import { NetworkId } from '@autonomys/auto-utils';
import { AgentMemoryCidManager } from './agent-memory-cid-manager.js';

/**
 * Minimal signer interface (satisfied by ethers.Wallet / ethers.HDNodeWallet).
 * Used to cryptographically sign agent experiences before upload.
 */
export interface ExperienceSigner {
  address: string;
  signMessage(message: string): Promise<string>;
}

/**
 * Header describing an agent experience, mirroring the structure used in
 * autonomys-agents. `previousCid` links this record to the previous one,
 * forming a linked list of the agent's memory.
 */
export interface ExperienceHeader {
  agentVersion: string;
  agentId: string;
  agentAddress?: string;
  timestamp: string;
  previousCid?: string;
}

/**
 * A signed, self-describing agent experience. This is what gets persisted to
 * auto drive instead of a raw conversation transcript.
 */
export interface AgentExperience {
  header: ExperienceHeader;
  data: unknown;
  signature: string;
}

interface ParsedHistoryFileName {
  sessionId: string;
  messageIndex?: number;
  timestamp: string;
}

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
  /**
   * Stable identifier for the agent that produces these records (defaults to VM_ID).
   * It is embedded in the auto drive object key and filename so every record is
   * clearly attributable to this exact agent.
   */
  agentId: string;
  /** Version string recorded in every experience header. */
  agentVersion: string;
  /** Local file used to track the head CID of each session's experience chain. */
  cidStorePath: string;
}

type Logger = (...args: any[]) => void;

/** Normalize an identifier so it is safe to use inside object keys and filenames. */
function sanitizeIdentifier(value: string): string {
  return (value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-agent';
}

/**
 * Persists chat transcripts to Autonomys Auto Drive via the S3-compatible API.
 * Uses the AWS S3 SDK configured for Auto Drive.
 */
export class OnchainChatStorage {
  private readonly options: OnchainChatStorageOptions;
  private s3Client: S3Client | null = null;
  private s3Bucket: string | null = null;
  private autoDriveApi: any = null;
  private signer: ExperienceSigner | null = null;
  private cidManager: AgentMemoryCidManager | null = null;
  private sessionQueues = new Map<string, Promise<void>>();

  constructor(options: OnchainChatStorageOptions) {
    this.options = options;

    // Per-session linked-list tracker for chaining experiences on Auto Drive
    // (head CID per session is tracked in a local JSON file).
    if (options.enabled) {
      this.cidManager = new AgentMemoryCidManager(options.cidStorePath);
    }
    
    // Initialize Auto Drive API if enabled
    if (options.enabled && options.accessKeyId) {
      try {
        this.autoDriveApi = createAutoDriveApi({
          apiKey: options.accessKeyId,
          network: NetworkId.MAINNET,
        });
        console.log('[OnchainChatStorage] Auto Drive API initialized');
      } catch (error) {
        console.warn('[OnchainChatStorage] Failed to initialize Auto Drive API:', error);
      }
    }
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
    const agentId = sanitizeIdentifier(
      process.env.VM_ID || process.env.FUNDING_AGENT_VM_ID || 'unknown-agent',
    );
    const agentVersion = (
      process.env.AGENT_VERSION ||
      process.env.npm_package_version ||
      'unknown'
    ).trim();
    const cidStorePath = (
      process.env.AGENT_MEMORY_CID_PATH || './data/agent-memory-cids.json'
    ).trim();

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
        agentId,
        agentVersion,
        cidStorePath,
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
      agentId,
      agentVersion,
      cidStorePath,
    });
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Provide the agent wallet so experiences can be cryptographically signed.
   * Called once the wallet has been initialized (it is created after this
   * storage instance, which is built from env at module load).
   */
  setSigner(signer: ExperienceSigner | null): void {
    this.signer = signer;
    if (signer) {
      console.log(`[OnchainChatStorage] Experience signer set (${signer.address})`);
    }
  }

  async store(record: ChatHistoryRecord): Promise<string | null> {
    if (!this.options.enabled) {
      return null;
    }

    const sessionKey = this.resolveSessionKey(record);
    return this.withSessionLock(sessionKey, () => this.storeLocked(record, sessionKey));
  }

  private async withSessionLock<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionKey) || Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current, () => current);

    this.sessionQueues.set(sessionKey, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionQueues.get(sessionKey) === queued) {
        this.sessionQueues.delete(sessionKey);
      }
    }
  }

  private async storeLocked(record: ChatHistoryRecord, sessionKey: string): Promise<string | null> {
    const objectKey = this.buildObjectKey(record, sessionKey);

    // Look up the head of this session's experience chain so we can link to it.
    const previous = this.cidManager ? this.cidManager.getLast(sessionKey) : undefined;
    const previousCid = previous?.cid;
    const previousCount = previous?.messageCount ?? 0;

    // Build a signed agent experience (header + data + signature) that stores
    // only the new context for this turn and points back to the previous record.
    const experience = await this.buildExperience(record, previousCid, previousCount);
    const payload = JSON.stringify(experience, null, 2);

    const cid = await this.putObjectWithRetry(objectKey, payload);

    // Store CID in the record and advance this session's chain head.
    if (cid) {
      record.cid = cid;
      if (this.cidManager) {
        // For cumulative-history clients, the new head reflects how many messages
        // have now been captured; for single-message requests we keep the count
        // unchanged so each independent request is stored in full.
        const cumulative = this.cumulativeMessageCount(record);
        const newCount = cumulative ?? previousCount;
        this.cidManager.saveLastCid(sessionKey, cid, newCount);
      }
    }

    return objectKey;
  }

  /**
   * Stable, sanitized per-session key. The same value is used for the linked-list
   * chain and the object key/filename, so they stay consistent.
   */
  private resolveSessionKey(record: ChatHistoryRecord): string {
    const raw = record.sessionId || (record.metadata?.sessionId as string) || 'no-session';
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * Number of cumulative (system-free) messages in the request, or null when the
   * request is not a cumulative conversation array (e.g. /api/chat single message).
   */
  private cumulativeMessageCount(record: ChatHistoryRecord): number | null {
    const request = record.request as any;
    if (!Array.isArray(request?.messages)) {
      return null;
    }
    return request.messages.filter((msg: any) => msg.role !== 'system').length;
  }

  /**
   * Wrap the extracted experience data in a signed envelope:
   *   { header: { agentVersion, agentId, agentAddress, timestamp }, data, signature }
   * The signature is produced by the agent wallet over JSON.stringify({ header, data }),
   * mirroring the experience format used in autonomys-agents.
   */
  private async buildExperience(
    record: ChatHistoryRecord,
    previousCid?: string,
    previousCount = 0,
  ): Promise<AgentExperience> {
    if (!this.signer) {
      throw new Error('Cannot store signed agent experience before wallet signer is initialized.');
    }

    const header: ExperienceHeader = {
      agentVersion: this.options.agentVersion,
      agentId: this.options.agentId,
      agentAddress: this.signer.address,
      timestamp: record.timestamp,
      previousCid,
    };

    const data = this.extractExperienceData(record, previousCount);

    const signature = await this.signer.signMessage(JSON.stringify({ header, data }));

    return { header, data, signature };
  }

  /**
   * Extract the meaningful, system-prompt-free content of a chat exchange.
   * This is the `data` payload of an agent experience.
   */
  private extractExperienceData(record: ChatHistoryRecord, previousCount = 0): any {
    const request = record.request as any;
    const response = record.response as any;

    // Extract only user messages and assistant responses, filter out system prompts
    let cleanMessages: Array<{ role: string; content: unknown }> = [];
    let isCumulative = false;
    if (request?.messages && Array.isArray(request.messages)) {
      isCumulative = true;
      cleanMessages = request.messages
        .filter((msg: any) => msg.role !== 'system')
        .map((msg: any) => ({
          role: msg.role,
          content: msg.content,
        }));
    } else if (typeof request?.message === 'string') {
      // /api/chat sends a single message rather than a conversation array.
      cleanMessages = [{ role: 'user', content: request.message }];
    }

    // Clients (e.g. SecretAI) resend the whole conversation on every turn. To
    // avoid re-storing the entire history each time, keep only the delta: the
    // messages added since the previous experience for this session. Earlier
    // context is reachable by following header.previousCid. Single-message
    // requests are not cumulative, so they are stored in full.
    const newMessages = isCumulative ? cleanMessages.slice(previousCount) : cleanMessages;

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
      schemaVersion: '3.0-experience',
      sessionId: record.sessionId || record.metadata?.sessionId || null,
      messageIndex: record.messageIndex ?? null,
      // Only the new context for this turn; full history = follow previousCid.
      messages: newMessages,
      response: assistantResponse,
      model: request?.model || null,
      error: record.error || null,
    };
  }

  private buildObjectKey(record: ChatHistoryRecord, safeSessionId: string): string {
    const eventDate = new Date(record.timestamp);
    const year = String(eventDate.getUTCFullYear());
    const month = String(eventDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(eventDate.getUTCDate()).padStart(2, '0');

    // Agent identifier (VM_ID) so every record is attributable to this exact agent.
    const agentId = this.options.agentId;

    // safeSessionId is the sanitized session key (same value used for the chain
    // and the on-chain session key), so filename and chain stay consistent.

    // Use message index if available, otherwise use timestamp
    const messageIndex = record.messageIndex !== undefined ? String(record.messageIndex).padStart(4, '0') : null;

    // Build filename with the agent id prefixed so the name itself identifies the producer:
    //   agentId-sessionId-messageIndex-timestamp.json
    //   agentId-sessionId-timestamp-requestId.json
    let fileName: string;
    if (messageIndex !== null) {
      fileName = `${agentId}-${safeSessionId}-${messageIndex}-${eventDate.getTime()}.json`;
    } else {
      const safeRequestId = (record.requestId || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
      fileName = `${agentId}-${safeSessionId}-${eventDate.getTime()}-${safeRequestId}.json`;
    }

    // Also namespace the path by agent id so records are grouped per agent.
    return [this.options.keyPrefix, agentId, year, month, day, fileName].filter(Boolean).join('/');
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

  private parseHistoryFileName(fileName: string): ParsedHistoryFileName | null {
    const indexedMatch = fileName.match(/^(.+)-(\d{4})-(\d+)\.json$/);
    const fallbackMatch = indexedMatch ? null : fileName.match(/^(.+)-(\d+)-([a-zA-Z0-9_-]+)\.json$/);
    const match = indexedMatch || fallbackMatch;

    if (!match) {
      return null;
    }

    const [, head, secondPart, thirdPart] = match;
    const agentPrefix = `${this.options.agentId}-`;
    const sessionId = head.startsWith(agentPrefix) ? head.slice(agentPrefix.length) : head;
    const timestampStr = indexedMatch ? thirdPart : secondPart;
    const timestampMs = Number(timestampStr);

    if (!Number.isFinite(timestampMs)) {
      return null;
    }

    return {
      sessionId,
      messageIndex: indexedMatch ? parseInt(secondPart, 10) : undefined,
      timestamp: new Date(timestampMs).toISOString(),
    };
  }

  async listChatHistory(options?: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ records: ChatHistoryRecord[]; total: number }> {
    if (!this.options.enabled || !this.autoDriveApi) {
      return { records: [], total: 0 };
    }

    try {
      console.log('[OnchainChatStorage] Fetching chat history from Autonomys...');
      
      // Fetch all files from Autonomys
      const allFiles: any[] = [];
      let page = 0;
      const pageSize = 100;
      
      while (true) {
        const result = await this.autoDriveApi.getMyFiles(page, pageSize);
        allFiles.push(...result.rows);
        
        console.log(`[OnchainChatStorage] Fetched page ${page}: ${result.rows.length} files`);
        
        if (result.rows.length < pageSize) {
          break; // No more files
        }
        page++;
      }
      
      console.log(`[OnchainChatStorage] Total files fetched: ${allFiles.length}`);
      
      // Parse file metadata to reconstruct records
      const records: ChatHistoryRecord[] = [];
      
      for (const file of allFiles) {
        const fileName = file.name || '';

        // Parse both filename variants emitted by buildObjectKey:
        // agentId-sessionId-messageIndex-timestamp.json
        // agentId-sessionId-timestamp-requestId.json
        const parsed = this.parseHistoryFileName(fileName);

        if (!parsed) {
          continue; // Skip non-history files
        }
        
        // Create a minimal record from metadata
        // We can't download the full content due to webcrypto issues,
        // but we have enough info to display in the history list
        const record: ChatHistoryRecord = {
          requestId: file.headCid,
          endpoint: '/api/secretai/chat',
          timestamp: parsed.timestamp,
          sessionId: parsed.sessionId,
          messageIndex: parsed.messageIndex,
          cid: file.headCid,
          request: {
            // Placeholder - actual content is in Autonomys
            messages: [],
          },
          metadata: {
            sessionId: parsed.sessionId,
            fileName,
            size: file.size,
          },
        };
        
        records.push(record);
      }
      
      console.log(`[OnchainChatStorage] Parsed ${records.length} chat history records`);
      
      // Apply filters
      let filtered = records;
      
      if (options?.startDate) {
        const start = new Date(options.startDate).getTime();
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() >= start);
      }

      if (options?.endDate) {
        const end = new Date(options.endDate).getTime();
        filtered = filtered.filter((r) => new Date(r.timestamp).getTime() <= end);
      }

      // Sort by timestamp (most recent first)
      filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const total = filtered.length;
      const offset = options?.offset || 0;
      const limit = options?.limit || 50;
      const paginated = filtered.slice(offset, offset + limit);

      return { records: paginated, total };
    } catch (error) {
      console.error('[OnchainChatStorage] Error fetching chat history from Autonomys:', error);
      return { records: [], total: 0 };
    }
  }

  async downloadMessageContent(cid: string): Promise<any | null> {
    if (!this.options.enabled) {
      return null;
    }

    try {
      console.log(`[OnchainChatStorage] Downloading message content for CID: ${cid}`);
      
      // Use Autonomys gateway to download file content
      const downloadUrl = `https://gateway.autonomys.xyz/file/${cid}`;
      
      const response = await fetch(downloadUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to download from Autonomys gateway: ${response.status} ${response.statusText}`);
      }
      
      const content = await response.json();
      console.log(`[OnchainChatStorage] Successfully downloaded content for CID: ${cid}`);
      
      return content;
    } catch (error) {
      console.error(`[OnchainChatStorage] Error downloading message content for CID ${cid}:`, error);
      return null;
    }
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
