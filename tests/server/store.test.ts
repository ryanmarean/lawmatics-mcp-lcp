import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { Store, decrypt, encrypt, parseEncryptionKey } from "../../src/server/store.js";

const dirs: string[] = [];
async function tempDir() {
  const d = await mkdtemp(path.join(os.tmpdir(), "lmcp-store-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const user = { userId: "42", email: "ann@firm.com", name: "Ann Lee", lawmaticsToken: "lm-secret-token", connectedAt: "2026-11-10T00:00:00Z" };

describe("encryption", () => {
  it("round-trips and rejects a wrong key", () => {
    const key = randomBytes(32);
    const blob = encrypt(key, "hello");
    expect(decrypt(key, blob)).toBe("hello");
    expect(() => decrypt(randomBytes(32), blob)).toThrow(/wrong LAWMATICS_MCP_ENCRYPTION_KEY/);
  });

  it("validates the key format", () => {
    expect(() => parseEncryptionKey("abc")).toThrow(/64 hex/);
    expect(parseEncryptionKey("a".repeat(64))).toHaveLength(32);
  });
});

describe("Store", () => {
  it("persists encrypted and never writes tokens in plaintext", async () => {
    const dir = await tempDir();
    const key = randomBytes(32);
    const store = await Store.open(dir, key);
    await store.upsertUser(user);
    await store.saveTokenPair(
      { token: "access-abc", record: { userId: "42", clientId: "c", expiresAt: Date.now() / 1000 + 60 } },
      { token: "refresh-abc", record: { userId: "42", clientId: "c", expiresAt: Date.now() / 1000 + 600 } }
    );
    await store.flush();

    const raw = await readFile(path.join(dir, "store.enc"));
    for (const secret of ["lm-secret-token", "access-abc", "refresh-abc", "ann@firm.com"]) {
      expect(raw.includes(Buffer.from(secret))).toBe(false);
    }
    // Issued tokens are stored hashed even inside the encrypted payload.
    const plain = decrypt(key, raw);
    expect(plain).toContain("lm-secret-token");
    expect(plain).not.toContain("access-abc");

    const reopened = await Store.open(dir, key);
    expect(reopened.getUser("42")?.lawmaticsToken).toBe("lm-secret-token");
    expect(reopened.getAccessToken("access-abc")?.userId).toBe("42");
    await expect(Store.open(dir, randomBytes(32))).rejects.toThrow(/decrypt/);
  });

  it("removeUser deletes the user and every token issued to them", async () => {
    const store = await Store.open(await tempDir(), randomBytes(32));
    await store.upsertUser(user);
    await store.upsertUser({ ...user, userId: "7", email: "bo@firm.com" });
    const exp = Date.now() / 1000 + 600;
    await store.saveTokenPair(
      { token: "a42", record: { userId: "42", clientId: "c", expiresAt: exp } },
      { token: "r42", record: { userId: "42", clientId: "c", expiresAt: exp } }
    );
    await store.saveTokenPair(
      { token: "a7", record: { userId: "7", clientId: "c", expiresAt: exp } },
      { token: "r7", record: { userId: "7", clientId: "c", expiresAt: exp } }
    );
    expect(await store.removeUser("42")).toBe(true);
    expect(store.getUser("42")).toBeUndefined();
    expect(store.getAccessToken("a42")).toBeUndefined();
    expect(store.getRefreshToken("r42")).toBeUndefined();
    expect(store.getAccessToken("a7")?.userId).toBe("7");
    expect(store.listUsers().map((u) => u.userId)).toEqual(["7"]);
    expect(JSON.stringify(store.listUsers())).not.toContain("lm-secret-token");
  });

  it("drops expired issued tokens on load", async () => {
    const dir = await tempDir();
    const key = randomBytes(32);
    const store = await Store.open(dir, key);
    await store.saveTokenPair(
      { token: "old", record: { userId: "42", clientId: "c", expiresAt: 1 } },
      { token: "fresh", record: { userId: "42", clientId: "c", expiresAt: Date.now() / 1000 + 600 } }
    );
    await store.flush();
    const reopened = await Store.open(dir, key);
    expect(reopened.getAccessToken("old")).toBeUndefined();
    expect(reopened.getRefreshToken("fresh")).toBeDefined();
  });
});
