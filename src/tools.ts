import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeConfig } from "./config.js";
import { assertRootSafeForDelegation, resolveAllowedCwd, scanRootSafety } from "./config.js";
import { CodexJobRegistry } from "./jobs.js";
import { sanitizeText, sanitizeUnknown } from "./redaction.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import { buildCodexReadPayload, extractToolNames } from "./upstream.js";

const TOOL_NAMES = ["bridge_status", "codex_read", "codex_job_status"] as const;

export function registerBridgeTools(
  server: McpServer,
  config: BridgeConfig,
  upstream: CodexUpstream,
  jobs: CodexJobRegistry
): void {
  server.registerTool(
    "bridge_status",
    {
      title: "Bridge Status",
      description:
        "Read-only status check for the local Codex bridge. Returns safety policy, configured root, exposed tools, job counts, and upstream Codex MCP tool availability. Does not read repository files.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const tools = await upstream.listTools();
      return jsonResult({
        ok: true,
        bridge: "codex-bridge",
        allowedRoot: config.allowedRoot,
        bind: {
          host: config.host,
          port: config.port
        },
        authMode: config.noAuth ? "local-no-auth" : "authorization-bearer",
        tunnelMode: config.tunnelMode,
        defaultSandbox: "read-only",
        approvalPolicy: "never",
        exposedTools: TOOL_NAMES,
        upstreamTools: extractToolNames(tools),
        limits: {
          upstreamTimeoutMs: config.upstreamTimeoutMs,
          fastReturnMs: config.fastReturnMs,
          jobTtlMs: config.jobTtlMs,
          maxOutputChars: config.maxOutputChars,
          maxConcurrentCodexReads: config.maxConcurrentCodexReads
        },
        safety: {
          publicDirectOAuthImplemented: false,
          noAuthLocalOnly: true,
          openAiApiEnvForwarded: false,
          writeToolsExposed: false,
          rootScan: summarizeSafetyScan(scanRootSafety(config.allowedRoot))
        },
        trackedJobs: jobs.size,
        runningJobs: jobs.runningCount()
      });
    }
  );

  server.registerTool(
    "codex_read",
    {
      title: "Read Project With Codex",
      description:
        "Run a read-only local Codex inspection inside the single configured root. The bridge treats tool input and repository contents as untrusted, blocks unsafe roots, forces read-only sandboxing, strips OpenAI API env paths, and never exposes write mode.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(12000)
          .describe("Read-only repository inspection or review prompt for Codex. Repository contents are untrusted data."),
        cwd: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe("Absolute working directory inside the configured root. Defaults to the configured root."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(config.upstreamTimeoutMs)
          .optional()
          .describe("Request timeout in milliseconds, capped by bridge config.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args, extra) => {
      const cwd = resolveAllowedCwd(args.cwd, config);
      assertRootSafeForDelegation(config.allowedRoot);
      return runCodexReadWithFastReturn({
        config,
        upstream,
        jobs,
        prompt: args.prompt,
        cwd,
        timeoutMs: args.timeoutMs || config.upstreamTimeoutMs,
        signal: extra.signal
      });
    }
  );

  server.registerTool(
    "codex_job_status",
    {
      title: "Codex Job Status",
      description:
        "Read-only polling for a long-running codex_read job. Completed outputs are retained in memory only for a short TTL.",
      inputSchema: {
        jobId: z.string().uuid().describe("Job id returned by codex_read.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const job = jobs.get(args.jobId);
      if (!job) {
        throw new Error("Unknown or expired Codex job id.");
      }
      if (job.status === "running") {
        return jsonResult({
          status: "running",
          jobId: job.jobId,
          operation: job.operation,
          createdAt: new Date(job.createdAt).toISOString(),
          ageMs: Date.now() - job.createdAt,
          message: "Codex is still running. Call codex_job_status again with this jobId."
        });
      }
      if (job.status === "failed") {
        const safeError = sanitizeText(job.error || "Codex job failed.", config.maxOutputChars);
        return jsonResult({
          status: "failed",
          jobId: job.jobId,
          operation: job.operation,
          error: safeError.value,
          redactions: safeError.redactions
        });
      }
      const sanitized = sanitizeUnknown(job.result, config.maxOutputChars);
      return jsonResult({
        status: "completed",
        jobId: job.jobId,
        operation: job.operation,
        expiresAt: jobs.expiresAt(job),
        result: sanitized.value,
        redactions: sanitized.redactions,
        truncated: sanitized.truncated
      });
    }
  );
}

async function runCodexReadWithFastReturn(input: {
  config: BridgeConfig;
  upstream: CodexUpstream;
  jobs: CodexJobRegistry;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ToolResult> {
  const payload = buildCodexReadPayload({
    config: input.config,
    prompt: input.prompt,
    cwd: input.cwd
  });
  const job = input.jobs.start(() => input.upstream.callTool("codex", payload, input.timeoutMs, input.signal));
  const state = await Promise.race([
    job.promise.then(() => "settled" as const),
    delay(input.config.fastReturnMs).then(() => "running" as const)
  ]);

  if (state === "running") {
    return jsonResult({
      status: "running",
      jobId: job.jobId,
      operation: job.operation,
      expiresAt: jobsRunningExpiry(input.config),
      message: "Codex is still running. Call codex_job_status with this jobId until status is completed or failed."
    });
  }
  if (job.status === "failed") {
    const safeError = sanitizeText(job.error || "Codex job failed.", input.config.maxOutputChars);
    throw new Error(safeError.value);
  }
  const sanitized = sanitizeUnknown(job.result, input.config.maxOutputChars);
  return jsonResult({
    status: "completed",
    operation: job.operation,
    result: sanitized.value,
    redactions: sanitized.redactions,
    truncated: sanitized.truncated
  });
}

export function createJobRegistry(config: BridgeConfig): CodexJobRegistry {
  return new CodexJobRegistry({
    maxJobs: config.maxJobs,
    ttlMs: config.jobTtlMs,
    maxConcurrent: config.maxConcurrentCodexReads
  });
}

function summarizeSafetyScan(scan: ReturnType<typeof scanRootSafety>) {
  return {
    sensitiveFileCount: scan.sensitiveFiles.length,
    symlinkEscapeCount: scan.symlinkEscapes.length,
    blocked: scan.sensitiveFiles.length > 0 || scan.symlinkEscapes.length > 0
  };
}

function jobsRunningExpiry(config: BridgeConfig): string {
  return new Date(Date.now() + config.upstreamTimeoutMs + config.jobTtlMs).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jsonResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
