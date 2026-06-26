import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { containsSecretPattern } from "./secretPatterns.js";

export type TunnelMode = "none" | "openai-secure";

export type BridgeConfig = {
  host: string;
  port: number;
  allowedHosts?: string[];
  token?: string;
  noAuth: boolean;
  localSmokeTest: boolean;
  tunnelMode: TunnelMode;
  publicBaseUrl?: string;
  codexCommand: string;
  allowedRoot: string;
  safePath: string;
  upstreamTimeoutMs: number;
  fastReturnMs: number;
  jobTtlMs: number;
  maxJobs: number;
  maxConcurrentCodexReads: number;
  maxOutputChars: number;
  requestTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  httpConcurrencyMax: number;
  allowOpenAiApiEnvForTest: boolean;
  debugStderr: boolean;
};

export type SafetyScanResult = {
  sensitiveFiles: string[];
  symlinkEscapes: string[];
};

export const OPENAI_API_ENV_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT"
] as const;

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const GIT_METADATA_MAX_BYTES = 256 * 1024;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeConfig {
  const host = optional(env.CODEX_BRIDGE_HOST) || "127.0.0.1";
  const port = parsePort(optional(env.CODEX_BRIDGE_PORT) || "8765");
  const token = optional(env.CODEX_BRIDGE_TOKEN);
  const noAuth = parseBool(env.CODEX_BRIDGE_NO_AUTH);
  const localSmokeTest = parseBool(env.CODEX_BRIDGE_LOCAL_SMOKE_TEST);
  const tunnelMode = parseTunnelMode(optional(env.CODEX_BRIDGE_TUNNEL_MODE) || "none");
  const publicBaseUrl = optional(env.CODEX_BRIDGE_PUBLIC_BASE_URL);
  const allowOpenAiApiEnvForTest = parseBool(env.CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST);
  const allowedRoot = parseAllowedRoot(optional(env.CODEX_BRIDGE_ROOT) || cwd);

  validateOpenAiApiEnv(env, allowOpenAiApiEnvForTest);
  validateExposurePolicy({
    host,
    token,
    noAuth,
    localSmokeTest,
    tunnelMode,
    publicBaseUrl
  });

  const upstreamTimeoutMs = parsePositiveInt(optional(env.CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS) || "180000");
  const fastReturnMs = parsePositiveInt(optional(env.CODEX_BRIDGE_FAST_RETURN_MS) || "25000");
  if (fastReturnMs > upstreamTimeoutMs) {
    throw new Error("CODEX_BRIDGE_FAST_RETURN_MS must be less than or equal to CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS.");
  }

  return {
    host,
    port,
    allowedHosts: parseCsv(env.CODEX_BRIDGE_ALLOWED_HOSTS),
    token,
    noAuth,
    localSmokeTest,
    tunnelMode,
    publicBaseUrl,
    codexCommand: optional(env.CODEX_BRIDGE_CODEX) || "codex",
    allowedRoot,
    safePath: optional(env.CODEX_BRIDGE_SAFE_PATH) || defaultSafePath(env),
    upstreamTimeoutMs,
    fastReturnMs,
    jobTtlMs: parsePositiveInt(optional(env.CODEX_BRIDGE_JOB_TTL_MS) || "600000"),
    maxJobs: parsePositiveInt(optional(env.CODEX_BRIDGE_MAX_JOBS) || "100"),
    maxConcurrentCodexReads: parsePositiveInt(optional(env.CODEX_BRIDGE_MAX_CONCURRENT_CODEX_READS) || "1"),
    maxOutputChars: parsePositiveInt(optional(env.CODEX_BRIDGE_MAX_OUTPUT_CHARS) || "120000"),
    requestTimeoutMs: parsePositiveInt(optional(env.CODEX_BRIDGE_REQUEST_TIMEOUT_MS) || "300000"),
    rateLimitWindowMs: parsePositiveInt(optional(env.CODEX_BRIDGE_RATE_LIMIT_WINDOW_MS) || "60000"),
    rateLimitMax: parsePositiveInt(optional(env.CODEX_BRIDGE_RATE_LIMIT_MAX) || "120"),
    httpConcurrencyMax: parsePositiveInt(optional(env.CODEX_BRIDGE_HTTP_CONCURRENCY_MAX) || "8"),
    allowOpenAiApiEnvForTest,
    debugStderr: parseBool(env.CODEX_BRIDGE_DEBUG_STDERR)
  };
}

