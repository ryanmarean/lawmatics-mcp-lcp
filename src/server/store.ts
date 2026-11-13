/**
 * Encrypted on-disk store for hosted mode.
 *
 * Holds: registered OAuth clients (Claude's dynamic registration), each signed-in
 * user's Lawmatics access token, and the short-lived access / refresh tokens this
 * server issues to Claude. The whole file is encrypted with AES-256-GCM under
 * LAWMATICS_MCP_ENCRYPTION_KEY, and issued tokens are additionally stored only as
 * SHA-256 hashes, so a copied file is useless without the key and never yields a
 * usable bearer token.
 *
 * Lawmatics tokens never expire and Lawmatics has no revocation endpoint (only a
 * support request revokes one), so this file is the most sensitive thing on the
 * host. Keep the key outside the data directory.
 *
 * Sized for a firm (tens of users): everything lives in memory and each mutation
 * rewrites the file atomically. Not designed for multiple server processes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "fs/promises";
import path from "path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const MAGIC = Buffer.from("LMCP1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface UserRecord {
  userId: string;
  email?: string;
  name?: string;
  lawmaticsToken: string;
  connectedAt: string;
  lastSeenAt?: string;
}

export interface IssuedToken {
  userId: string;
  clientId: string;
  /** Seconds since epoch. */
  expiresAt: number;
  resource?: string;
}

interface StoreData {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  users: Record<string, UserRecord>;
  accessTokens: Record<string, IssuedToken>;
  refreshTokens: Record<string, IssuedToken>;
}

function emptyData(): StoreData {
  return { version: 1, clients: {}, users: {}, accessTokens: {}, refreshTokens: {} };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function parseEncryptionKey(hex: string | undefined): Buffer {
  const value = (hex ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      "LAWMATICS_MCP_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32"
    );
  }
  return Buffer.from(value, "hex");
}

export function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(key: Buffer, blob: Buffer): string {
  if (blob.length < MAGIC.length + IV_LENGTH + TAG_LENGTH || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Store file is not a lawmatics-mcp encrypted store.");
  }
  let offset = MAGIC.length;
  const iv = blob.subarray(offset, (offset += IV_LENGTH));
  const tag = blob.subarray(offset, (offset += TAG_LENGTH));
  const body = blob.subarray(offset);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Could not decrypt the store file: wrong LAWMATICS_MCP_ENCRYPTION_KEY or the file was modified."
    );
  }
}

export class Store {
  private data: StoreData = emptyData();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly key: Buffer
  ) {}

  static async open(dataDir: string, key: Buffer): Promise<Store> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new Store(path.join(dataDir, "store.enc"), key);
    try {
      const blob = await readFile(store.file);
      store.data = { ...emptyData(), ...(JSON.parse(decrypt(key, blob)) as StoreData) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    store.pruneExpired();
    return store;
  }

  /** Serialize writes; each write is temp-file + rename so a crash never leaves a torn file. */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, encrypt(this.key, snapshot), { mode: 0o600 });
        await rename(tmp, this.file);
        await chmod(this.file, 0o600).catch(() => undefined);
      });
    return this.writeChain;
  }

  private pruneExpired(): void {
    const now = Date.now() / 1000;
    for (const table of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [hash, t] of Object.entries(table)) {
        if (t.expiresAt < now) delete table[hash];
      }
    }
  }

  // --- clients -------------------------------------------------------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.data.clients[clientId];
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    this.data.clients[client.client_id] = client;
    await this.persist();
  }

  // --- users ---------------------------------------------------------------

  getUser(userId: string): UserRecord | undefined {
    return this.data.users[userId];
  }

  listUsers(): Omit<UserRecord, "lawmaticsToken">[] {
    return Object.values(this.data.users).map(({ lawmaticsToken: _t, ...rest }) => rest);
  }

  async upsertUser(user: UserRecord): Promise<void> {
    this.data.users[user.userId] = user;
    await this.persist();
  }

  /** Records activity at most once an hour per user, to avoid a disk write per tool call. */
  async touchUser(userId: string): Promise<void> {
    const user = this.data.users[userId];
    if (!user) return;
    const last = user.lastSeenAt ? Date.parse(user.lastSeenAt) : 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    user.lastSeenAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * Deletes the user's stored Lawmatics token and every token this server issued
   * to them. Their Lawmatics token stays valid AT LAWMATICS until support revokes it.
   */
  async removeUser(userId: string): Promise<boolean> {
    const existed = Boolean(this.data.users[userId]);
    delete this.data.users[userId];
    for (const table of [this.data.accessTokens, this.data.refreshTokens]) {
      for (const [hash, t] of Object.entries(table)) {
        if (t.userId === userId) delete table[hash];
      }
    }
    await this.persist();
    return existed;
  }

  // --- issued tokens -------------------------------------------------------

  getAccessToken(token: string): IssuedToken | undefined {
    return this.data.accessTokens[hashToken(token)];
  }

  getRefreshToken(token: string): IssuedToken | undefined {
    return this.data.refreshTokens[hashToken(token)];
  }

  async saveTokenPair(
    access: { token: string; record: IssuedToken },
    refresh: { token: string; record: IssuedToken },
    replacesRefreshToken?: string
  ): Promise<void> {
    this.pruneExpired();
    if (replacesRefreshToken) delete this.data.refreshTokens[hashToken(replacesRefreshToken)];
    this.data.accessTokens[hashToken(access.token)] = access.record;
    this.data.refreshTokens[hashToken(refresh.token)] = refresh.record;
    await this.persist();
  }

  async revokeIssuedToken(token: string): Promise<void> {
    const hash = hashToken(token);
    if (!this.data.accessTokens[hash] && !this.data.refreshTokens[hash]) return;
    delete this.data.accessTokens[hash];
    delete this.data.refreshTokens[hash];
    await this.persist();
  }

  /** Test/diagnostic hook: wait for pending writes. */
  flush(): Promise<void> {
    return this.writeChain;
  }
}
