#!/usr/bin/env node
import { loadConfig, stripOpenAiApiEnv } from "./config.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeMcpServer, createHttpServer } from "./server.js";
import { CodexStdioUpstream } from "./upstream.js";

type BridgeTransport = "http" | "stdio";

async function main(): Promise<void> {
  const config = loadConfig();
  const transportMode = loadTransportMode();
  stripOpenAiApiEnv();

  const upstream = new CodexStdioUpstream(config);
  await upstream.verifyReadOnlyStartup();

  if (transportMode === "stdio") {
    const server = createBridgeMcpServer(config, upstream);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("codex-bridge stdio MCP ready (read-only tools: bridge_status, codex_read, codex_job_status)\n");

    async function shutdown(signal: string): Promise<void> {
      process.stderr.write(`received ${signal}, shutting down\n`);
      await server.close();
      await transport.close();
      await upstream.close();
      process.exit(0);
    }

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    return;
  }

  const server = createHttpServer(config, upstream);
  server.listen(config.port, config.host, () => {
    const authHint = config.noAuth ? "local no-auth smoke mode" : "Authorization bearer required";
    console.log(`codex-bridge listening on http://${config.host}:${config.port}/mcp (${authHint})`);
    console.log(`allowed root: ${config.companyMode ? "[redacted-company-root]" : config.allowedRoot}`);
    console.log("exposed tools: bridge_status, codex_read, codex_job_status");
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`received ${signal}, shutting down`);
    server.close();
    await upstream.close();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function loadTransportMode(env: NodeJS.ProcessEnv = process.env): BridgeTransport {
  const raw = (env.CODEX_BRIDGE_TRANSPORT || "http").trim().toLowerCase();
  if (raw === "http" || raw === "stdio") {
    return raw;
  }
  throw new Error("CODEX_BRIDGE_TRANSPORT must be either 'http' or 'stdio'.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-bridge startup failed: ${message}`);
  process.exit(1);
});
