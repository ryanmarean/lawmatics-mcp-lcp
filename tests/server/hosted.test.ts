/**
 * End-to-end test of hosted mode over real HTTP: dynamic client registration,
 * the chained Lawmatics sign-in, PKCE token exchange, per-user tool calls,
 * session binding, refresh rotation, and offboarding. Lawmatics itself is a
 * fetch mock; the test client uses the real fetch captured before stubbing.
 */
import "../helpers.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "crypto";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import http, { type Server } from "http";
import type { AddressInfo } from "net";
import { loadHostedConfig } from "../../src/server/config.js";
import { createHostedApp, type HostedApp } from "../../src/server/http.js";
import { Store } from "../../src/server/store.js";

const realFetch = globalThis.fetch;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const USERS: Record<string, { id: string; email: string; first_name: string; last_name: string }> = {
  "code-ann": { id: "42", email: "ann@firm.com", first_name: "Ann", last_name: "Lee" },
  "code-bo": { id: "7", email: "bo@firm.com", first_name: "Bo", last_name: "Diaz" },
  "code-outsider": { id: "99", email: "eve@elsewhere.com", first_name: "Eve", last_name: "X" },
};

let server: Server;
let base: string;
let dataDir: string;
let hosted: HostedApp;
let store: Store;
let lawmaticsCalls: Array<{ url: string; auth?: string }>;

function installLawmaticsMock() {
  lawmaticsCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      lawmaticsCalls.push({ url, auth });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url === "https://api.lawmatics.com/oauth/token") {
        const { code } = JSON.parse(String(init?.body));
        return json({ token_type: "bearer", access_token: `lm-token-for-${code}`, created_at: 1 });
      }
      if (url.startsWith("https://api.lawmatics.com/v1/users/me")) {
        const code = String(auth).replace("Bearer lm-token-for-", "");
        const u = USERS[code];
        if (!u) return json({ errors: [{ title: "Unauthorized" }] }, 401);
        const { id, ...attributes } = u;
        return json({ data: { id, type: "user", attributes } });
      }
      return json({ errors: [{ title: "unexpected", detail: url }] }, 500);
    })
  );
}

// The config needs the port, so bind the HTTP server first and attach a fresh app per test.
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "lmcp-hosted-"));
  server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

beforeEach(async () => {
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  const config = loadHostedConfig({
    MCP_BASE_URL: base,
    LAWMATICS_CLIENT_ID: "lm-client",
    LAWMATICS_CLIENT_SECRET: "lm-secret",
    LAWMATICS_MCP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    LAWMATICS_MCP_DATA_DIR: await mkdtemp(path.join(dataDir, "run-")),
    LAWMATICS_ALLOWED_EMAIL_DOMAINS: "firm.com",
  });
  store = await Store.open(config.dataDir, config.encryptionKey);
  hosted = createHostedApp(config, store);
  server.removeAllListeners("request");
  server.on("request", hosted.app);
  installLawmaticsMock();
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------

async function register(redirectUris = [CLAUDE_CALLBACK]) {
  return realFetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, token_endpoint_auth_method: "none", client_name: "Claude" }),
  });
}

async function signIn(lawmaticsCode: string) {
  const client = await (await register()).json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state",
  }).toString();
  const toLawmatics = await realFetch(authorize, { redirect: "manual" });
  expect(toLawmatics.status).toBe(302);
  const lmUrl = new URL(toLawmatics.headers.get("location")!);
  expect(lmUrl.origin + lmUrl.pathname).toBe("https://app.lawmatics.com/oauth/authorize");
  expect(lmUrl.searchParams.get("client_id")).toBe("lm-client");
  expect(lmUrl.searchParams.get("redirect_uri")).toBe(`${base}/oauth/lawmatics/callback`);
  const txn = lmUrl.searchParams.get("state")!;

  const back = await realFetch(`${base}/oauth/lawmatics/callback?code=${lawmaticsCode}&state=${txn}`, {
    redirect: "manual",
  });
  const toClaude = new URL(back.headers.get("location")!);
  return { client, verifier, toClaude };
}

async function tokenRequest(params: Record<string, string>) {
  return realFetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

async function connect(lawmaticsCode: string) {
  const { client, verifier, toClaude } = await signIn(lawmaticsCode);
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code: toClaude.searchParams.get("code")!,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CLAUDE_CALLBACK,
  });
  expect(res.status).toBe(200);
  return { client, tokens: await res.json() };
}

