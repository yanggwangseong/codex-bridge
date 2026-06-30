# codex-bridge

ChatGPT Developer Mode에서 로컬 Codex Desktop/CLI를 read-only로 호출하기 위한 개인용 MCP 브리지입니다.

이 프로젝트의 목적은 회사 코드베이스를 ChatGPT에 직접 업로드하거나 공개 서버에 노출하지 않고, 로컬에 준비한 단일 저장소를 Codex가 읽게 한 뒤 ChatGPT가 그 결과를 바탕으로 설계, 리뷰, 구현 프롬프트를 만드는 것입니다.

## 한 줄 요약

ChatGPT는 판단과 리뷰를 담당하고, Codex는 로컬 저장소를 read-only로 탐색하며, 실제 수정/테스트/커밋은 Codex Desktop에서 수행합니다.

```text
ChatGPT Developer Mode
  -> Secure MCP Tunnel
  -> codex-bridge
  -> local codex mcp-server
  -> sanitized target repository
```

## 무엇을 할 수 있나

- ChatGPT에서 `bridge_status`로 브리지 상태와 보안 설정을 확인합니다.
- ChatGPT에서 `codex_read`로 로컬 저장소를 read-only 탐색합니다.
- 긴 탐색은 `codex_job_status`로 완료 상태를 조회합니다.
- ChatGPT가 코드베이스 기반 분석, 리뷰, 구현 지시문을 만듭니다.
- Codex Desktop이 실제 코드 수정, 테스트, 검증, 커밋을 수행합니다.

## 하지 않는 것

- 코드 수정 MCP 도구를 제공하지 않습니다.
- `workspace-write`, `danger-full-access`, `codex_run`, `codex_reply`를 노출하지 않습니다.
- ChatGPT가 로컬 저장소에 직접 write 권한을 갖게 하지 않습니다.
- OpenAI Responses API 또는 Chat Completions API를 직접 호출하는 reverse bridge가 아닙니다.
- OAuth 2.1 서버를 직접 구현하지 않습니다.
- 일반 공개 URL로 회사 저장소를 노출하는 도구가 아닙니다.

## 기본 설치

```bash
cd /path/to/codex-bridge
npm install
npm run build
npm test
```

Codex CLI 또는 Codex Desktop은 미리 설치되어 있고 로그인되어 있어야 합니다.

```bash
codex --version
codex mcp-server --help
```

중요: 이 브리지는 `OPENAI_API_KEY`를 쓰는 API-key 과금 경로를 사용하지 않는 것을 전제로 합니다. 기본 설정에서는 `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_PROJECT` 같은 OpenAI API 환경변수가 있으면 fail-closed로 시작을 거부합니다.

## 권장 운영 방식

회사 프로젝트에 붙일 때는 원본 저장소를 그대로 노출하지 말고, 별도의 sanitized mirror를 준비한 뒤 그 경로만 `CODEX_BRIDGE_ROOT`로 허용하세요.

권장 순서는 다음입니다.

1. 대상 프로젝트의 최신 브랜치를 로컬 sanitized mirror로 동기화합니다.
2. `.env`, private key, npm token, SSH key, 인증 설정 등 민감 파일이 없는지 검사합니다.
3. bridge를 company mode로 시작합니다.
4. OpenAI Secure MCP Tunnel로 ChatGPT Developer Mode에 연결합니다.
5. ChatGPT에서 먼저 `bridge_status`를 호출합니다.
6. 필요한 페이지나 기능 단위로 `codex_read`를 호출합니다.
7. ChatGPT가 만든 구현 지시문을 Codex Desktop에 넘겨 실제 수정합니다.
8. 수정 후 다시 `codex_read`로 리뷰하거나, Codex Desktop에서 테스트와 커밋을 수행합니다.

## 로컬 smoke test

개인 로컬 테스트에서는 no-auth를 사용할 수 있습니다. 이 모드는 localhost smoke test 용도입니다.

```bash
CODEX_BRIDGE_ROOT="/path/to/sanitized/repo" \
CODEX_BRIDGE_NO_AUTH=1 \
CODEX_BRIDGE_LOCAL_SMOKE_TEST=1 \
npm run start
```

MCP endpoint:

```text
http://127.0.0.1:8765/mcp
```

## bearer auth로 직접 실행

