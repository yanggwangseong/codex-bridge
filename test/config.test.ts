import { realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRootSafeForDelegation,
  buildCodexStartupArgs,
  loadConfig,
  resolveAllowedCwd,
  scanRootSafety
} from "../src/config.js";
import { buildChildEnv } from "../src/upstream.js";
import { tempRoot } from "./helpers.js";

describe("config policy", () => {
  it("requires explicit local smoke acknowledgement for no-auth", () => {
    const root = tempRoot();

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_NO_AUTH: "1"
      })
    ).toThrow(/LOCAL_SMOKE_TEST/);

    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
    });
    expect(config.noAuth).toBe(true);
    expect(config.allowedRoot).toBe(realpathSync(root));
  });

  it("rejects non-local bind and public generic no-auth exposure", () => {
    const root = tempRoot();

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_HOST: "0.0.0.0",
        CODEX_BRIDGE_TOKEN: "token"
      })
    ).toThrow(/OAuth 2.1/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        CODEX_BRIDGE_PUBLIC_BASE_URL: "https://example.ngrok.app"
      })
    ).toThrow(/Public\/generic/);
  });

  it("fails closed when OpenAI API env names are present", () => {
    const root = tempRoot();

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        OPENAI_API_KEY: "not-read"
      })
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("requires exactly one absolute root and rejects cwd outside it", () => {
    const root = tempRoot();
    const other = tempRoot();
    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
    });

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: `${root},${other}`,
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
      })
    ).toThrow(/exactly one root/);

    expect(resolveAllowedCwd(undefined, config)).toBe(realpathSync(root));
    expect(() => resolveAllowedCwd(other, config)).toThrow(/outside CODEX_BRIDGE_ROOT/);
  });

  it("detects sensitive files and symlink escapes", () => {
    const root = tempRoot();
    const other = tempRoot();
    writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
    writeFileSync(path.join(other, "target.txt"), "outside\n");
    symlinkSync(path.join(other, "target.txt"), path.join(root, "outside-link"));

    const scan = scanRootSafety(root);
    expect(scan.sensitiveFiles).toContain(path.join(root, ".env"));
    expect(scan.symlinkEscapes).toContain(path.join(root, "outside-link"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("builds explicit read-only Codex startup args and sanitized child env", () => {
    const root = tempRoot();
    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
      CODEX_BRIDGE_SAFE_PATH: "/usr/bin:/bin",
      CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST: "1",
      OPENAI_API_KEY: "not-forwarded"
    });

    expect(buildCodexStartupArgs(config)).toEqual(
      expect.arrayContaining([
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "--strict-config",
        'sandbox_mode="read-only"',
        'approval_policy="never"',
        'web_search="disabled"',
        "mcp-server"
      ])
    );
    const childEnv = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      OPENAI_API_KEY: "not-forwarded"
    });
    expect(childEnv).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/test" });
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
  });
});
