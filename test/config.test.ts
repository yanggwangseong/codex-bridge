import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
import { companyModeEnv, tempRoot } from "./helpers.js";

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

  it("rejects ambiguous no-auth and bearer-token configuration", () => {
    const root = tempRoot();

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1"
      })
    ).toThrow(/mutually exclusive/);
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
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_PUBLIC_BASE_URL: "https://example.ngrok.app"
      })
    ).toThrow(/Public\/generic/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        CODEX_BRIDGE_TUNNEL_MODE: "openai-secure",
        CODEX_BRIDGE_PUBLIC_BASE_URL: "https://example.ngrok.app"
      })
    ).toThrow(/PUBLIC_BASE_URL cannot be set in no-auth mode/);
  });

  it("requires stricter startup guardrails in company mode", () => {
    const root = tempRoot();

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_COMPANY_MODE: "1"
      })
    ).toThrow(/ROOT_ISOLATION_ACK/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_NO_AUTH: "1",
        CODEX_BRIDGE_LOCAL_SMOKE_TEST: "1",
        CODEX_BRIDGE_COMPANY_MODE: "1",
        CODEX_BRIDGE_ROOT_ISOLATION_ACK: "1"
      })
    ).toThrow(/forbids CODEX_BRIDGE_NO_AUTH/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_COMPANY_MODE: "1",
        CODEX_BRIDGE_ROOT_ISOLATION_ACK: "1",
        CODEX_BRIDGE_TUNNEL_MODE: "openai-secure",
        CODEX_BRIDGE_PUBLIC_BASE_URL: "https://example.ngrok.app"
      })
    ).toThrow(/does not accept CODEX_BRIDGE_PUBLIC_BASE_URL/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_COMPANY_MODE: "1",
        CODEX_BRIDGE_ROOT_ISOLATION_ACK: "1"
      })
    ).toThrow(/CODEX_BRIDGE_CODEX.*absolute/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_CODEX: process.execPath,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_COMPANY_MODE: "1",
        CODEX_BRIDGE_ROOT_ISOLATION_ACK: "1"
      })
    ).toThrow(/CODEX_BRIDGE_COMPANY_HOME/);

    const env = companyModeEnv({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_COMPANY_CODEX_HOME: undefined,
      CODEX_BRIDGE_COMPANY_TMPDIR: undefined
    });
    const config = loadConfig(env);
    expect(config.companyMode).toBe(true);
    expect(config.noAuth).toBe(false);
    expect(config.allowedRoot).toBe(realpathSync(root));
    expect(config.codexCommand).toBe(process.execPath);
    expect(config.companyHome).toBe(realpathSync(env.CODEX_BRIDGE_COMPANY_HOME as string));
    expect(config.companyCodexHome).toBe(config.companyHome);
    expect(config.companyTmpDir).toBe(config.companyHome);

    const splitEnv = companyModeEnv({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_COMPANY_HOME: tempRoot("codex-bridge-company-home-"),
      CODEX_BRIDGE_COMPANY_CODEX_HOME: tempRoot("codex-bridge-company-codex-home-"),
      CODEX_BRIDGE_COMPANY_TMPDIR: tempRoot("codex-bridge-company-tmp-")
    });
    const splitConfig = loadConfig(splitEnv);
    expect(splitConfig.companyHome).toBe(realpathSync(splitEnv.CODEX_BRIDGE_COMPANY_HOME as string));
    expect(splitConfig.companyCodexHome).toBe(realpathSync(splitEnv.CODEX_BRIDGE_COMPANY_CODEX_HOME as string));
    expect(splitConfig.companyTmpDir).toBe(realpathSync(splitEnv.CODEX_BRIDGE_COMPANY_TMPDIR as string));

    const defaultPathConfig = loadConfig(
      companyModeEnv({
        CODEX_BRIDGE_ROOT: root,
        PATH: "/Users/test/bin"
      })
    );
    expect(defaultPathConfig.safePath).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("builds an isolated child environment in company mode", () => {
    const root = tempRoot();
    const config = loadConfig(
      companyModeEnv({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_SAFE_PATH: "/usr/bin:/bin"
      })
    );
    const childEnv = buildChildEnv(
      {
        PATH: "/host/bin",
        HOME: "/Users/test",
        CODEX_HOME: "/Users/test/.codex",
        TMPDIR: "/var/folders/host",
        SHELL: "/bin/zsh",
        USER: "test",
        LOGNAME: "test",
        TERM: "xterm",
        LC_ALL: "ko_KR.UTF-8",
        OPENAI_API_KEY: "not-forwarded"
      },
      config
    );

    expect(childEnv).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: config.companyHome,
      CODEX_HOME: config.companyCodexHome,
      TMPDIR: config.companyTmpDir,
      LANG: "C.UTF-8"
    });
    expect(JSON.stringify(childEnv)).not.toContain("/Users/test");
    expect(JSON.stringify(childEnv)).not.toContain("/var/folders/host");
    expect(childEnv).not.toHaveProperty("SHELL");
    expect(childEnv).not.toHaveProperty("USER");
    expect(childEnv).not.toHaveProperty("LOGNAME");
    expect(childEnv).not.toHaveProperty("TERM");
    expect(childEnv).not.toHaveProperty("LC_ALL");
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("rejects non-directory company child environment roots", () => {
    const root = tempRoot();
    const file = path.join(root, "home-file");
    writeFileSync(file, "not a directory\n");

    expect(() =>
      loadConfig(
        companyModeEnv({
          CODEX_BRIDGE_ROOT: root,
          CODEX_BRIDGE_COMPANY_HOME: file
        })
      )
    ).toThrow(/CODEX_BRIDGE_COMPANY_HOME must be a directory/);

    expect(() =>
      loadConfig(
        companyModeEnv({
          CODEX_BRIDGE_ROOT: root,
          CODEX_BRIDGE_COMPANY_HOME: "relative-home"
        })
      )
    ).toThrow(/CODEX_BRIDGE_COMPANY_HOME must be absolute/);
  });

  it("preserves personal-mode child env behavior while stripping OpenAI API env names", () => {
    const childEnv = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      OPENAI_API_KEY: "not-forwarded"
    });
    expect(childEnv).toMatchObject({ PATH: "/usr/bin", HOME: "/Users/test" });
    expect(childEnv).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("validates allowed host values as hostnames without schemes or ports", () => {
    const root = tempRoot();
    const config = loadConfig({
      CODEX_BRIDGE_ROOT: root,
      CODEX_BRIDGE_TOKEN: "secret",
      CODEX_BRIDGE_ALLOWED_HOSTS: "localhost,127.0.0.1,[::1],example.ngrok.app,localhost"
    });

    expect(config.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]", "example.ngrok.app"]);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_ALLOWED_HOSTS: "https://example.ngrok.app"
      })
    ).toThrow(/hostnames only/);

    expect(() =>
      loadConfig({
        CODEX_BRIDGE_ROOT: root,
        CODEX_BRIDGE_TOKEN: "secret",
        CODEX_BRIDGE_ALLOWED_HOSTS: "example.ngrok.app:443"
      })
    ).toThrow(/without ports/);
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

  it("detects ordinary source-file secrets when content scanning is enabled", () => {
    const root = tempRoot();
    const source = path.join(root, "config.ts");
    const slackWebhook = "https://hooks.slack.com/services/T00000000/B00000000/SECRETSECRETSECRET";
    writeFileSync(source, `export const SLACK_WEBHOOK_URL = "${slackWebhook}";\n`);

    expect(scanRootSafety(root).sensitiveFiles).not.toContain(source);

    const scan = scanRootSafety(root, 30, { scanFileContents: true });
    expect(scan.sensitiveFiles).toContain(source);
    expect(() => assertRootSafeForDelegation(root, { scanFileContents: true })).toThrow(/safe per-file exclusion/);
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

  it("fails closed when a directory cannot be listed but known paths remain reachable", () => {
    const root = realpathSync(tempRoot());
    const hidden = path.join(root, "hidden");
    const secret = path.join(hidden, ".env");
    mkdirSync(hidden);
    writeFileSync(secret, "TOKEN=secret\n");
    chmodSync(hidden, 0o111);

    try {
      expect(readFileSync(secret, "utf8")).toBe("TOKEN=secret\n");
      const scan = scanRootSafety(root);
      expect(scan.sensitiveFiles).toContain(hidden);
      expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
    } finally {
      chmodSync(hidden, 0o700);
    }
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

  it("fails closed when git metadata cannot be inspected", () => {
    const restore: Array<{ target: string; mode: number }> = [];
    const makeUnreadable = (target: string, mode: number) => {
      chmodSync(target, 0o000);
      restore.push({ target, mode });
    };

    try {
      const rootWithUnreadableConfig = realpathSync(tempRoot());
      const rootGitDir = path.join(rootWithUnreadableConfig, ".git");
      mkdirSync(rootGitDir);
      const rootConfig = path.join(rootGitDir, "config");
      writeFileSync(rootConfig, "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");
      makeUnreadable(rootConfig, 0o600);

      const rootWithUnreadableGitDir = realpathSync(tempRoot());
      const unreadableRootGitDir = path.join(rootWithUnreadableGitDir, ".git");
      mkdirSync(unreadableRootGitDir);
      makeUnreadable(unreadableRootGitDir, 0o700);

      const nestedWithUnreadableConfig = realpathSync(tempRoot());
      const nestedGitDir = path.join(nestedWithUnreadableConfig, "vendor", ".git");
      mkdirSync(nestedGitDir, { recursive: true });
      const nestedConfig = path.join(nestedGitDir, "config");
      writeFileSync(nestedConfig, "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");
      makeUnreadable(nestedConfig, 0o600);

      const nestedWithUnreadableGitDir = realpathSync(tempRoot());
      const unreadableNestedGitDir = path.join(nestedWithUnreadableGitDir, "vendor", ".git");
      mkdirSync(unreadableNestedGitDir, { recursive: true });
      makeUnreadable(unreadableNestedGitDir, 0o700);

      const cases = [
        { root: rootWithUnreadableConfig, finding: rootConfig },
        { root: rootWithUnreadableGitDir, finding: unreadableRootGitDir },
        { root: nestedWithUnreadableConfig, finding: nestedConfig },
        { root: nestedWithUnreadableGitDir, finding: unreadableNestedGitDir }
      ];

      for (const entry of cases) {
        expect(scanRootSafety(entry.root).sensitiveFiles).toContain(entry.finding);
        expect(() => assertRootSafeForDelegation(entry.root)).toThrow(/safe per-file exclusion/);
      }
    } finally {
      for (const entry of restore.reverse()) {
        chmodSync(entry.target, entry.mode);
      }
    }
  });

  it("detects sensitive files and symlink escapes inside git internal directories", () => {
    const root = realpathSync(tempRoot());
    const other = realpathSync(tempRoot());
    const rootHooks = path.join(root, ".git", "hooks");
    const nestedHooks = path.join(root, "vendor", ".git", "hooks");
    mkdirSync(rootHooks, { recursive: true });
    mkdirSync(nestedHooks, { recursive: true });
    writeFileSync(path.join(rootHooks, ".env"), "TOKEN=secret\n");
    writeFileSync(path.join(nestedHooks, ".env.local"), "TOKEN=secret\n");
    symlinkSync(other, path.join(rootHooks, "outside-link"));
    symlinkSync(other, path.join(nestedHooks, "outside-link"));

    const scan = scanRootSafety(root);
    expect(scan.sensitiveFiles).toContain(path.join(rootHooks, ".env"));
    expect(scan.sensitiveFiles).toContain(path.join(nestedHooks, ".env.local"));
    expect(scan.symlinkEscapes).toContain(path.join(rootHooks, "outside-link"));
    expect(scan.symlinkEscapes).toContain(path.join(nestedHooks, "outside-link"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("detects root gitdir files that point outside the root", () => {
    const root = realpathSync(tempRoot());
    const other = realpathSync(tempRoot());
    const externalGitDir = path.join(other, "actual.git");
    mkdirSync(externalGitDir);
    writeFileSync(path.join(externalGitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");
    writeFileSync(path.join(root, ".git"), `gitdir: ${externalGitDir}\n`);

    const scan = scanRootSafety(root);
    expect(scan.symlinkEscapes).toContain(path.join(root, ".git"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("scans root gitdir files that point inside the root", () => {
    const root = realpathSync(tempRoot());
    const gitDir = path.join(root, "actual.git");
    mkdirSync(gitDir);
    writeFileSync(path.join(root, ".git"), "gitdir: actual.git\n");
    writeFileSync(path.join(gitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(gitDir, "config"));
  });

  it("detects nested gitdir files that point outside the root", () => {
    const root = realpathSync(tempRoot());
    const other = realpathSync(tempRoot());
    const nested = path.join(root, "subrepo");
    const externalGitDir = path.join(other, "actual.git");
    mkdirSync(nested);
    mkdirSync(externalGitDir);
    writeFileSync(path.join(externalGitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");
    writeFileSync(path.join(nested, ".git"), `gitdir: ${externalGitDir}\n`);

    const scan = scanRootSafety(root);
    expect(scan.symlinkEscapes).toContain(path.join(nested, ".git"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("scans nested gitdir files that point inside the root", () => {
    const root = realpathSync(tempRoot());
    const nested = path.join(root, "subrepo");
    const gitDir = path.join(root, "subrepo.git");
    mkdirSync(nested);
    mkdirSync(gitDir);
    writeFileSync(path.join(nested, ".git"), "gitdir: ../subrepo.git\n");
    writeFileSync(path.join(gitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(gitDir, "config"));
  });

  it("detects credential-bearing nested git directories", () => {
    const root = realpathSync(tempRoot());
    const gitDir = path.join(root, "vendor", ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(gitDir, "config"), "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    expect(scanRootSafety(root).sensitiveFiles).toContain(path.join(gitDir, "config"));
  });

  it("detects git config includes that point outside the root", () => {
    const root = realpathSync(tempRoot());
    const other = realpathSync(tempRoot());
    const gitDir = path.join(root, ".git");
    const includedConfig = path.join(other, "external-gitconfig");
    mkdirSync(gitDir);
    writeFileSync(path.join(gitDir, "config"), `[include]\n\tpath = ${includedConfig}\n`);
    writeFileSync(includedConfig, "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    const scan = scanRootSafety(root);
    expect(scan.symlinkEscapes).toContain(path.join(gitDir, "config"));
    expect(() => assertRootSafeForDelegation(root)).toThrow(/safe per-file exclusion/);
  });

  it("scans git config includes that stay inside the root", () => {
    const root = realpathSync(tempRoot());
    const gitDir = path.join(root, ".git");
    const includedConfig = path.join(root, "included-gitconfig");
    mkdirSync(gitDir);
    writeFileSync(path.join(gitDir, "config"), "[includeIf \"gitdir:./\"]\n\tpath = ../included-gitconfig\n");
    writeFileSync(includedConfig, "[http]\nextraheader = AUTHORIZATION: basic abcdefghijklmnop\n");

    expect(scanRootSafety(root).sensitiveFiles).toContain(includedConfig);
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
