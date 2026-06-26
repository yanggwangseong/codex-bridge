import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildCodexReadPayload, CodexStdioUpstream } from "../src/upstream.js";
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

  it("rejects forbidden upstream tool names before starting upstream", async () => {
    const upstream = createUpstream({
      CODEX_BRIDGE_CODEX: "definitely-not-a-real-codex-command"
    });

    await expect(upstream.callTool("not-codex", { prompt: "read" }, 100)).rejects.toThrow(
      "Bridge policy forbids calling upstream tool: not-codex"
    );
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
        resetTimeoutOnProgress: true
      })
    );
    expect(capturedOptions?.timeout).toEqual(expect.any(Number));
    expect(capturedOptions?.timeout).toBeGreaterThan(0);
    expect(capturedOptions?.timeout).toBeLessThanOrEqual(123);
    expect(capturedOptions?.maxTotalTimeout).toBe(capturedOptions?.timeout);
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
    await withTimeout(callToolEntered, "SDK callTool entry");
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

  it("cleans up deadline timers and parent abort listeners after SDK rejections", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      const client = {
        callTool: vi.fn(async (_params, _schema, options) => {
          capturedSignal = options.signal;
          throw new Error("SDK call failed");
        })
      };
      const upstream = createUpstreamWithClient(client);

      await expect(upstream.callTool("codex", { prompt: "read" }, 100, controller.signal)).rejects.toThrow(
        "SDK call failed"
      );
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

  it("applies the total deadline while connecting to upstream", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      let enteredConnect: () => void = () => {};
      const connectEntered = new Promise<void>((resolve) => {
        enteredConnect = resolve;
      });
      const upstream = createUpstream();
      (upstream as unknown as { connect: (options?: { signal?: AbortSignal }) => Promise<never> }).connect = vi.fn(
        (options) => {
          capturedSignal = options?.signal;
          enteredConnect();
          return waitForAbort(options?.signal || new AbortController().signal);
        }
      );

      const result = upstream.callTool("codex", { prompt: "read" }, 100);
      await withTimeout(connectEntered, "upstream connect entry");
      const rejection = expect(result).rejects.toThrow("exceeded 100ms total timeout");
      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts while waiting for an already-started upstream connection", async () => {
    const client = {
      listTools: vi.fn(async () => ({ tools: [{ name: "codex" }] })),
      callTool: vi.fn(async () => fakeToolResult("ok"))
    };
    let enteredConnect: () => void = () => {};
    let resolveConnect: (client: unknown) => void = () => {};
    const connectEntered = new Promise<void>((resolve) => {
      enteredConnect = resolve;
    });
    const upstream = createUpstream();
    (upstream as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
          enteredConnect();
        })
    );

    const firstConnection = upstream.listTools();
    await withTimeout(connectEntered, "upstream connect entry");
    const controller = new AbortController();
    const result = upstream.callTool("codex", { prompt: "read" }, 1000, controller.signal);

    controller.abort(new Error("client disconnected during connect"));

    await expect(result).rejects.toThrow("client disconnected during connect");
    resolveConnect(client);
    await expect(firstConnection).resolves.toEqual({ tools: [{ name: "codex" }] });
  });

  it("uses the remaining total deadline for SDK tool calls after connecting", async () => {
    vi.useFakeTimers();
    try {
      let capturedOptions: Record<string, unknown> | undefined;
      const client = {
        callTool: vi.fn(async (_params, _schema, options) => {
          capturedOptions = options;
          return fakeToolResult("ok");
        })
      };
      const upstream = createUpstream();
      (upstream as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(client), 60))
      );

      const result = upstream.callTool("codex", { prompt: "read" }, 100);
      await vi.advanceTimersByTimeAsync(60);
      await result;

      expect(capturedOptions).toEqual(
        expect.objectContaining({
          timeout: 40,
          maxTotalTimeout: 40
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries upstream connections after a connection failure", async () => {
    const client = {
      callTool: vi.fn(async () => fakeToolResult("ok"))
    };
    const upstream = createUpstream();
    let attempts = 0;
    (upstream as unknown as { connect: () => Promise<unknown> }).connect = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("first connect failed");
      }
      return client;
    });

    await expect(upstream.callTool("codex", { prompt: "first" }, 1000)).rejects.toThrow("first connect failed");
    await expect(upstream.callTool("codex", { prompt: "second" }, 1000)).resolves.toEqual(fakeToolResult("ok"));
    expect(attempts).toBe(2);
  });

  it("does not echo the absolute root in company-mode policy prompts", () => {
    const root = tempRoot();
    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_TOKEN: "secret",
      CODEX_BRIDGE_COMPANY_MODE: "1",
      CODEX_BRIDGE_ROOT_ISOLATION_ACK: "1"
    });

    const payload = buildCodexReadPayload({
      config,
      prompt: "Summarize files.",
      cwd: config.allowedRoot
    });

    expect(String(payload.prompt)).toContain("configured working directory");
    expect(String(payload.prompt)).not.toContain(config.allowedRoot);
  });
});

function createUpstream(env: NodeJS.ProcessEnv = {}): CodexStdioUpstream {
  return new CodexStdioUpstream(
    loadConfig({
      CODEX_BRIDGE_ROOT: tempRoot(),
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
      ...env
    })
  );
}

function createUpstreamWithClient(client: unknown): CodexStdioUpstream {
  const upstream = createUpstream();
  (upstream as unknown as { client: unknown }).client = client;
  return upstream;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
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
