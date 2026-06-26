import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CodexStdioUpstream } from "../src/upstream.js";
import { fakeToolResult, tempRoot } from "./helpers.js";

describe("codex stdio upstream", () => {
  it("rejects forbidden upstream tool names before calling the SDK client", async () => {
    const client = {
      callTool: vi.fn()
    };
    const upstream = createUpstreamWithClient(client);

    await expect(upstream.callTool("not-codex", { prompt: "read" }, 100)).rejects.toThrow(
      "Bridge policy forbids calling upstream tool: not-codex"
    );
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("passes cancellation and timeout options to the SDK client", async () => {
    const controller = new AbortController();
    let capturedOptions: Record<string, unknown> | undefined;
    const client = {
      callTool: vi.fn(async (_params, _schema, options) => {
        capturedOptions = options;
        return fakeToolResult("ok");
      })
    };
    const upstream = createUpstreamWithClient(client);

    await upstream.callTool("codex", { prompt: "read" }, 123, controller.signal);

    expect(client.callTool).toHaveBeenCalledWith(
      {
        name: "codex",
        arguments: {
          prompt: "read"
        }
      },
      undefined,
      expect.objectContaining({
        timeout: 123,
        maxTotalTimeout: 123,
        resetTimeoutOnProgress: true
      })
    );
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it("propagates parent aborts into the SDK call signal", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    let enteredCallTool: () => void = () => {};
    const callToolEntered = new Promise<void>((resolve) => {
      enteredCallTool = resolve;
    });
    const client = {
      callTool: vi.fn((_params, _schema, options) => {
        capturedSignal = options.signal;
        enteredCallTool();
        return waitForAbort(options.signal);
      })
    };
    const upstream = createUpstreamWithClient(client);

    const result = upstream.callTool("codex", { prompt: "read" }, 1000, controller.signal);
    await callToolEntered;
    expect(capturedSignal?.aborted).toBe(false);

    controller.abort(new Error("client disconnected"));

    await expect(result).rejects.toThrow("client disconnected");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("cleans up deadline timers and parent abort listeners after successful SDK responses", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      const client = {
        callTool: vi.fn(async (_params, _schema, options) => {
          capturedSignal = options.signal;
          return fakeToolResult("ok");
        })
      };
      const upstream = createUpstreamWithClient(client);

      await upstream.callTool("codex", { prompt: "read" }, 100, controller.signal);
      expect(capturedSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(capturedSignal?.aborted).toBe(false);

      controller.abort(new Error("client disconnected"));
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces an absolute upstream deadline independent of SDK progress resets", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        callTool: vi.fn((_params, _schema, options) => waitForAbort(options.signal))
      };
      const upstream = createUpstreamWithClient(client);

      const result = upstream.callTool("codex", { prompt: "read" }, 100);
      const rejection = expect(result).rejects.toThrow("exceeded 100ms total timeout");
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

function createUpstreamWithClient(client: unknown): CodexStdioUpstream {
  const config = loadConfig({
    CODEX_BRIDGE_ROOT: tempRoot(),
    CODEX_BRIDGE_NO_AUTH: "1",
    CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
  });
  const upstream = new CodexStdioUpstream(config);
  (upstream as unknown as { client: unknown }).client = client;
  return upstream;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(toError(signal.reason));
      },
      { once: true }
    );
  });
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
