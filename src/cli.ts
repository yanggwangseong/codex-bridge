#!/usr/bin/env node
import { loadConfig, stripOpenAiApiEnv } from "./config.js";
import { createHttpServer } from "./server.js";
import { CodexStdioUpstream } from "./upstream.js";

async function main(): Promise<void> {
  const config = loadConfig();
  stripOpenAiApiEnv();

  const upstream = new CodexStdioUpstream(config);
  await upstream.verifyReadOnlyStartup();

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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codex-bridge startup failed: ${message}`);
  process.exit(1);
});
