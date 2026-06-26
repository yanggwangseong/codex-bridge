import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer, onResponseComplete } from "../src/server.js";
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

  it("treats CODEX_BRIDGE_ALLOWED_HOSTS as a complete hostname allowlist", async () => {
    const baseUrl = await start({
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
      CODEX_BRIDGE_ALLOWED_HOSTS: "127.0.0.1,example.ngrok.app"
    });

    const local = await fetch(`${baseUrl}/healthz`);
    expect(local.status).toBe(200);

    const allowedHost = await requestWithHost(`${baseUrl}/healthz`, "example.ngrok.app");
    expect(allowedHost.status).toBe(200);

    const deniedHost = await requestWithHost(`${baseUrl}/healthz`, "localhost");
    expect(deniedHost.status).toBe(403);
    expect(deniedHost.body).toContain("Invalid Host");
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

  it("releases HTTP concurrency and codex_read job slots when MCP clients abort mid-request", async () => {
    const upstream = new DeferredUpstream();
    const baseUrl = await start(
      {
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        CODEX_BRIDGE_FAST_RETURN_MS: "5000",
        CODEX_BRIDGE_HTTP_CONCURRENCY_MAX: "1"
      },
      upstream
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "codex_read",
        arguments: {
          prompt: "slow"
        }
      }
    });
    const url = new URL(`${baseUrl}/mcp`);
    const request = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    });
    request.on("error", () => {});
    request.write(body);
    request.end();

    await waitForCondition(() => upstream.calls.length === 1, "first upstream call");
    const closed = new Promise<void>((resolve) => {
      request.once("close", resolve);
    });
    request.destroy();
    await closed;
    await waitForCondition(
      () => upstream.abortedCalls === 1 && upstream.pendingCount === 0,
      "aborted call cleanup"
    );

    const invalidResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(invalidResponse.status).not.toBe(429);
    expect(invalidResponse.status).toBe(400);

    const nextRead = fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "codex_read",
          arguments: {
            prompt: "next"
          }
        }
      })
    });
    await waitForCondition(() => upstream.calls.length === 2, "second upstream call");
    upstream.resolveNext();
    const nextResponse = await nextRead;
    const nextBody = await nextResponse.text();

    expect(nextResponse.status).toBe(200);
    expect(nextBody).not.toContain("too_many_concurrent_requests");
    expect(nextBody).not.toContain("Another codex_read job is already running");
    expect(nextBody).toContain("completed");
  });

  it("runs response cleanup once when clients close before finish", () => {
    const response = new EventEmitter();
    let cleanupCount = 0;

    onResponseComplete(response, () => {
      cleanupCount += 1;
    });

    response.emit("close");
    response.emit("finish");
    response.emit("close");

    expect(cleanupCount).toBe(1);
  });

  it("runs response cleanup once when normal finish is followed by close", () => {
    const response = new EventEmitter();
    let cleanupCount = 0;

    onResponseComplete(response, () => {
      cleanupCount += 1;
    });

    response.emit("finish");
    response.emit("close");

    expect(cleanupCount).toBe(1);
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

async function requestWithHost(urlString: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          host
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
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

async function waitForCondition(condition: () => boolean, label = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
