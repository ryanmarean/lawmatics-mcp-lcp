/**
 * OAuth authorization server for hosted mode, chained to Lawmatics.
 *
 * Claude (the MCP client) runs a standard OAuth 2.1 + PKCE flow against THIS
 * server. Instead of a login page of our own, /authorize sends the user to
 * Lawmatics' own authorize screen. When Lawmatics redirects back, we exchange
 * the code for the user's (non-expiring) Lawmatics token, identify the user via
 * /users/me, store the token encrypted, and hand Claude an authorization code of
 * ours. Claude then receives short-lived access tokens + rotating refresh tokens
 * issued by this server; the Lawmatics token never leaves the server.
 *
 *   Claude ──/authorize──▶ us ──302──▶ Lawmatics login + approve
 *   Lawmatics ──/oauth/lawmatics/callback?code──▶ us (exchange, /users/me, store)
 *   us ──302 redirect_uri?code=ours──▶ Claude ──/token──▶ us (access + refresh)
 */
import { randomBytes, randomUUID } from "crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { buildAuthorizeUrl, exchangeCodeForToken } from "../auth.js";
import { lawmaticsGetOne } from "../lawmatics-client.js";
import { runWithUserContext } from "../session-context.js";
import { auditLog } from "../audit/logger.js";
import type { HostedConfig } from "./config.js";
import type { IssuedToken, Store } from "./store.js";

/** How long a user has to finish the Lawmatics login, and how long our code is valid. */
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  expiresAt: number;
}