export function stripOpenAiApiEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of OPENAI_API_ENV_NAMES) {
    delete env[name];
  }
}

export function resolveAllowedCwd(input: string | undefined, config: BridgeConfig): string {
  if (!input) {
    return config.allowedRoot;
  }
  if (!path.isAbsolute(input)) {
    throw new Error("cwd must be an absolute path inside CODEX_BRIDGE_ROOT.");
  }
  const cwd = realpathSync(input);
  if (!isInsideRoot(cwd, config.allowedRoot)) {
    throw new Error("cwd is outside CODEX_BRIDGE_ROOT.");
  }
  return cwd;
}

export function scanRootSafety(root: string, maxFindings = 30): SafetyScanResult {
  const sensitiveFiles: string[] = [];
  const symlinkEscapes: string[] = [];
  const inspectedGitMetadataFiles = new Set<string>();

  function addFinding(list: string[], value: string): void {
    if (list.length < maxFindings && !list.includes(value)) {
      list.push(value);
    }
  }

  function inspectGitMetadataFile(fullPath: string, depth = 0, findingPath = fullPath): void {
    if (depth > 8) {
      addFinding(sensitiveFiles, findingPath);
      return;
    }

    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      return;
    }

    if (stat.isSymbolicLink()) {
      try {
        const target = realpathSync(fullPath);
        if (!isInsideRoot(target, root)) {
          addFinding(symlinkEscapes, findingPath);
          return;
        }
        const targetStat = statSync(target);
        if (path.basename(findingPath) === ".git") {
          inspectGitDirFile(target, findingPath, targetStat, depth + 1);
        } else {
          inspectGitMetadataContent(target, findingPath, targetStat, depth + 1);
        }
      } catch {
        addFinding(symlinkEscapes, findingPath);
      }
      return;
    }

    if (path.basename(findingPath) === ".git") {
      inspectGitDirFile(fullPath, findingPath, stat, depth);
      return;
    }

    inspectGitMetadataContent(fullPath, findingPath, stat, depth);
  }

  function inspectGitDirFile(readPath: string, findingPath: string, stat = statSync(readPath), depth = 0): void {
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > GIT_METADATA_MAX_BYTES) {
      addFinding(sensitiveFiles, findingPath);
      return;
    }

    try {
      const content = readFileSync(readPath, "utf8");
      const gitDir = parseGitDirFile(content);
      if (!gitDir) {
        return;
      }
      const gitDirPath = resolveGitMetadataReference(gitDir, path.dirname(readPath));
      if (!gitDirPath) {
        addFinding(symlinkEscapes, findingPath);
        return;
      }

      const gitDirRealPath = realpathSync(gitDirPath);
      if (!isInsideRoot(gitDirRealPath, root)) {
        addFinding(symlinkEscapes, findingPath);
        return;
      }
      scanGitMetadataPath(gitDirRealPath, depth + 1);
    } catch {
      addFinding(symlinkEscapes, findingPath);
    }
  }

  function inspectGitMetadataContent(readPath: string, findingPath: string, stat = statSync(readPath), depth = 0): void {
    if (depth > 8) {
      addFinding(sensitiveFiles, findingPath);
      return;
    }
    if (!stat.isFile()) {
      return;
    }
    if (stat.size > GIT_METADATA_MAX_BYTES) {
      addFinding(sensitiveFiles, findingPath);
      return;
    }

    let inspectedKey = readPath;
    try {
      inspectedKey = realpathSync(readPath);
    } catch {
      return;
    }
    if (inspectedGitMetadataFiles.has(inspectedKey)) {
      return;
    }
    inspectedGitMetadataFiles.add(inspectedKey);

    try {
      const content = readFileSync(readPath, "utf8");
      if (containsSecretPattern(content)) {
        addFinding(sensitiveFiles, findingPath);
      }
      inspectGitConfigIncludes(readPath, findingPath, content, depth + 1);
    } catch {
      return;
    }
  }

  function scanGitMetadataPath(metadataPath: string, depth: number): void {
    if (depth > 8) {
      addFinding(sensitiveFiles, metadataPath);
      return;
    }

    let stat;
    try {
      stat = lstatSync(metadataPath);
    } catch {
      return;
    }

    if (stat.isSymbolicLink()) {
      try {
        const target = realpathSync(metadataPath);
        if (!isInsideRoot(target, root)) {
          addFinding(symlinkEscapes, metadataPath);
          return;
        }
        scanGitMetadataPath(target, depth + 1);
      } catch {
        addFinding(symlinkEscapes, metadataPath);
      }
      return;
    }
    if (stat.isFile()) {
      if (path.basename(metadataPath) === ".git") {
        inspectGitDirFile(metadataPath, metadataPath, stat, depth);
      } else {
        inspectGitMetadataContent(metadataPath, metadataPath, stat, depth);
      }
      return;
    }
    if (!stat.isDirectory()) {
      return;
    }

    scanGitMetadataDir(metadataPath, depth);
  }

  function scanGitMetadataDir(dir: string, depth: number): void {
    if (depth > 8) {
      addFinding(sensitiveFiles, dir);
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const skipGitInternalDirs = new Set(["branches", "hooks", "logs", "objects", "refs"]);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name === "config" || entry.name === "config.worktree")) {
        inspectGitMetadataFile(fullPath);
      } else if (entry.isDirectory() && !skipGitInternalDirs.has(entry.name)) {
        scanGitMetadataDir(fullPath, depth + 1);
      } else if (entry.isSymbolicLink()) {
        inspectGitMetadataFile(fullPath);
      }
    }
  }

  function inspectGitConfigIncludes(readPath: string, findingPath: string, content: string, depth: number): void {
    for (const includePath of parseGitConfigIncludePaths(content)) {
      const candidate = resolveGitMetadataReference(includePath, path.dirname(readPath));
      if (!candidate) {
        addFinding(symlinkEscapes, findingPath);
        continue;
      }

      let targetPath: string;
      try {
        targetPath = realpathSync(candidate);
      } catch {
        if (!isInsideRoot(path.resolve(candidate), root)) {
          addFinding(symlinkEscapes, findingPath);
        }
        continue;
      }

      if (!isInsideRoot(targetPath, root)) {
        addFinding(symlinkEscapes, findingPath);
        continue;
      }
      inspectGitMetadataFile(targetPath, depth);
    }
  }

  function resolveGitMetadataReference(value: string, baseDir: string): string | undefined {
    if (value === "~") {
      return root;
    }
    if (value.startsWith("~/")) {
      return path.join(root, value.slice(2));
    }
    if (value.startsWith("~")) {
      return undefined;
    }
    return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
  }

  function walk(dir: string): void {
    if (sensitiveFiles.length >= maxFindings && symlinkEscapes.length >= maxFindings) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (isSensitiveBasename(entry.name)) {
        addFinding(sensitiveFiles, fullPath);
      }

      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        try {
          const target = realpathSync(fullPath);
          if (!isInsideRoot(target, root)) {
            addFinding(symlinkEscapes, fullPath);
          }
        } catch {
          addFinding(symlinkEscapes, fullPath);
        }
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      }
    }
  }

  if (existsSync(root) && statSync(root).isDirectory()) {
    inspectGitMetadataFile(path.join(root, ".gitmodules"));
    inspectGitMetadataFile(path.join(root, ".git-credentials"));
    inspectGitMetadataFile(path.join(root, ".gitconfig"));
    scanGitMetadataPath(path.join(root, ".git"), 0);
    walk(root);
  }

  return {
    sensitiveFiles: sensitiveFiles.sort(),
    symlinkEscapes: symlinkEscapes.sort()
  };
}

