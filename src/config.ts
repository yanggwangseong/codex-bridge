import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
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
  companyMode: boolean;
  rootIsolationAcknowledged: boolean;
  codexCommand: string;
  companyHome?: string;
  companyCodexHome?: string;
  companyTmpDir?: string;
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

export type SafetyScanOptions = {
  scanFileContents?: boolean;
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
const DEFAULT_SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const GIT_METADATA_MAX_BYTES = 256 * 1024;
const CONTENT_SCAN_MAX_BYTES = 1024 * 1024;
const CONTENT_SCANNABLE_EXTENSIONS = new Set([
  ".bash",
  ".adoc",
  ".asciidoc",
  ".c",
  ".cfg",
  ".conf",
  ".cpp",
  ".cs",
  ".csv",
  ".css",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".kt",
  ".kts",
  ".ipynb",
  ".markdown",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".properties",
  ".proto",
  ".py",
  ".rb",
  ".rst",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".tsv",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh"
]);
const CONTENT_SCANNABLE_BASENAMES = new Set(["dockerfile", "gemfile", "makefile", "procfile", "rakefile"]);
const CONTENT_SCAN_SKIPPED_DIRS = new Set([
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): BridgeConfig {
  const host = optional(env.CODEX_BRIDGE_HOST) || "127.0.0.1";
  const port = parsePort(optional(env.CODEX_BRIDGE_PORT) || "8765");
  const token = optional(env.CODEX_BRIDGE_TOKEN);
  const noAuth = parseBool(env.CODEX_BRIDGE_NO_AUTH);
  const localSmokeTest = parseBool(env.CODEX_BRIDGE_LOCAL_SMOKE_TEST);
  const tunnelMode = parseTunnelMode(optional(env.CODEX_BRIDGE_TUNNEL_MODE) || "none");
  const publicBaseUrl = optional(env.CODEX_BRIDGE_PUBLIC_BASE_URL);
  const companyMode = parseBool(env.CODEX_BRIDGE_COMPANY_MODE);
  const rootIsolationAcknowledged = parseBool(env.CODEX_BRIDGE_ROOT_ISOLATION_ACK);
  const allowOpenAiApiEnvForTest = parseBool(env.CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST);
  const codexCommand = optional(env.CODEX_BRIDGE_CODEX) || "codex";
  const companyHome = parseOptionalDirectory(optional(env.CODEX_BRIDGE_COMPANY_HOME), "CODEX_BRIDGE_COMPANY_HOME");
  const companyCodexHome =
    parseOptionalDirectory(optional(env.CODEX_BRIDGE_COMPANY_CODEX_HOME), "CODEX_BRIDGE_COMPANY_CODEX_HOME") ||
    companyHome;
  const companyTmpDir =
    parseOptionalDirectory(optional(env.CODEX_BRIDGE_COMPANY_TMPDIR), "CODEX_BRIDGE_COMPANY_TMPDIR") || companyHome;
  const safePath = optional(env.CODEX_BRIDGE_SAFE_PATH) || (companyMode ? DEFAULT_SAFE_PATH : defaultSafePath(env));
  const allowedRoot = parseAllowedRoot(optional(env.CODEX_BRIDGE_ROOT) || cwd);

  validateOpenAiApiEnv(env, allowOpenAiApiEnvForTest);
  validateExposurePolicy({
    host,
    token,
    noAuth,
    localSmokeTest,
    tunnelMode,
    publicBaseUrl,
    companyMode,
    rootIsolationAcknowledged,
    codexCommand,
    companyHome,
    companyCodexHome,
    companyTmpDir
  });

  const upstreamTimeoutMs = parsePositiveInt(optional(env.CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS) || "180000");
  const fastReturnMs = parsePositiveInt(optional(env.CODEX_BRIDGE_FAST_RETURN_MS) || "25000");
  if (fastReturnMs > upstreamTimeoutMs) {
    throw new Error("CODEX_BRIDGE_FAST_RETURN_MS must be less than or equal to CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS.");
  }

  return {
    host,
    port,
    allowedHosts: parseAllowedHosts(env.CODEX_BRIDGE_ALLOWED_HOSTS),
    token,
    noAuth,
    localSmokeTest,
    tunnelMode,
    publicBaseUrl,
    companyMode,
    rootIsolationAcknowledged,
    codexCommand,
    companyHome,
    companyCodexHome,
    companyTmpDir,
    allowedRoot,
    safePath,
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

export function scanRootSafety(root: string, maxFindings = 30, options: SafetyScanOptions = {}): SafetyScanResult {
  const sensitiveFiles: string[] = [];
  const symlinkEscapes: string[] = [];
  const inspectedGitMetadataFiles = new Set<string>();
  const inspectedContentFiles = new Set<string>();

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
    } catch (error) {
      if (!isMissingPathError(error)) {
        addFinding(sensitiveFiles, findingPath);
      }
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
      addFinding(sensitiveFiles, findingPath);
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
      addFinding(sensitiveFiles, findingPath);
      return;
    }
  }

  function inspectOrdinaryFileContent(readPath: string, stat: Stats, findingPath = readPath): void {
    if (!options.scanFileContents || !stat.isFile() || !isOrdinaryContentScanCandidate(readPath)) {
      return;
    }
    if (stat.size > CONTENT_SCAN_MAX_BYTES) {
      addFinding(sensitiveFiles, findingPath);
      return;
    }

    let inspectedKey = readPath;
    try {
      inspectedKey = realpathSync(readPath);
    } catch {
      addFinding(sensitiveFiles, findingPath);
      return;
    }
    if (inspectedContentFiles.has(inspectedKey)) {
      return;
    }
    inspectedContentFiles.add(inspectedKey);

    try {
      if (containsSecretPattern(readFileSync(readPath, "utf8"))) {
        addFinding(sensitiveFiles, findingPath);
      }
    } catch {
      addFinding(sensitiveFiles, findingPath);
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
    } catch (error) {
      if (!isMissingPathError(error)) {
        addFinding(sensitiveFiles, metadataPath);
      }
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
      addFinding(sensitiveFiles, dir);
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
    } catch (error) {
      if (!isMissingPathError(error)) {
        addFinding(sensitiveFiles, dir);
      }
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
      } catch (error) {
        if (!isMissingPathError(error)) {
          addFinding(sensitiveFiles, fullPath);
        }
        continue;
      }

      if (entry.name === ".git") {
        scanGitMetadataPath(fullPath, 0);
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
        continue;
      }

      inspectOrdinaryFileContent(fullPath, stat);
    }
  }

  function isOrdinaryContentScanCandidate(fullPath: string): boolean {
    const relative = path.relative(root, fullPath);
    if (!relative || relative.startsWith("..")) {
      return false;
    }
    const parts = relative.split(path.sep);
    if (parts.some((part) => CONTENT_SCAN_SKIPPED_DIRS.has(part)) || parts.includes(".git")) {
      return false;
    }

    const basename = path.basename(fullPath).toLowerCase();
    return CONTENT_SCANNABLE_EXTENSIONS.has(path.extname(basename)) || CONTENT_SCANNABLE_BASENAMES.has(basename);
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

function isMissingPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function assertRootSafeForDelegation(root: string, options: SafetyScanOptions = {}): void {
  const scan = scanRootSafety(root, 30, options);
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
  companyMode: boolean;
  rootIsolationAcknowledged: boolean;
  codexCommand: string;
  companyHome?: string;
  companyCodexHome?: string;
  companyTmpDir?: string;
}): void {
  if (!LOCAL_HOSTS.has(input.host)) {
    throw new Error("This bridge must bind to 127.0.0.1/localhost because OAuth 2.1 public auth is not implemented.");
  }
  if (input.noAuth && input.token) {
    throw new Error("CODEX_BRIDGE_NO_AUTH and CODEX_BRIDGE_TOKEN are mutually exclusive.");
  }
  if (input.companyMode) {
    if (!input.rootIsolationAcknowledged) {
      throw new Error(
        "CODEX_BRIDGE_COMPANY_MODE=1 requires CODEX_BRIDGE_ROOT_ISOLATION_ACK=1 after running the bridge under OS/container isolation with only the sanitized target root visible."
      );
    }
    if (input.noAuth) {
      throw new Error("CODEX_BRIDGE_COMPANY_MODE=1 forbids CODEX_BRIDGE_NO_AUTH.");
    }
    if (!input.token) {
      throw new Error("CODEX_BRIDGE_COMPANY_MODE=1 requires CODEX_BRIDGE_TOKEN.");
    }
    if (input.publicBaseUrl) {
      throw new Error(
        "CODEX_BRIDGE_COMPANY_MODE=1 does not accept CODEX_BRIDGE_PUBLIC_BASE_URL. Keep the bridge localhost-only behind an externally controlled secure tunnel or OAuth layer."
      );
    }
    if (!path.isAbsolute(input.codexCommand)) {
      throw new Error(
        "CODEX_BRIDGE_COMPANY_MODE=1 requires CODEX_BRIDGE_CODEX to be an absolute trusted Codex command path."
      );
    }
    if (!input.companyHome || !input.companyCodexHome || !input.companyTmpDir) {
      throw new Error(
        "CODEX_BRIDGE_COMPANY_MODE=1 requires CODEX_BRIDGE_COMPANY_HOME so the Codex child process does not inherit host HOME/CODEX_HOME/TMPDIR."
      );
    }
  }
  if (!input.token && !input.noAuth) {
    throw new Error("Set CODEX_BRIDGE_TOKEN, or set CODEX_BRIDGE_NO_AUTH=1 with CODEX_BRIDGE_LOCAL_SMOKE_TEST=1.");
  }
  if (input.noAuth && !input.localSmokeTest) {
    throw new Error("CODEX_BRIDGE_NO_AUTH=1 requires CODEX_BRIDGE_LOCAL_SMOKE_TEST=1.");
  }
  if (input.noAuth && input.publicBaseUrl) {
    throw new Error(
      "CODEX_BRIDGE_PUBLIC_BASE_URL cannot be set in no-auth mode. Keep Secure MCP Tunnel configuration outside the bridge process."
    );
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

function parseOptionalDirectory(raw: string | undefined, name: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(`${name} must be absolute: ${raw}`);
  }
  const dir = realpathSync(raw);
  if (!statSync(dir).isDirectory()) {
    throw new Error(`${name} must be a directory: ${dir}`);
  }
  return dir;
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

function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  const values = parseCsv(raw);
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    validateAllowedHost(value);
  }
  return values;
}

function validateAllowedHost(value: string): void {
  if (value.includes("://") || value.includes("/") || value.includes("?") || value.includes("#")) {
    throw new Error("CODEX_BRIDGE_ALLOWED_HOSTS must contain hostnames only, without scheme, path, query, or fragment.");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`Invalid CODEX_BRIDGE_ALLOWED_HOSTS hostname: ${value}`);
  }
  if (parsed.hostname !== value || parsed.host !== value) {
    throw new Error("CODEX_BRIDGE_ALLOWED_HOSTS must contain hostnames only, without ports or credentials.");
  }
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
  return optional(env.PATH) || DEFAULT_SAFE_PATH;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
