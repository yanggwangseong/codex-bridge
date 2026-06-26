# codex-bridge

Personal read-only MCP bridge from ChatGPT Developer Mode to local Codex Desktop/CLI.

The intended workflow is:

1. ChatGPT web plans, reviews, and asks focused read-only questions.
2. ChatGPT calls this local MCP bridge through Developer Mode.
3. The bridge calls local `codex mcp-server` over stdio.
4. Codex inspects one configured local repo in read-only mode.
5. ChatGPT produces implementation prompts for Codex Desktop.
6. Codex Desktop performs actual edits, tests, verification, and commits.

This project does not implement Codex -> ChatGPT, OpenAI API calls, write-mode tools, or a general remote-control daemon.

## Setup

```bash
cd /Users/hongseok/project/codex-bridge
npm install
npm run build
npm test
```

Codex CLI must be installed and logged in with the normal Codex/ChatGPT login:

```bash
codex --version
codex mcp-server --help
```

Do not set `OPENAI_API_KEY` for this bridge. If any OpenAI API env name is present, startup fails closed by default because this bridge must not use API-key billing paths.

## Run Locally

No-auth is intentionally limited to localhost smoke testing or OpenAI Secure MCP Tunnel testing. Do not set `CODEX_BRIDGE_TOKEN` together with `CODEX_BRIDGE_NO_AUTH`; startup rejects ambiguous auth mode configuration.

```bash
CODEX_BRIDGE_ROOT="/Users/hongseok/Desktop/blitz-core" \
CODEX_BRIDGE_NO_AUTH=1 \
CODEX_BRIDGE_LOCAL_SMOKE_TEST=1 \
npm run start
```

For direct local MCP client tests with bearer auth:

```bash
CODEX_BRIDGE_ROOT="/Users/hongseok/Desktop/blitz-core" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
npm run start
```

For company-sensitive repositories, run the bridge only from an already isolated OS/container account or mount where the sanitized target repo is the only visible working root. Do not use company mode from a normal developer account that can read unrelated projects or personal files.

Company mode is fail-closed unless external isolation is acknowledged, bearer auth is enabled, no public bridge URL is configured, `codex` is referenced by an absolute trusted path, and the Codex child process gets isolated `HOME`/`CODEX_HOME`/`TMPDIR` directories:

```bash
mkdir -p /sanitized/company/runtime-home /sanitized/company/runtime-tmp

CODEX_BRIDGE_ROOT="/sanitized/company/repo" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
CODEX_BRIDGE_COMPANY_MODE=1 \
CODEX_BRIDGE_ROOT_ISOLATION_ACK=1 \
CODEX_BRIDGE_CODEX="$(command -v codex)" \
CODEX_BRIDGE_COMPANY_HOME="/sanitized/company/runtime-home" \
CODEX_BRIDGE_COMPANY_CODEX_HOME="/sanitized/company/runtime-home" \
CODEX_BRIDGE_COMPANY_TMPDIR="/sanitized/company/runtime-tmp" \
npm run start
```

The MCP endpoint is:

```text
http://127.0.0.1:8765/mcp
```

## Tools

Only these tools are exposed:

- `bridge_status`
- `codex_read`
- `codex_job_status`

Removed and intentionally unsupported:

- `codex_run`
- `codex_reply`
- `workspace-write`
- `danger-full-access`
- `ask_chatgpt`
- OpenAI Responses API or Chat Completions API calls
- Any write-mode tool

## Security Model

- The bridge binds to `127.0.0.1` by default.
- Exactly one repo root is allowed per process through `CODEX_BRIDGE_ROOT`.
- `cwd` is realpath-checked and must stay inside the allowed root.
- Symlink escapes outside the allowed root block `codex_read`.
- Secret-looking files block `codex_read` when safe per-file exclusion cannot be guaranteed.
- Blocked secret-looking names include `.env`, `.env.*`, `.npmrc`, `.pypirc`, `.netrc`, private SSH key names, `.pem`, `.key`, `.p12`, `.pfx`, and similar files.
- Codex child starts with explicit read-only sandbox and `approval_policy=never`.
- In company mode, the Codex child receives only an isolated minimal environment: `PATH`, `HOME`, `CODEX_HOME`, `TMPDIR`, and `LANG`.
- Each `codex_read` call also forwards read-only sandbox and per-session config overrides.
- Codex web search is disabled for bridge calls.
- OpenAI API env names are stripped and not forwarded to child processes.
- No prompts, bearer tokens, repo contents, or Codex outputs are persisted to logs.
- Job outputs are in memory only and expire after `CODEX_BRIDGE_JOB_TTL_MS`.
- Company mode (`CODEX_BRIDGE_COMPANY_MODE=1`) requires bearer auth, rejects no-auth/public URL markers, requires an absolute `CODEX_BRIDGE_CODEX`, isolates the Codex child environment, redacts the absolute root from `bridge_status` and the bridge policy prompt, and scans ordinary source/config/docs/data file contents for known secret patterns before `codex_read`.
- Company mode is not a substitute for OS/container isolation or a full company DLP pass. `CODEX_BRIDGE_ROOT_ISOLATION_ACK=1` is only valid when the bridge runs under a dedicated low-privilege user or container with only the sanitized checkout and isolated runtime directories visible. Run your approved secret scanner such as gitleaks or trufflehog before exposing important company projects.