function parseGitDirFile(content: string): string | undefined {
  const match = content.match(/^\s*gitdir\s*:\s*(.+?)\s*$/im);
  return match?.[1]?.trim();
}

function parseGitConfigIncludePaths(content: string): string[] {
  const paths: string[] = [];
  let section = "";

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const sectionMatch = trimmed.match(/^\[\s*([A-Za-z0-9.-]+)/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }

    if (section !== "include" && section !== "includeif") {
      continue;
    }

    const pathMatch = trimmed.match(/^path\s*=\s*(.+)$/i);
    const includePath = pathMatch?.[1] ? unquoteGitConfigValue(pathMatch[1]) : undefined;
    if (includePath) {
      paths.push(includePath);
    }
  }

  return paths;
}

function unquoteGitConfigValue(raw: string): string {
  const value = raw.trim().replace(/\s+[;#].*$/, "");
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .trim();
  }
  return value.trim();
}

export function assertRootSafeForDelegation(root: string): void {
  const scan = scanRootSafety(root);
  const messages: string[] = [];
  if (scan.sensitiveFiles.length > 0) {
    messages.push(`sensitive-looking files: ${scan.sensitiveFiles.join(", ")}`);
  }
  if (scan.symlinkEscapes.length > 0) {
    messages.push(`symlink escapes: ${scan.symlinkEscapes.join(", ")}`);
  }
  if (messages.length > 0) {
    throw new Error(
      `Refusing to run codex_read because safe per-file exclusion cannot be guaranteed for this root (${scan.sensitiveFiles.length} sensitive-looking file findings, ${scan.symlinkEscapes.length} symlink escape findings). Use a sanitized fixture or remove/relocate those paths.`
    );
  }
}

export function isSensitiveBasename(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) {
    return true;
  }
  const deniedBasenames = new Set([
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "id_dsa",
    "id_ecdsa",
    "known_hosts",
    "authorized_keys"
  ]);
  if (deniedBasenames.has(lower)) {
    return true;
  }
  return [".pem", ".key", ".p12", ".pfx", ".asc"].some((ext) => lower.endsWith(ext));
}

