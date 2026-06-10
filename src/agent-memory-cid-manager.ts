import fs from 'fs';
import path from 'path';

/**
 * Tracks the head CID of each conversation session's chain of agent experiences
 * stored on Autonomys Auto Drive, so every new experience can point back to the
 * previous one (a linked list of Auto Drive records).
 *
 * The head CID and the number of messages already captured for each session are
 * kept in a local JSON file, written atomically so a crash mid-write cannot
 * leave a truncated/corrupt store.
 */

interface StoredCid {
  cid: string;
  /** Number of cumulative (system-free) messages already captured for this session. */
  messageCount: number;
  timestamp: string;
}

type CidMap = Record<string, StoredCid>;

export class AgentMemoryCidManager {
  private readonly localFilePath: string;
  private cache: CidMap | null = null;

  constructor(localFilePath: string) {
    this.localFilePath = localFilePath;
  }

  /**
   * Return the head of this session's chain: the previous experience CID and the
   * number of cumulative messages already captured.
   */
  getLast(sessionId: string): { cid: string; messageCount: number } | undefined {
    const local = this.readLocal()[sessionId];
    return local?.cid ? { cid: local.cid, messageCount: local.messageCount ?? 0 } : undefined;
  }

  /** Record `cid` as the new head of this session's chain. */
  saveLastCid(sessionId: string, cid: string, messageCount: number): void {
    const map = this.readLocal();
    map[sessionId] = { cid, messageCount, timestamp: new Date().toISOString() };
    this.writeLocal(map);
  }

  private readLocal(): CidMap {
    if (this.cache) {
      return this.cache;
    }
    try {
      if (fs.existsSync(this.localFilePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.localFilePath, 'utf8')) as CidMap;
      } else {
        this.cache = {};
      }
    } catch (error) {
      console.warn('[AgentMemoryCidManager] Failed to read local CID file; starting fresh:', error);
      this.cache = {};
    }
    return this.cache;
  }

  private writeLocal(map: CidMap): void {
    this.cache = map;
    try {
      fs.mkdirSync(path.dirname(this.localFilePath), { recursive: true });
      // Atomic write: write to a temp file then rename, so a crash mid-write
      // cannot leave a truncated/corrupt JSON store.
      const tmp = `${this.localFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
      fs.renameSync(tmp, this.localFilePath);
    } catch (error) {
      console.warn('[AgentMemoryCidManager] Failed to write local CID file:', error);
    }
  }
}
