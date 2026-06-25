import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";

export class FakeUpstream implements CodexUpstream {
  public calls: Array<{ name: string; args: Record<string, unknown>; timeoutMs: number }> = [];

  async listTools(): Promise<unknown> {
    return {
      tools: [{ name: "codex" }, { name: "codex-reply" }]
    };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    if (signal?.aborted) {
      throw new Error("Upstream call aborted.");
    }
    this.calls.push({ name, args, timeoutMs });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, name, args })
        }
      ]
    };
  }

  async close(): Promise<void> {}
}

export class DeferredUpstream extends FakeUpstream {
  private pending: Array<{
    resolve: (result: ToolResult) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }> = [];
  public abortedCalls = 0;

  get pendingCount(): number {
    return this.pending.length;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    this.calls.push({ name, args, timeoutMs });
    return new Promise<ToolResult>((resolve, reject) => {
      if (signal?.aborted) {
        this.abortedCalls += 1;
        reject(new Error("Upstream call aborted."));
        return;
      }
      const pending = {
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = () => {
        this.abortedCalls += 1;
        this.pending = this.pending.filter((item) => item !== pending);
        pending.cleanup();
        reject(new Error("Upstream call aborted."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(pending);
    });
  }

  resolveNext(result: ToolResult = fakeToolResult("done")): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending upstream call.");
    }
    pending.cleanup();
    pending.resolve(result);
  }

  rejectNext(error = new Error("upstream failed")): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending upstream call.");
    }
    pending.cleanup();
    pending.reject(error);
  }
}

export function tempRoot(prefix = "codex-bridge-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function fakeToolResult(text: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

export function parseToolJson(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return JSON.parse(content?.[0]?.text || "{}");
}