export function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function buildCodexSessionConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    sandbox_mode: "read-only",
    approval_policy: "never",
    sandbox_workspace_write: {
      writable_roots: [],
      network_access: false
    },
    shell_environment_policy: {
      inherit: "none",
      set: {
        PATH: config.safePath,
        HOME: config.allowedRoot,
        LANG: "C.UTF-8"
      },
      ignore_default_excludes: false
    },
    web_search: "disabled"
  };
}

export function buildCodexStartupArgs(config: BridgeConfig): string[] {
  const shellSet = `shell_environment_policy.set={PATH="${escapeTomlString(config.safePath)}",HOME="${escapeTomlString(
    config.allowedRoot
  )}",LANG="C.UTF-8"}`;
  return [
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--strict-config",
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    'approval_policy="never"',
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    shellSet,
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "-c",
    'web_search="disabled"',
    "mcp-server"
  ];
}

function validateExposurePolicy(input: {
  host: string;
  token?: string;
  noAuth: boolean;
  localSmokeTest: boolean;
  tunnelMode: TunnelMode;
  publicBaseUrl?: string;
}): void {
  if (!LOCAL_HOSTS.has(input.host)) {
    throw new Error("This bridge must bind to 127.0.0.1/localhost because OAuth 2.1 public auth is not implemented.");
  }
  if (!input.token && !input.noAuth) {
    throw new Error("Set CODEX_BRIDGE_TOKEN, or set CODEX_BRIDGE_NO_AUTH=1 with CODEX_BRIDGE_LOCAL_SMOKE_TEST=1.");
  }
  if (input.noAuth && !input.localSmokeTest) {
    throw new Error("CODEX_BRIDGE_NO_AUTH=1 requires CODEX_BRIDGE_LOCAL_SMOKE_TEST=1.");
  }
  if (input.publicBaseUrl && input.tunnelMode !== "openai-secure") {
    throw new Error("Public/generic tunnel exposure requires OAuth 2.1, which this bridge does not implement.");
  }
}

function validateOpenAiApiEnv(env: NodeJS.ProcessEnv, allowForTest: boolean): void {
  const present = OPENAI_API_ENV_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(env, name));
  if (present.length > 0 && !allowForTest) {
    throw new Error(
      `OpenAI API environment variable names are present (${present.join(
        ", "
      )}). This bridge does not use API-key billing paths; unset them or set CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST=1 for local-only tests.`
    );
  }
}

function parseAllowedRoot(raw: string): string {
  if (raw.includes(",")) {
    throw new Error("CODEX_BRIDGE_ROOT must contain exactly one root, not a comma-separated list.");
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`CODEX_BRIDGE_ROOT must be absolute: ${raw}`);
  }
  const root = realpathSync(raw);
  if (!statSync(root).isDirectory()) {
    throw new Error(`CODEX_BRIDGE_ROOT must be a directory: ${root}`);
  }
  return root;
}

function parseTunnelMode(raw: string): TunnelMode {
  if (raw === "none" || raw === "openai-secure") {
    return raw;
  }
  throw new Error("CODEX_BRIDGE_TUNNEL_MODE must be 'none' or 'openai-secure'.");
}

function parseCsv(raw: string | undefined): string[] | undefined {
  const values = raw
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return values && values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function parsePort(raw: string): number {
  const port = parsePositiveInt(raw);
  if (port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

function parsePositiveInt(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return value;
}

function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function optional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function defaultSafePath(env: NodeJS.ProcessEnv): string {
  return optional(env.PATH) || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
