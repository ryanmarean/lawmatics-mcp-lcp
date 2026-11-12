import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "module";

import { registerMatterTools } from "./tools/matters.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerFirmTools } from "./tools/firm.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerEventTools } from "./tools/events.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerTagTools } from "./tools/tags.js";
import { registerCustomFieldTools } from "./tools/custom-fields.js";
import { registerFormTools } from "./tools/forms.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerAuthStatusResource } from "./resources/auth-status.js";

const _require = createRequire(import.meta.url);
export const { version } = _require("../package.json") as { version: string };

/** A fully registered MCP server. stdio uses one; hosted mode builds one per session. */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "lawmatics-mcp", version });

  registerMatterTools(server);
  registerContactTools(server);
  registerCompanyTools(server);
  registerFirmTools(server);
  registerTaskTools(server);
  registerEventTools(server);
  registerNoteTools(server);
  registerTagTools(server);
  registerCustomFieldTools(server);
  registerFormTools(server);
  registerBillingTools(server);
  registerAuthStatusResource(server);

  return server;
}