Repository contents are treated as untrusted data. The bridge prepends instructions telling Codex to ignore repo-contained attempts to alter bridge policy, auth policy, sandbox mode, allowed roots, or secret handling.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BRIDGE_ROOT` | current directory | The single allowed repo root. Must be absolute for normal use. |
| `CODEX_BRIDGE_TRANSPORT` | `http` | Bridge transport. Use `http` for the local `/mcp` server, or `stdio` when a tunnel runtime launches the bridge as a local MCP command. |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | Bind host. Non-local binds are rejected because OAuth is not implemented. |
| `CODEX_BRIDGE_PORT` | `8765` | HTTP port. |
| `CODEX_BRIDGE_ALLOWED_HOSTS` | unset | Complete hostname allowlist for MCP DNS rebinding protection. Hostnames only; no scheme, port, path, query, or fragment. If set, include `127.0.0.1`/`localhost` for direct local clients as needed. |
| `CODEX_BRIDGE_TOKEN` | unset | Bearer token for local direct tests. Send via `Authorization: Bearer ...`. |
| `CODEX_BRIDGE_NO_AUTH` | unset | Enables no-auth mode only with local smoke-test guardrails. |
| `CODEX_BRIDGE_LOCAL_SMOKE_TEST` | unset | Required acknowledgement for no-auth mode. |
| `CODEX_BRIDGE_TUNNEL_MODE` | `none` | Use `openai-secure` for OpenAI Secure MCP Tunnel testing. |
| `CODEX_BRIDGE_PUBLIC_BASE_URL` | unset | Optional public URL marker for authenticated/OAuth-fronted deployments. Rejected in no-auth mode; not needed for Secure MCP Tunnel local testing. |
| `CODEX_BRIDGE_COMPANY_MODE` | unset | Enables stricter company-sensitive guardrails: bearer auth only, no public URL marker, redacted root disclosure, and source/config/docs/data content secret scanning. |
| `CODEX_BRIDGE_ROOT_ISOLATION_ACK` | unset | Required with company mode after you have isolated the process with OS/container controls so only the sanitized target root is visible. |
| `CODEX_BRIDGE_CODEX` | `codex` | Codex command path. Must be an absolute trusted path in company mode. |
| `CODEX_BRIDGE_COMPANY_HOME` | unset | Required in company mode. Isolated `HOME` for the Codex child process. Must be an existing absolute directory. |
| `CODEX_BRIDGE_COMPANY_CODEX_HOME` | `CODEX_BRIDGE_COMPANY_HOME` | Optional isolated `CODEX_HOME` for the Codex child process. Must be an existing absolute directory. |
| `CODEX_BRIDGE_COMPANY_TMPDIR` | `CODEX_BRIDGE_COMPANY_HOME` | Optional isolated `TMPDIR` for the Codex child process. Must be an existing absolute directory. |
| `CODEX_BRIDGE_SAFE_PATH` | host `PATH`, or fixed system path in company mode | `PATH` passed to Codex child and Codex shell sessions. Set explicitly in company mode when your isolated runtime needs a narrower approved path. |
| `CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS` | `180000` | Max Codex MCP call timeout. |
| `CODEX_BRIDGE_FAST_RETURN_MS` | `25000` | Return `jobId` after this many ms. |
| `CODEX_BRIDGE_JOB_TTL_MS` | `600000` | Completed job output retention. |
| `CODEX_BRIDGE_MAX_OUTPUT_CHARS` | `120000` | Output cap. |
| `CODEX_BRIDGE_MAX_CONCURRENT_CODEX_READS` | `1` | Codex read concurrency. |
| `CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST` | unset | Local-only override for tests that intentionally set OpenAI API env names; values are still stripped. |
| `CODEX_BRIDGE_DEBUG_STDERR` | unset | If set, prints redacted Codex child stderr for local debugging. Default discards child stderr. |

## ChatGPT Developer Mode

OpenAI docs state that Developer Mode supports remote MCP over SSE and streaming HTTP, with OAuth, No Authentication, and Mixed Authentication. This bridge exposes Streamable HTTP at `/mcp`.

Manual steps:

1. Enable ChatGPT Developer Mode in ChatGPT web.
2. Start this bridge locally.
3. Prefer OpenAI Secure MCP Tunnel so the local bridge is not exposed to the public internet.
4. Register the HTTPS tunnel `/mcp` URL in ChatGPT Developer Mode.
5. Refresh the app after changing tools or descriptions.
6. In a new chat, call `bridge_status` first, then `codex_read`.

Example ChatGPT prompt:

```text
Use bridge_status. Return authMode, defaultSandbox, approvalPolicy, exposedTools, upstreamTools, and safety.
```

Example read-only planner prompt:

```text
Use codex_read with only prompt:
Inspect the configured repo in read-only mode. List relevant files for this task, summarize current behavior, risks, and a concrete implementation prompt I can give to Codex Desktop. Do not modify files, run package managers, run test suites, or read secrets.
```

If `codex_read` returns `status: "running"`, copy the exact `jobId` and call `codex_job_status`.

## Secure MCP Tunnel

Secure MCP Tunnel is the preferred local development path because it connects private MCP servers to supported OpenAI products without exposing the local server publicly. This project does not create tunnels, store tunnel credentials, or configure OpenAI tunnel settings automatically.

For OpenAI `tunnel-client`, prefer launching the bridge as a local stdio MCP command:

```bash
CODEX_BRIDGE_TRANSPORT=stdio \
CODEX_BRIDGE_ROOT="/sanitized/company/repo" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
CODEX_BRIDGE_COMPANY_MODE=1 \
CODEX_BRIDGE_ROOT_ISOLATION_ACK=1 \
CODEX_BRIDGE_CODEX="$(command -v codex)" \
CODEX_BRIDGE_COMPANY_HOME="/sanitized/company/runtime-home" \
CODEX_BRIDGE_COMPANY_CODEX_HOME="/sanitized/company/runtime-home" \
CODEX_BRIDGE_COMPANY_TMPDIR="/sanitized/company/runtime-tmp" \
node dist/cli.js
```

The stdio form avoids HTTP OAuth protected-resource discovery because the tunnel runtime owns the external connection and starts this bridge locally. The HTTP `/mcp` server remains available for direct local MCP client tests and for deployments that put a real OAuth 2.1 layer in front of the bridge.

Then register the OpenAI tunnel in ChatGPT.

Keep the bridge bound to localhost and do not set `CODEX_BRIDGE_PUBLIC_BASE_URL` for Secure MCP Tunnel testing. The tunnel URL is registered in ChatGPT, not trusted by this bridge as proof that a public URL is safe.

Sources:

- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)

## Public Auth Boundary

This bridge does not implement OAuth 2.1.

If you serve a ChatGPT-facing MCP endpoint directly on the public internet, put a ChatGPT-compatible OAuth 2.1 layer in front of it. OpenAI docs require protected resource metadata, authorization server metadata, authorization-code + PKCE, token verification, and correct resource/audience handling for authenticated MCP servers.

Do not expose this bridge through a generic public ngrok or Cloudflare URL in no-auth mode.

No-auth startup rejects `CODEX_BRIDGE_PUBLIC_BASE_URL` even when `CODEX_BRIDGE_TUNNEL_MODE=openai-secure`; the bridge cannot verify from an environment variable that a URL came from OpenAI Secure MCP Tunnel.

Source:

- [Apps SDK Authentication](https://developers.openai.com/apps-sdk/build/auth)

## Recommended Usage Loop

1. ChatGPT calls `bridge_status`.
2. ChatGPT calls `codex_read` to inspect context and produce a narrow implementation prompt.
3. Codex Desktop applies changes locally.
4. Codex Desktop runs tests and verification.
5. ChatGPT calls `codex_read` again to review changed files or diffs.
6. Repeat until ChatGPT review has no blockers.

## Known Limitations

- OAuth 2.1 is documented but not implemented.
- The bridge cannot safely exclude individual secret files from a free-form Codex session, so it blocks roots containing sensitive-looking files.
- The bridge process cannot prove an OS-enforced read boundary by itself. For company projects, use company mode only with external isolation controls, a sanitized checkout, and isolated child runtime directories.
- Built-in content secret scanning is pattern-based and text-file focused. It is a guardrail, not a complete replacement for company-approved secret scanning and DLP.
- Live `codex_read` depends on local Codex auth/session state.
- `codex mcp-server` does not expose a direct effective-sandbox introspection API; this bridge verifies fixed startup args, strict config acceptance, tool-call payloads, and fixture write-block behavior.
- The bridge is intentionally single-user and local-first.

## Upstream Reference

`DeepCogNeural/codex-gpt-bridge` was used as a reference and is kept in ignored `upstream-reference/` for inspection. This reduced bridge removes the upstream write tools and reverse OpenAI API path.
