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

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
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
  private pending: Array<{ resolve: (result: ToolResult) => void; reject: (error: Error) => void }> = [];

  override async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolResult> {
    this.calls.push({ name, args, timeoutMs });
    return new Promise<ToolResult>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  resolveNext(result: ToolResult = fakeToolResult("done")): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending upstream call.");
    }
    pending.resolve(result);
  }

  rejectNext(error = new Error("upstream failed")): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending upstream call.");
    }
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
