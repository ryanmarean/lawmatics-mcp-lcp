import "./helpers.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lawmaticsGetOne } from "../src/lawmatics-client.js";
import { runWithUserContext } from "../src/session-context.js";
import { loadHostedConfig } from "../src/server/config.js";
import { jsonResponse, mockFetch } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ME = { data: { id: "42", type: "user", attributes: { email: "ann@firm.com" } } };

describe("per-user token selection", () => {
  it("uses the user's token from the request context, not the server-wide one", async () => {
    const fetchMock = mockFetch(jsonResponse(ME));
    await runWithUserContext({ userId: "42", getAccessToken: async () => "user-token" }, () =>
      lawmaticsGetOne("/users/me")
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer user-token" });
  });

  it("fails closed in hosted mode when no user context is present", async () => {
    vi.stubEnv("TRANSPORT", "http");
    const fetchMock = mockFetch(jsonResponse(ME));
    await expect(lawmaticsGetOne("/users/me")).rejects.toThrow(/Not signed in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps using LAWMATICS_ACCESS_TOKEN in stdio mode", async () => {
    const fetchMock = mockFetch(jsonResponse(ME));
    await lawmaticsGetOne("/users/me");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token" });
  });
});

describe("loadHostedConfig", () => {
  it("lists every missing setting at once", () => {
    expect(() => loadHostedConfig({})).toThrow(/MCP_BASE_URL[\s\S]*LAWMATICS_CLIENT_ID[\s\S]*LAWMATICS_CLIENT_SECRET[\s\S]*ENCRYPTION_KEY/);
  });

  it("requires https except for localhost", () => {
    const env = {
      LAWMATICS_CLIENT_ID: "a",
      LAWMATICS_CLIENT_SECRET: "b",
      LAWMATICS_MCP_ENCRYPTION_KEY: "a".repeat(64),
    };
    expect(() => loadHostedConfig({ ...env, MCP_BASE_URL: "http://mcp.example.com" })).toThrow(/https/);
    const cfg = loadHostedConfig({ ...env, MCP_BASE_URL: "https://mcp.example.com/" });
    expect(cfg.mcpUrl.toString()).toBe("https://mcp.example.com/mcp");
    expect(cfg.lawmaticsRedirectUri).toBe("https://mcp.example.com/oauth/lawmatics/callback");
    expect(cfg.allowedRedirectUris).toContain("https://claude.ai/api/mcp/auth_callback");
  });
});
