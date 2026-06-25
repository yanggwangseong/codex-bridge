import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import type { CodexUpstream } from "../src/upstream.js";
import { DeferredUpstream, FakeUpstream, parseToolJson, tempRoot } from "./helpers.js";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("http server", () => {
  it("serves health without auth", async () => {
    const baseUrl = await start({
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
    });

    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, bridge: "codex-bridge" });
  });

  it("requires Authorization bearer when token auth is configured", async () => {
    const baseUrl = await start({
      CODEX_BRIDGE_TOKEN: "secret"
    });

    const denied = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(allowed.status).not.toBe(401);
  });

  it("keeps async codex_read jobs across stateless HTTP MCP requests", async () => {
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      {
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        CODEX_BRIDGE_FAST_RETURN_MS: "5"
      },
      upstream
    );
    const client = new Client({
      name: "http-test-client",
      version: "0.0.0"
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

    const started = parseToolJson(
      await client.callTool({
        name: "codex_read",
        arguments: {
          prompt: "slow"
        }
      })
    );
    expect(started.status).toBe("running");

    upstream.resolveNext();
    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed.status).toBe("completed");

    await client.close();
  });

  it("returns not implemented OAuth metadata response", async () => {
    const baseUrl = await start({
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
    });

    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: "oauth_not_implemented" });
  });
});

async function start(env: NodeJS.ProcessEnv, upstream: CodexUpstream = new FakeUpstream()): Promise<string> {
  const config = loadConfig({
    ...env,
    CODEX_BRIDGE_ROOT: tempRoot(),
    CODEX_BRIDGE_HOST: "127.0.0.1",
    CODEX_BRIDGE_PORT: "1"
  });
  const server = createHttpServer(config, upstream);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitForJobStatus(client: Client, jobId: string, expected: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = parseToolJson(
      await client.callTool({
        name: "codex_job_status",
        arguments: {
          jobId
        }
      })
    );
    if (status.status === expected) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
