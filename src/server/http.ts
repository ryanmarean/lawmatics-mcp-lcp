/**
 * Hosted, multi-user HTTP transport (TRANSPORT=http).
 *
 * - OAuth endpoints (/authorize, /token, /register, /revoke, /.well-known/*) come
 *   from the MCP SDK's mcpAuthRouter, backed by LawmaticsOAuthProvider.
 * - /mcp requires a bearer token issued by this server. Each MCP session is bound
 *   to the user who opened it; every request runs inside that user's context, so
 *   Lawmatics is called with their own token and the audit log names them.
 * - Designed to sit behind a TLS-terminating reverse proxy (nginx/Caddy) on the
 *   same host; it listens on 127.0.0.1 by default.
 */
import express from "express";
import { randomUUID } from "crypto";
import type { Server } from "http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpServer } from "../create-server.js";
import { runWithUserContext, type UserContext } from "../session-context.js";
import { isReadOnly } from "../tool-helpers.js";
import type { HostedConfig } from "./config.js";
import { LawmaticsOAuthProvider } from "./oauth-provider.js";
import type { Store } from "./store.js";

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  lastActivityAt: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, message: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">` +
    `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`
  );
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function jsonRpcError(res: express.Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export interface HostedApp {
  app: express.Express;
  provider: LawmaticsOAuthProvider;
  sessions: Map<string, SessionRecord>;
  /** Closes idle sessions; called on a timer in production. */
  sweepIdleSessions(now?: number): void;
}

export function createHostedApp(config: HostedConfig, store: Store): HostedApp {
  const provider = new LawmaticsOAuthProvider(config, store);
  const sessions = new Map<string, SessionRecord>();
  const app = express();
  app.set("trust proxy", parseTrustProxy(config.trustProxy));
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // OAuth authorization server + protected-resource metadata, at the app root.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.baseUrl,
      resourceServerUrl: config.mcpUrl,
      resourceName: "Lawmatics",
    })
  );

  app.get("/oauth/lawmatics/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await provider.handleLawmaticsCallback(req.query as Record<string, unknown>);
      if (result.kind === "redirect") {
        res.redirect(302, result.location);
      } else {
        res.status(result.status).type("html").send(page(result.title, result.message));
      }
    } catch (err) {
      console.error(`[lawmatics-mcp] Callback error: ${(err as Error).message}`);
      res.status(500).type("html").send(page("Sign-in failed", "Something went wrong. Return to Claude and try again."));
    }
  });

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
    expectedResource: config.mcpUrl,
  });

  const userContextFor = (userId: string, sessionId: string | undefined): UserContext => {
    const user = store.getUser(userId);
    return {
      userId,
      email: user?.email,
      name: user?.name,
      sessionId,
      getAccessToken: async () => {
        const current = store.getUser(userId);
        if (!current) throw new Error("You are no longer connected. Reconnect the Lawmatics connector.");
        return current.lawmaticsToken;
      },
    };
  };

  app.all("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const userId = String(req.auth?.extra?.userId ?? "");
    if (!userId) {
      jsonRpcError(res, 401, "Unauthorized");
      return;
    }
    void store.touchUser(userId).catch(() => undefined);

    try {
      const sessionId = req.header("mcp-session-id");

      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record) {
          jsonRpcError(res, 404, "Session not found");
          return;
        }
        // A session belongs to the user who opened it; another user's token cannot drive it.
        if (record.userId !== userId) {
          jsonRpcError(res, 403, "Session belongs to a different user");
          return;
        }
        record.lastActivityAt = Date.now();
        await runWithUserContext(userContextFor(userId, sessionId), () =>
          record.transport.handleRequest(req, res, req.body)
        );
        return;
      }

      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, "Bad Request: no valid session ID provided");
        return;
      }

      const server = createMcpServer();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, userId, lastActivityAt: Date.now() });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await runWithUserContext(userContextFor(userId, undefined), () =>
        transport.handleRequest(req, res, req.body)
      );
    } catch (err) {
      console.error(`[lawmatics-mcp] /mcp error: ${(err as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    }
  });

  const sweepIdleSessions = (now = Date.now()) => {
    for (const [id, record] of sessions) {
      if (now - record.lastActivityAt > config.sessionIdleTimeoutMs) {
        sessions.delete(id);
        record.transport.close().catch(() => undefined);
        record.server.close().catch(() => undefined);
      }
    }
  };

  return { app, provider, sessions, sweepIdleSessions };
}

export async function startHttpServer(config: HostedConfig, store: Store): Promise<Server> {
  const hosted = createHostedApp(config, store);
  setInterval(() => hosted.sweepIdleSessions(), 15 * 60 * 1000).unref();

  return new Promise((resolve, reject) => {
    const server = hosted.app.listen(config.port, config.host, () => {
      console.error(`[lawmatics-mcp] Hosted mode listening on http://${config.host}:${config.port}`);
      console.error(`[lawmatics-mcp] Public MCP endpoint : ${config.mcpUrl.toString()}`);
      console.error(`[lawmatics-mcp] Lawmatics callback  : ${config.lawmaticsRedirectUri}`);
      console.error(`[lawmatics-mcp] Allowed redirects   : ${config.allowedRedirectUris.join(", ")}`);
      console.error(
        `[lawmatics-mcp] Email domains       : ${config.allowedEmailDomains.length ? config.allowedEmailDomains.join(", ") : "ANY (set LAWMATICS_ALLOWED_EMAIL_DOMAINS)"}`
      );
      if (isReadOnly()) console.error("[lawmatics-mcp] Read-only mode: write tools are disabled.");
      resolve(server);
    });
    server.on("error", reject);
  });
}
