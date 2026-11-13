#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { isReadOnly } from "./tool-helpers.js";
import { isHostedMode } from "./session-context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), quiet: true });

const command = process.argv[2];

async function main(): Promise<void> {
  // `npx @oktopeak/lawmatics-mcp auth` runs the one-time OAuth flow instead of the server.
  if (command === "auth") {
    const { runAuthFlow } = await import("./auth.js");
    await runAuthFlow();
    return;
  }

  // Hosted-mode admin commands: list connected users / disconnect one (offboarding).
  if (command === "users") {
    const { runUsersCommand } = await import("./server/admin.js");
    await runUsersCommand(process.argv.slice(3));
    return;
  }

  if (isHostedMode()) {
    const { loadHostedConfig } = await import("./server/config.js");
    const { Store } = await import("./server/store.js");
    const { startHttpServer } = await import("./server/http.js");
    const config = loadHostedConfig();
    const store = await Store.open(config.dataDir, config.encryptionKey);
    await startHttpServer(config, store);
    return;
  }

  if (!process.env.LAWMATICS_ACCESS_TOKEN) {
    console.error("[lawmatics-mcp] WARNING: LAWMATICS_ACCESS_TOKEN is not set.");
    console.error(
      "[lawmatics-mcp] Run `npx @oktopeak/lawmatics-mcp auth` to obtain a token (it never expires),"
    );
    console.error("[lawmatics-mcp] then add it to this server's env config. Starting anyway so auth-status can guide you.");
  }

  const { createMcpServer } = await import("./create-server.js");
  const server = createMcpServer();

  if (isReadOnly()) {
    console.error("[lawmatics-mcp] Read-only mode: write tools are disabled (LAWMATICS_READ_ONLY is set).");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[lawmatics-mcp] Server running on stdio. Ready for connections.");
}

try {
  await main();
} catch (err) {
  console.error(`[lawmatics-mcp] ${command === "auth" ? "Auth failed: " : ""}${(err as Error).message}`);
  process.exitCode = 1;
}
