import { AsyncLocalStorage } from "async_hooks";

/**
 * Per-request identity for hosted (HTTP) mode. The HTTP server runs every MCP
 * request inside a context naming the signed-in Lawmatics user, so the API
 * client calls Lawmatics with THAT user's token and the audit log records who
 * acted. stdio mode never sets a context and keeps using LAWMATICS_ACCESS_TOKEN.
 */
export interface UserContext {
  /** Lawmatics user id (from /users/me at sign-in). */
  userId: string;
  email?: string;
  name?: string;
  /** MCP session id, for correlating audit entries. */
  sessionId?: string;
  /** Resolves the user's Lawmatics access token (decrypted on demand). */
  getAccessToken(): Promise<string>;
}

const storage = new AsyncLocalStorage<UserContext>();

export function getUserContext(): UserContext | undefined {
  return storage.getStore();
}

export function runWithUserContext<T>(ctx: UserContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** True when the server runs as a hosted multi-user HTTP server. */
export function isHostedMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRANSPORT ?? "stdio").trim().toLowerCase() === "http";
}