로컬 MCP 클라이언트에서 직접 테스트할 때는 bearer token을 사용합니다.

```bash
CODEX_BRIDGE_ROOT="/path/to/sanitized/repo" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
npm run start
```

클라이언트는 다음 헤더를 보내야 합니다.

```text
Authorization: Bearer <CODEX_BRIDGE_TOKEN>
```

## 회사 프로젝트용 company mode

회사 프로젝트에 사용할 때는 company mode를 사용하세요. 이 모드는 다음 조건을 강제합니다.

- bearer auth 필요
- no-auth/public URL 조합 거부
- 허용 루트 경로 redaction
- Codex child process의 `HOME`, `CODEX_HOME`, `TMPDIR` 격리
- root 내부 민감 파일 및 일부 콘텐츠 secret pattern 검사
- read-only sandbox와 `approval_policy=never` 강제

예시:

```bash
mkdir -p /path/to/runtime-home /path/to/runtime-codex-home /path/to/runtime-tmp

CODEX_BRIDGE_ROOT="/path/to/sanitized/repo" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
CODEX_BRIDGE_COMPANY_MODE=1 \
CODEX_BRIDGE_ROOT_ISOLATION_ACK=1 \
CODEX_BRIDGE_CODEX="$(command -v codex)" \
CODEX_BRIDGE_COMPANY_HOME="/path/to/runtime-home" \
CODEX_BRIDGE_COMPANY_CODEX_HOME="/path/to/runtime-codex-home" \
CODEX_BRIDGE_COMPANY_TMPDIR="/path/to/runtime-tmp" \
npm run start
```

`CODEX_BRIDGE_ROOT_ISOLATION_ACK=1`은 단순 확인용 플래그가 아닙니다. 실제로 별도 사용자, 컨테이너, 제한된 mount, sanitized checkout 등 외부 격리 조건을 갖춘 경우에만 사용해야 합니다.

## Secure MCP Tunnel로 ChatGPT에 연결

로컬 회사 프로젝트를 ChatGPT Developer Mode와 연결할 때는 OpenAI Secure MCP Tunnel을 권장합니다. 일반 ngrok/Cloudflare 공개 URL에 no-auth bridge를 올리는 방식은 사용하지 마세요.

Tunnel runtime이 bridge를 local stdio MCP command로 실행하게 만들면 외부 연결은 tunnel-client가 담당하고, bridge는 로컬에서만 동작합니다.

stdio 실행 예시:

```bash
CODEX_BRIDGE_TRANSPORT=stdio \
CODEX_BRIDGE_ROOT="/path/to/sanitized/repo" \
CODEX_BRIDGE_TOKEN="$(openssl rand -hex 32)" \
CODEX_BRIDGE_COMPANY_MODE=1 \
CODEX_BRIDGE_ROOT_ISOLATION_ACK=1 \
CODEX_BRIDGE_CODEX="$(command -v codex)" \
CODEX_BRIDGE_COMPANY_HOME="/path/to/runtime-home" \
CODEX_BRIDGE_COMPANY_CODEX_HOME="/path/to/runtime-codex-home" \
CODEX_BRIDGE_COMPANY_TMPDIR="/path/to/runtime-tmp" \
node dist/cli.js
```

ChatGPT 앱 생성 화면에서는 보통 다음처럼 설정합니다.

- 연결: Tunnel
- 인증: No Authentication
- 서버 URL: 직접 입력하지 않음
- 경고 문구: 내용을 이해한 뒤 체크

여기서 "No Authentication"은 ChatGPT와 tunnel runtime 사이의 외부 인증을 의미합니다. bridge 내부가 무인증으로 공개된다는 뜻이 아닙니다. tunnel runtime이 로컬 stdio command를 실행하고, bridge는 write 도구를 제공하지 않습니다.

## ChatGPT에서 사용하는 방법

새 채팅에서 먼저 상태를 확인합니다.

```text
bridge_status를 호출해서 authMode, defaultSandbox, approvalPolicy, exposedTools, upstreamTools, safety를 확인해줘.
```

특정 페이지나 기능을 분석할 때:

```text
codex_read를 사용해서 apps/staff-app/schedule 페이지를 read-only로 탐색해줘.

확인할 내용:
- 라우팅 엔트리
- 주요 컴포넌트 계층
- 상태 관리 방식
- API 호출 흐름
- 핵심 파일 경로
- 사용자 관점의 UI/UX 개선 포인트

코드 수정은 하지 말고, Codex Desktop에 전달할 수 있는 구현 프롬프트까지 만들어줘.
```