async function mcp(token: string, body: unknown, sessionId?: string) {
  const res = await realFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-06-18" } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : text ? JSON.parse(text) : undefined;
  return { res, json, sessionId: res.headers.get("mcp-session-id") ?? undefined };
}

async function openSession(token: string) {
  const init = await mcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  expect(init.res.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  await mcp(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  return init.sessionId!;
}

const callCurrentUser = (token: string, sessionId: string) =>
  mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get-current-user", arguments: {} } }, sessionId);

// --- tests -------------------------------------------------------------------

describe("hosted mode", () => {
  it("advertises OAuth metadata and challenges unauthenticated /mcp calls", async () => {
    const meta = await (await realFetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
    expect(meta.registration_endpoint).toBe(`${base}/register`);

    const prm = await realFetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    expect((await prm.json()).resource).toBe(`${base}/mcp`);

    const res = await realFetch(`${base}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("refuses to register clients with a non-allowlisted redirect URI", async () => {
    const res = await register(["https://attacker.example/callback"]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });

  it("signs a user in through Lawmatics and runs tools with THEIR token", async () => {
    const { tokens } = await connect("code-ann");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.refresh_token).toBeTruthy();
    expect(store.getUser("42")?.email).toBe("ann@firm.com");

    const sessionId = await openSession(tokens.access_token);
    lawmaticsCalls = [];
    const result = await callCurrentUser(tokens.access_token, sessionId);
    expect(result.json.result.isError).toBeFalsy();
    expect(JSON.parse(result.json.result.content[0].text).email).toBe("ann@firm.com");
    expect(lawmaticsCalls).toEqual([{ url: "https://api.lawmatics.com/v1/users/me", auth: "Bearer lm-token-for-code-ann" }]);
  });

  it("returns state to Claude and rejects a forged Lawmatics callback", async () => {
    const { toClaude } = await signIn("code-ann");
    expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_CALLBACK);
    expect(toClaude.searchParams.get("state")).toBe("claude-state");
    expect(toClaude.searchParams.get("code")).toBeTruthy();

    const forged = await realFetch(`${base}/oauth/lawmatics/callback?code=code-ann&state=made-up`, { redirect: "manual" });
    expect(forged.status).toBe(400);
  });

  it("rejects the token exchange without the right PKCE verifier", async () => {
    const { client, toClaude } = await signIn("code-ann");
    const res = await tokenRequest({
      grant_type: "authorization_code",
      code: toClaude.searchParams.get("code")!,
      code_verifier: randomBytes(32).toString("base64url"),
      client_id: client.client_id,
    });
    expect(res.status).toBe(400);
  });

  it("blocks Lawmatics users outside the allowed email domains", async () => {
    const { toClaude } = await signIn("code-outsider");
    expect(toClaude.searchParams.get("error")).toBe("access_denied");
    expect(toClaude.searchParams.get("code")).toBeNull();
    expect(store.getUser("99")).toBeUndefined();
  });

  it("does not let one user drive another user's session", async () => {
    const ann = await connect("code-ann");
    const bo = await connect("code-bo");
    const annSession = await openSession(ann.tokens.access_token);
    const hijack = await callCurrentUser(bo.tokens.access_token, annSession);
    expect(hijack.res.status).toBe(403);
  });

  it("rotates refresh tokens and rejects reuse", async () => {
    const { client, tokens } = await connect("code-ann");
    const first = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(first.status).toBe(200);
    const rotated = await first.json();
    expect(rotated.access_token).not.toBe(tokens.access_token);

    const reuse = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reuse.status).toBe(400);
  });

  it("removing a user cuts off their tokens immediately", async () => {
    const { client, tokens } = await connect("code-ann");
    const sessionId = await openSession(tokens.access_token);
    await store.removeUser("42");

    const call = await callCurrentUser(tokens.access_token, sessionId);
    expect(call.res.status).toBe(401);
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refresh.status).toBe(400);
  });

  it("closes sessions that sit idle past the timeout", async () => {
    const { tokens } = await connect("code-ann");
    await openSession(tokens.access_token);
    expect(hosted.sessions.size).toBe(1);
    hosted.sweepIdleSessions(Date.now() + 48 * 3600 * 1000);
    expect(hosted.sessions.size).toBe(0);
  });
});
