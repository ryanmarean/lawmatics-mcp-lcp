import os from "os";
import path from "path";
import { parseEncryptionKey } from "./store.js";

export interface HostedConfig {
  /** Public HTTPS origin of this server, e.g. https://lawmatics-mcp.example.com */
  baseUrl: URL;
  /** The MCP endpoint (baseUrl + /mcp); also the OAuth "resource" tokens are issued for. */
  mcpUrl: URL;
  /** Where Lawmatics sends users back after they approve the app. */
  lawmaticsRedirectUri: string;
  host: string;
  port: number;
  lawmaticsClientId: string;
  lawmaticsClientSecret: string;
  encryptionKey: Buffer;
  dataDir: string;
  /** Redirect URIs an MCP client may register (Claude's OAuth callback by default). */
  allowedRedirectUris: string[];
  /** If non-empty, only Lawmatics users whose email is in one of these domains may sign in. */
  allowedEmailDomains: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionIdleTimeoutMs: number;
  /** Express "trust proxy" setting; default trusts only a reverse proxy on loopback. */
  trustProxy: string;
}

export const DEFAULT_ALLOWED_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve and validate hosted-mode settings; throws one message listing everything missing. */
export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const problems: string[] = [];

  const rawBase = (env.MCP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  let baseUrl: URL | undefined;
  if (!rawBase) {
    problems.push("MCP_BASE_URL is required (the public https:// address of this server).");
  } else {
    try {
      baseUrl = new URL(rawBase);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
      if (baseUrl.protocol !== "https:" && !loopback) {
        problems.push("MCP_BASE_URL must use https:// (plain http is allowed only for localhost testing).");
      }
    } catch {
      problems.push(`MCP_BASE_URL is not a valid URL: ${rawBase}`);
    }
  }

  const lawmaticsClientId = (env.LAWMATICS_CLIENT_ID ?? "").trim();
  const lawmaticsClientSecret = (env.LAWMATICS_CLIENT_SECRET ?? "").trim();
  if (!lawmaticsClientId) problems.push("LAWMATICS_CLIENT_ID is required (Lawmatics Settings > Developers).");
  if (!lawmaticsClientSecret) problems.push("LAWMATICS_CLIENT_SECRET is required.");

  let encryptionKey: Buffer | undefined;
  try {
    encryptionKey = parseEncryptionKey(env.LAWMATICS_MCP_ENCRYPTION_KEY);
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (problems.length) {
    throw new Error("Hosted mode (TRANSPORT=http) is not configured:\n  - " + problems.join("\n  - "));
  }

  const allowedRedirectUris = list(env.MCP_ALLOWED_REDIRECT_URIS);

  return {
    baseUrl: baseUrl!,
    mcpUrl: new URL("/mcp", baseUrl!),
    lawmaticsRedirectUri: new URL("/oauth/lawmatics/callback", baseUrl!).toString(),
    host: (env.HOST ?? "127.0.0.1").trim(),
    port: Math.trunc(positiveNumber(env.PORT, 3100)),
    lawmaticsClientId,
    lawmaticsClientSecret,
    encryptionKey: encryptionKey!,
    dataDir: (env.LAWMATICS_MCP_DATA_DIR ?? "").trim() || path.join(os.homedir(), ".lawmatics-mcp"),
    allowedRedirectUris: allowedRedirectUris.length ? allowedRedirectUris : DEFAULT_ALLOWED_REDIRECT_URIS,
    allowedEmailDomains: list(env.LAWMATICS_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, "")),
    accessTokenTtlSeconds: Math.trunc(positiveNumber(env.ACCESS_TOKEN_TTL_SECONDS, 3600)),
    refreshTokenTtlSeconds: Math.trunc(positiveNumber(env.REFRESH_TOKEN_TTL_DAYS, 90) * 86400),
    sessionIdleTimeoutMs: positiveNumber(env.SESSION_IDLE_TIMEOUT_HOURS, 24) * 3600 * 1000,
    trustProxy: (env.TRUST_PROXY ?? "loopback").trim(),
  };
}