export type CallbackResult =
  | { kind: "redirect"; location: string }
  | { kind: "page"; status: number; title: string; message: string };

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export class LawmaticsOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();

  constructor(
    private readonly config: HostedConfig,
    private readonly store: Store
  ) {}

  // --- client registration (Claude registers itself dynamically) ------------

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.store.getClient(clientId),
      registerClient: async (
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
      ): Promise<OAuthClientInformationFull> => {
        // Open registration + an attacker-chosen redirect URI would let anyone who
        // tricks a rep into connecting receive that rep's access. Only known MCP
        // client callbacks (Claude's, by default) may be registered.
        const disallowed = client.redirect_uris.filter(
          (uri) => !this.config.allowedRedirectUris.some((allowed) => sameUrl(allowed, String(uri)))
        );
        if (disallowed.length) {
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed on this server: ${disallowed.join(", ")}`
          );
        }
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await this.store.saveClient(full);
        return full;
      },
    };
  }

  // --- authorization: hand off to Lawmatics ---------------------------------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!this.config.allowedRedirectUris.some((allowed) => sameUrl(allowed, params.redirectUri))) {
      throw new InvalidRequestError("redirect_uri not allowed on this server");
    }
    if (params.resource && !this.isOurResource(params.resource.toString())) {
      throw new InvalidTargetError(`Unknown resource: ${params.resource.toString()}`);
    }
    this.sweep();
    const txn = newSecret();
    this.pending.set(txn, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    res.redirect(
      302,
      buildAuthorizeUrl(this.config.lawmaticsClientId, this.config.lawmaticsRedirectUri, txn)
    );
  }

  /**
   * Handles Lawmatics' redirect back to us. Errors that can be tied to a pending
   * request go back to the MCP client (per OAuth); anything else is shown as a page.
   */
  async handleLawmaticsCallback(query: Record<string, unknown>): Promise<CallbackResult> {
    const state = typeof query.state === "string" ? query.state : "";
    const pending = state ? this.pending.get(state) : undefined;
    if (state) this.pending.delete(state); // one use only
    if (!pending || pending.expiresAt < Date.now()) {
      return {
        kind: "page",
        status: 400,
        title: "Sign-in link expired",
        message: "This sign-in attempt is unknown or expired. Return to Claude and connect again.",
      };
    }

    const back = (params: Record<string, string>): CallbackResult => ({
      kind: "redirect",
      location: withParams(pending.redirectUri, { ...params, state: pending.state }),
    });

    if (typeof query.error === "string") {
      await auditLog({ tool: "oauth_sign_in", outcome: "blocked", error: `lawmatics: ${query.error}` });
      return back({ error: "access_denied", error_description: "Access was not granted in Lawmatics." });
    }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code) return back({ error: "invalid_request", error_description: "Lawmatics returned no code." });

    let lawmaticsToken: string;
    let me: Record<string, unknown>;
    try {
      lawmaticsToken = await exchangeCodeForToken(
        this.config.lawmaticsClientId,
        this.config.lawmaticsClientSecret,
        code,
        this.config.lawmaticsRedirectUri
      );
      me = await runWithUserContext({ userId: "(signing-in)", getAccessToken: async () => lawmaticsToken }, () =>
        lawmaticsGetOne("/users/me")
      );
    } catch (err) {
      console.error(`[lawmatics-mcp] Sign-in failed: ${(err as Error).message}`);
      await auditLog({ tool: "oauth_sign_in", outcome: "error", error: (err as Error).message });
      return back({ error: "server_error", error_description: "Could not complete the Lawmatics sign-in." });
    }

    const userId = String(me.id ?? "");
    const email = typeof me.email === "string" ? me.email.trim() : undefined;
    const name =
      [me.first_name, me.last_name].filter((p) => typeof p === "string" && p).join(" ") ||
      (typeof me.name === "string" ? me.name : undefined);

    if (!userId) {
      return back({ error: "server_error", error_description: "Lawmatics did not identify the user." });
    }
    if (!this.emailAllowed(email)) {
      await auditLog({
        tool: "oauth_sign_in",
        outcome: "blocked",
        user_id: userId,
        user_email: email,
        error: "email domain not allowed",
      });
      return back({
        error: "access_denied",
        error_description: "This Lawmatics account is not permitted to use this connector.",
      });
    }

    const existing = this.store.getUser(userId);
    await this.store.upsertUser({
      userId,
      email,
      name,
      lawmaticsToken,
      connectedAt: new Date().toISOString(),
      lastSeenAt: existing?.lastSeenAt,
    });
    await auditLog({ tool: "oauth_sign_in", outcome: "success", user_id: userId, user_email: email });

    const ourCode = newSecret();
    this.codes.set(ourCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      userId,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
    return back({ code: ourCode });
  }

  // --- token endpoint ------------------------------------------------------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const issued = this.codes.get(authorizationCode);
    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return issued.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const issued = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode); // single use, even on failure
    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri !== undefined && redirectUri !== issued.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (!this.store.getUser(issued.userId)) throw new InvalidGrantError("User is no longer connected");
    return this.issueTokens(client.client_id, issued.userId);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const record = this.store.getRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Date.now() / 1000) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (!this.store.getUser(record.userId)) throw new InvalidGrantError("User is no longer connected");
    return this.issueTokens(client.client_id, record.userId, refreshToken);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(token);
    if (!record || record.expiresAt < Date.now() / 1000) throw new InvalidTokenError("Invalid or expired token");
    const user = this.store.getUser(record.userId);
    if (!user) throw new InvalidTokenError("User is no longer connected");
    return {
      token,
      clientId: record.clientId,
      scopes: [],
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
      extra: { userId: user.userId, email: user.email, name: user.name },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.revokeIssuedToken(request.token);
  }

  // --- helpers -------------------------------------------------------------

  private async issueTokens(clientId: string, userId: string, replacesRefreshToken?: string): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const base: Omit<IssuedToken, "expiresAt"> = { userId, clientId, resource: this.config.mcpUrl.toString() };
    const accessToken = newSecret();
    const refreshToken = newSecret();
    await this.store.saveTokenPair(
      { token: accessToken, record: { ...base, expiresAt: now + this.config.accessTokenTtlSeconds } },
      { token: refreshToken, record: { ...base, expiresAt: now + this.config.refreshTokenTtlSeconds } },
      replacesRefreshToken
    );
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
    };
  }

  private isOurResource(resource: string): boolean {
    return sameUrl(resource, this.config.mcpUrl.toString()) || sameUrl(resource, this.config.baseUrl.toString());
  }

  private emailAllowed(email: string | undefined): boolean {
    const domains = this.config.allowedEmailDomains;
    if (!domains.length) return true;
    const domain = email?.toLowerCase().split("@")[1];
    return Boolean(domain && domains.includes(domain));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}
