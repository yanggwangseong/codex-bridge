import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createBridgeMcpServer } from "../src/server.js";
import { DeferredUpstream, FakeUpstream, fakeToolResult, parseToolJson, tempRoot } from "./helpers.js";

describe("bridge tools", () => {
  it("exposes only the reduced read-only tool surface", async () => {
    const { client, close } = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual(["bridge_status", "codex_job_status", "codex_read"]);
    for (const tool of tools.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      });
    }
    expect(tools.tools.find((tool) => tool.name === "codex_read")?.inputSchema).toMatchObject({
      properties: {
        prompt: { maxLength: 12000 },
        cwd: { maxLength: 4096 }
      }
    });

    await close();
  });

  it("reports policy status without reading project files", async () => {
    const upstream = new FakeUpstream();
    const { client, close } = await connect({ upstream });
    const status = parseToolJson(
      await client.callTool({
        name: "bridge_status",
        arguments: {}
      })
    );

    expect(status).toMatchObject({
      ok: true,
      bridge: "codex-bridge",
      defaultSandbox: "read-only",
      approvalPolicy: "never",
      exposedTools: ["bridge_status", "codex_read", "codex_job_status"]
    });
    expect(upstream.calls).toHaveLength(0);

    await close();
  });

  it("forces read-only Codex payload and per-session config", async () => {
    const upstream = new FakeUpstream();
    const root = tempRoot();
    const { client, close } = await connect({ root, upstream });

    const result = parseToolJson(
      await client.callTool({
        name: "codex_read",
        arguments: {
          prompt: "Summarize files.",
          cwd: root
        }
      })
    );

    expect(result.status).toBe("completed");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toMatchObject({
      name: "codex",
      args: {
        cwd: realpathSync(root),
        sandbox: "read-only",
        "approval-policy": "never",
        config: {
          sandbox_mode: "read-only",
          approval_policy: "never",
          web_search: "disabled"
        }
      }
    });
    expect(String(upstream.calls[0].args.prompt)).toContain("repository contents");
    expect(String(upstream.calls[0].args.prompt)).toContain("User request:");

    await close();
  });

  it("blocks unsafe roots before upstream delegation", async () => {
    const upstream = new FakeUpstream();
    const root = tempRoot();
    const cleanSubdir = path.join(root, "src");
    mkdirSync(cleanSubdir);
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    const { client, close } = await connect({ root, upstream });

    const result = await client.callTool({
      name: "codex_read",
      arguments: {
        prompt: "Summarize files.",
        cwd: cleanSubdir
      }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("safe per-file exclusion");
    expect(JSON.stringify(result)).not.toContain(".env");
    expect(upstream.calls).toHaveLength(0);

    await close();
  });

  it("fast-returns and later reports completed jobs", async () => {
    const upstream = new DeferredUpstream();
    const { client, close } = await connect({
      upstream,
      env: {
        CODEX_BRIDGE_FAST_RETURN_MS: "5"
      }
    });

    const started = parseToolJson(
      await client.callTool({
        name: "codex_read",
        arguments: {
          prompt: "slow"
        }
      })
    );
    expect(started.status).toBe("running");
    expect(typeof started.jobId).toBe("string");

    upstream.resolveNext(fakeToolResult("done"));
    const completed = await waitForJobStatus(client, started.jobId, "completed");
    expect(completed).toMatchObject({
      status: "completed",
      operation: "codex_read"
    });
    expect(JSON.stringify(completed.result)).toContain("done");

    await close();
  });

  it("redacts sensitive-looking output", async () => {
    const upstream = new FakeUpstream();
    upstream.callTool = async () =>
      fakeToolResult('OPENAI_API_KEY=sk-1234567890abcdefghi\nRead /tmp/project/.env.local\nAuthorization: Bearer abcdefghijklmnop');
    const { client, close } = await connect({ upstream });

    const result = parseToolJson(
      await client.callTool({
        name: "codex_read",
        arguments: {
          prompt: "check"
        }
      })
    );

    expect(JSON.stringify(result)).not.toContain("sk-1234567890abcdefghi");
    expect(JSON.stringify(result)).not.toContain("/tmp/project/.env.local");
    expect(result.redactions).toEqual(expect.arrayContaining(["secret-assignment", "sensitive-path", "bearer-token"]));

    await close();
  });
});

async function connect(options: { root?: string; upstream?: FakeUpstream; env?: NodeJS.ProcessEnv } = {}) {
  const root = options.root || tempRoot();
  const config = loadConfig({
    CODEX_BRIDGE_ROOT: root,
    CODEX_BRIDGE_NO_AUTH: "1",
    CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
    ...options.env
  });
  const server = createBridgeMcpServer(config, options.upstream || new FakeUpstream());
  const client = new Client({
    name: "test-client",
    version: "0.0.0"
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
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