리뷰를 받을 때:

```text
codex_read로 현재 변경 결과물을 read-only 리뷰해줘.

관점:
- 보안
- 데이터 노출 가능성
- 권한/인증 경계
- UI/UX 회귀
- 테스트 누락
- 운영 리스크

정말 코드베이스 기준으로 타당한 finding만 남겨줘.
```

`codex_read`가 오래 걸리면 다음처럼 응답합니다.

```json
{
  "status": "running",
  "jobId": "..."
}
```

이 경우 같은 채팅에서 `codex_job_status`에 `jobId`를 넘겨 완료 결과를 확인합니다.

## 권장 작업 루프

1. ChatGPT에서 `bridge_status` 확인
2. ChatGPT에서 `codex_read`로 대상 영역 탐색
3. ChatGPT가 구현 또는 리뷰 프롬프트 생성
4. Codex Desktop에서 실제 수정
5. Codex Desktop에서 테스트/검증
6. 필요하면 ChatGPT에서 다시 `codex_read` 리뷰
7. 문제가 없으면 Codex Desktop에서 커밋/푸시

이 구조를 유지하면 ChatGPT는 회사 프로젝트를 read-only로 이해하고, 실제 write 권한은 로컬 Codex Desktop 작업 흐름 안에 남습니다.

## 최신 develop을 계속 반영하는 방법

대상 프로젝트가 계속 갱신된다면 bridge가 직접 원본 저장소를 pull하게 만들기보다, sanitized mirror 갱신 단계를 별도로 관리하는 것이 좋습니다.

권장 루프:

```text
원본 develop 최신화
  -> sanitized mirror 재생성 또는 pull
  -> secret/symlink/preflight scan
  -> bridge/tunnel restart
  -> ChatGPT에서 bridge_status 확인
```

운영 편의를 위해 로컬에서는 `cb up`, `cb restart`, `cb status`, `cb logs` 같은 alias나 wrapper를 둘 수 있습니다. 단, API key, tunnel runtime key, bearer token은 저장소에 커밋하지 말고 macOS Keychain, 1Password, 회사 secret manager, 일회성 환경변수 중 하나로 관리하세요.

## 로컬 alias 등록

이 저장소 자체는 특정 사용자의 tunnel wrapper를 강제하지 않습니다. 다만 로컬 ignored runtime에 `.gstack/runtime/tunnel-client/tunnelctl.sh` 같은 wrapper를 두었다면, `~/.zshrc`에 다음 alias를 등록해서 매번 긴 경로를 입력하지 않을 수 있습니다.

```bash
alias cb='cd /path/to/codex-bridge && .gstack/runtime/tunnel-client/tunnelctl.sh'
```

등록 후 현재 터미널에 반영합니다.

```bash
source ~/.zshrc
```

이후에는 다음처럼 사용합니다.

| 명령 | 용도 |
| --- | --- |
| `cb set-key` | tunnel runtime API key를 macOS Keychain 같은 로컬 secret store에 저장 |
| `cb up` | sanitized mirror 갱신, tunnel 시작, 상태 확인을 한 번에 수행 |
| `cb restart` | key, Codex 로그인, bridge 설정 변경 후 tunnel/bridge 재시작 |
| `cb status` | healthz, readyz, process, control-plane 상태 확인 |
| `cb logs` | tunnel-client와 bridge 로그 확인 |
| `cb stop` | tunnel-client 중지 |
| `cb open-ui` | tunnel-client 로컬 UI 열기 |

alias가 로드되지 않는 non-interactive shell에서는 전체 경로로 직접 실행하면 됩니다.

```bash
/path/to/codex-bridge/.gstack/runtime/tunnel-client/tunnelctl.sh status
```

개인 로컬 예시:

```bash
alias cb='cd /Users/your-name/project/codex-bridge && .gstack/runtime/tunnel-client/tunnelctl.sh'
```

이 alias와 `.gstack/` 런타임 파일은 로컬 운영 편의용입니다. 저장소에 민감값을 커밋하지 않도록 `.gstack/`, token 파일, auth 파일, 로그 파일은 ignored 상태로 유지하세요.

