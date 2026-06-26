import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("detects sensitive files and symlink escapes inside generated dependency directories", () => {
    const root = tempRoot();
    const other = tempRoot();
    mkdirSync(path.join(root, "node_modules", "package"), { recursive: true });
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(other, "target.txt"), "outside\n");
    symlinkSync(path.join(other, "target.txt"), path.join(root, "node_modules", "package", "outside-link"));
    writeFileSync(path.join(root, "dist", ".env.local"), "TOKEN=secret\n");

    const scan = scanRootSafety(root);
    expect(scan.symlinkEscapes).toContain(path.join(root, "node_modules", "package", "outside-link"));
    expect(scan.sensitiveFiles).toContain(path.join(root, "dist", ".env.local"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("does not include external realpaths in cwd escape errors", () => {
    const root = tempRoot();
    const other = tempRoot();
    writeFileSync(path.join(other, "target.txt"), "outside\n");
    symlinkSync(path.join(other, "target.txt"), path.join(root, "outside-link"));
    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_NO_AUTH: "1",
      CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
    });

    expect(() => resolveAllowedCwd(path.join(root, "outside-link"), config)).toThrow("cwd is outside CODEX_BRIDGE_ROOT.");
    expect(() => resolveAllowedCwd(path.join(root, "outside-link"), config)).not.toThrow(realpathSync(other));
  });

  it("detects credential-bearing git metadata without blocking normal git config", () => {
    const root = tempRoot();
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir);
    writeFileSync(
      path.join(gitDir, "config"),
      '[remote "origin"]\nurl = https://github.com/example/repo.git\n[remote "mirror"]\nurl = https://git@github.com/example/repo.git\n'
    );

    expect(scanRootSafety(root).sensitiveFiles).toEqual([]);

    writeFileSync(
      path.join(gitDir, "config"),
      '[remote "origin"]\nurl = https://user:ghp_exampleSECRET1234567890@github.com/example/repo.git\n'
    );

    const scan = scanRootSafety(root);
    expect(scan.sensitiveFiles).toContain(path.join(gitDir, "config"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("detects git authorization extraheaders", () => {
    const root = tempRoot();
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir);
    writeFileSync(path.join(gitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(gitDir, "config"));
  });

  it("detects credential-bearing git metadata symlinks inside the root", () => {
    const root = realpathSync(tempRoot());
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir);
    writeFileSync(
      path.join(root, "git-config-copy"),
      '[remote "origin"]\nurl = https://user:ghp_exampleSECRET1234567890@github.com/example/repo.git\n'
    );
    symlinkSync(path.join(root, "git-config-copy"), path.join(gitDir, "config"));

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(gitDir, "config"));
  });

  it("detects credential-bearing .gitmodules symlinks inside the root", () => {
    const root = realpathSync(tempRoot());
    writeFileSync(
      path.join(root, "gitmodules-copy"),
      '[submodule "private"]\nurl = https://user:ghp_exampleSECRET1234567890@github.com/example/private.git\n'
    );
    symlinkSync(path.join(root, "gitmodules-copy"), path.join(root, ".gitmodules"));

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(root, ".gitmodules"));
  });

  it("detects git metadata symlinks that escape the root", () => {
    const root = realpathSync(tempRoot());
    const other = realpathSync(tempRoot());
    const gitDir = path.join(root, ".git");
    mkdirSync(gitDir);
    writeFileSync(path.join(other, "config"), '[remote "origin"]\nurl = https://github.com/example/repo.git\n');
    symlinkSync(path.join(other, "config"), path.join(gitDir, "config"));

    expect(scanRootSafety(root).symlinkEscapes).toContain(path.join(gitDir, "config"));
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
