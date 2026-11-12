import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getApiBase } from "../lawmatics-client.js";
import { isReadOnly } from "../tool-helpers.js";
import { getUserContext, isHostedMode } from "../session-context.js";

function stdioStatus() {
  const hasToken = Boolean(process.env.LAWMATICS_ACCESS_TOKEN);
  return {
    mode: "stdio",
    token_configured: hasToken,
    api_base: getApiBase(),
    read_only_mode: isReadOnly(),
    guidance: hasToken
      ? "Token is configured. Call the get-current-user tool to verify it works."
      : "LAWMATICS_ACCESS_TOKEN is not set. Run `npx @oktopeak/lawmatics-mcp auth` to obtain one " +
        "(requires a Lawmatics developer app — ask Lawmatics support to enable Developer Settings), " +
        "then add the token to this server's env config.",
  };
}

function hostedStatus() {
  const ctx = getUserContext();
  return {
    mode: "hosted",
    signed_in: Boolean(ctx),
    ...(ctx ? { lawmatics_user_id: ctx.userId, email: ctx.email, name: ctx.name } : {}),
    api_base: getApiBase(),
    read_only_mode: isReadOnly(),
    guidance: ctx
      ? "Signed in. Lawmatics calls run as this user."
      : "Not signed in. Reconnect the Lawmatics connector in Claude to sign in.",
  };
}

export function registerAuthStatusResource(server: McpServer): void {
  server.resource("auth-status", "lawmatics://auth-status", async () => {
    const status = isHostedMode() ? hostedStatus() : stdioStatus();
    return {
      contents: [
        { uri: "lawmatics://auth-status", mimeType: "application/json", text: JSON.stringify(status, null, 2) },
      ],
    };
  });
}