## 인증 개념 정리

이 프로젝트를 운영할 때 인증은 세 종류가 섞여 보일 수 있습니다.

| 구분 | 용도 | 저장 위치 권장 |
| --- | --- | --- |
| Tunnel runtime API key | tunnel-client가 OpenAI tunnel control plane에 연결 | Keychain/secret manager/env |
| `CODEX_BRIDGE_TOKEN` | 직접 HTTP MCP 테스트 시 local bearer auth | 일회성 env 또는 ignored local file |
| Codex 로그인 세션 | `codex mcp-server`가 `/v1/responses` 호출 | Codex Desktop/CLI의 로그인 상태 |

중요한 구분:

- Tunnel runtime API key 문제는 tunnel-client 로그나 control-plane 401로 나타납니다.
- Codex 로그인 문제는 `https://api.openai.com/v1/responses`에서 `Missing bearer or basic authentication` 같은 오류로 나타납니다.
- `OPENAI_API_KEY`를 bridge에 넣어서 해결하려고 하지 마세요. 이 bridge는 API-key 경로를 피하도록 설계되어 있습니다.

격리된 `CODEX_HOME`을 쓰는 company mode에서는 Codex 로그인 파일이 격리 runtime에 없을 수 있습니다. 이 경우 원본 `~/.codex/auth.json`을 안전한 ignored runtime 디렉터리로 복사하거나, 격리 환경 안에서 Codex 로그인을 다시 수행해야 합니다. 이 파일은 민감 정보이므로 절대 커밋하지 마세요.

## 문제 해결

### `bridge_status`는 되지만 `codex_read`가 401로 실패

대부분 Codex 로그인 세션 문제입니다.

확인할 것:

- Codex Desktop/CLI가 로그인되어 있는지
- 격리 `CODEX_HOME`에 Codex auth가 있는지
- bridge/tunnel을 재시작했는지

해결 흐름:

```bash
codex --version
# Codex Desktop 또는 CLI에서 로그인 확인
# 격리 runtime을 쓰고 있다면 auth 동기화
# 그 뒤 tunnel/bridge restart
```

### tunnel-client가 401로 실패

Tunnel runtime API key가 틀렸거나, 삭제되었거나, 현재 organization/workspace/tunnel과 맞지 않는 경우입니다.

확인할 것:

- 같은 OpenAI organization/workspace에서 발급한 key인지
- tunnel 사용 권한이 있는지
- Keychain 또는 환경변수에 오래된 key가 남아 있지 않은지

### `codex_read`가 `status: running`에서 오래 걸림

정상일 수 있습니다. `codex_job_status`로 조회하세요. 그래도 오래 걸리면 prompt 범위를 줄이세요.

좋은 요청:

```text
apps/staff-app/schedule 관련 라우팅과 컴포넌트만 봐줘.
```

나쁜 요청:

```text
전체 코드베이스를 다 분석해줘.
```

### 민감 파일 때문에 차단됨

bridge는 `.env`, `.npmrc`, `.netrc`, private key, `.pem`, `.p12`, `.pfx` 등 민감 파일 후보가 있으면 차단할 수 있습니다. sanitized mirror에서 해당 파일을 제거하고 다시 preflight scan을 수행하세요.

## 보안 모델

- 기본 bind host는 `127.0.0.1`입니다.
- 하나의 프로세스는 하나의 `CODEX_BRIDGE_ROOT`만 허용합니다.
- `cwd`는 realpath 기준으로 허용 루트 내부인지 검사합니다.
- symlink escape가 있으면 `codex_read`를 차단합니다.
- company mode에서는 민감 파일명과 일부 secret pattern을 검사합니다.
- Codex child process는 read-only sandbox와 `approval_policy=never`로 실행됩니다.
- OpenAI API 환경변수는 child process에 전달하지 않습니다.
- prompt, bearer token, repo contents, Codex output을 로그에 저장하지 않습니다.
- 완료된 job output은 메모리에만 보관되고 `CODEX_BRIDGE_JOB_TTL_MS` 이후 만료됩니다.
- 저장소 내용은 신뢰하지 않는 입력으로 취급합니다.

company mode는 OS/container 격리, 회사 DLP, secret scanning을 대체하지 않습니다. 중요한 회사 프로젝트에 쓰기 전에는 회사에서 승인한 secret scanner와 접근 정책을 별도로 적용하세요.

## 환경변수

| Variable | Default | 설명 |
| --- | --- | --- |
| `CODEX_BRIDGE_ROOT` | current directory | 허용할 단일 저장소 루트. 일반 사용에서는 절대경로 권장. |
| `CODEX_BRIDGE_TRANSPORT` | `http` | `http` 또는 `stdio`. tunnel runtime이 local command로 실행할 때는 `stdio`. |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | HTTP bind host. OAuth 미구현 상태에서 non-local bind는 거부됩니다. |
| `CODEX_BRIDGE_PORT` | `8765` | HTTP port. |
| `CODEX_BRIDGE_ALLOWED_HOSTS` | unset | MCP DNS rebinding 방어용 hostname allowlist. |
| `CODEX_BRIDGE_TOKEN` | unset | bearer auth token. |
| `CODEX_BRIDGE_NO_AUTH` | unset | localhost smoke test용 no-auth. |
| `CODEX_BRIDGE_LOCAL_SMOKE_TEST` | unset | no-auth 사용 시 필요한 명시적 확인. |
| `CODEX_BRIDGE_TUNNEL_MODE` | `none` | OpenAI Secure MCP Tunnel 테스트 시 `openai-secure`. |
| `CODEX_BRIDGE_PUBLIC_BASE_URL` | unset | OAuth fronting 배포용 public URL marker. Secure MCP Tunnel 로컬 테스트에는 불필요. |
| `CODEX_BRIDGE_COMPANY_MODE` | unset | 회사 프로젝트용 강화 guardrail 활성화. |
| `CODEX_BRIDGE_ROOT_ISOLATION_ACK` | unset | 외부 격리를 갖췄다는 명시적 확인. |
| `CODEX_BRIDGE_CODEX` | `codex` | Codex command path. company mode에서는 절대경로 필요. |
| `CODEX_BRIDGE_COMPANY_HOME` | unset | Codex child process의 격리 `HOME`. |
| `CODEX_BRIDGE_COMPANY_CODEX_HOME` | `CODEX_BRIDGE_COMPANY_HOME` | Codex child process의 격리 `CODEX_HOME`. |
| `CODEX_BRIDGE_COMPANY_TMPDIR` | `CODEX_BRIDGE_COMPANY_HOME` | Codex child process의 격리 `TMPDIR`. |
| `CODEX_BRIDGE_SAFE_PATH` | mode-dependent | Codex child process에 전달할 `PATH`. |
| `CODEX_BRIDGE_UPSTREAM_TIMEOUT_MS` | `180000` | Codex MCP call 최대 timeout. |
| `CODEX_BRIDGE_FAST_RETURN_MS` | `25000` | 이 시간을 넘으면 `jobId`를 먼저 반환. |
| `CODEX_BRIDGE_JOB_TTL_MS` | `600000` | 완료 job output 메모리 보관 시간. |
| `CODEX_BRIDGE_MAX_OUTPUT_CHARS` | `120000` | 응답 출력 상한. |
| `CODEX_BRIDGE_MAX_CONCURRENT_CODEX_READS` | `1` | 동시 `codex_read` 제한. |
| `CODEX_BRIDGE_REQUEST_TIMEOUT_MS` | `300000` | HTTP request timeout. |
| `CODEX_BRIDGE_RATE_LIMIT_WINDOW_MS` | `60000` | rate limit window. |
| `CODEX_BRIDGE_RATE_LIMIT_MAX` | `120` | window당 최대 request 수. |
| `CODEX_BRIDGE_HTTP_CONCURRENCY_MAX` | `8` | HTTP 동시 처리 제한. |
| `CODEX_BRIDGE_ALLOW_OPENAI_API_ENV_FOR_TEST` | unset | 테스트 전용 override. 값은 여전히 child에 전달하지 않습니다. |
| `CODEX_BRIDGE_DEBUG_STDERR` | unset | 로컬 디버깅용 redacted child stderr 출력. |

## 공식 문서

- [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- [Apps SDK Authentication](https://developers.openai.com/apps-sdk/build/auth)

## Upstream Reference

`DeepCogNeural/codex-gpt-bridge`를 참고했지만, 이 프로젝트는 write 도구와 reverse OpenAI API 경로를 제거한 read-only bridge입니다.
