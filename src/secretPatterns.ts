type RedactionRecorder = (kind: string) => void;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|private[_-]?key|authorization)[A-Za-z0-9_-]*)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=:@-]{8,})["']?/gi;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9_./+=:@-]{12,}\b/gi;
const AUTHORIZATION_HEADER = /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9_./+=:@-]{8,}/gi;
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/\s"'`<>@]+)@(?=[^/\s"'`<>]+)/g;
const COMMON_PROVIDER_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;

const DETECTION_PATTERNS = [
  PRIVATE_KEY_BLOCK,
  SECRET_ASSIGNMENT,
  OPENAI_KEY,
  BEARER,
  AUTHORIZATION_HEADER,
  COMMON_PROVIDER_TOKEN
];

export function containsSecretPattern(input: string): boolean {
  return DETECTION_PATTERNS.some((pattern) => testPattern(pattern, input)) || containsUrlCredentials(input);
}

export function redactSecretPatterns(input: string, record: RedactionRecorder): string {
  let text = input.replace(PRIVATE_KEY_BLOCK, () => {
    record("private-key-block");
    return "[redacted-private-key]";
  });
  text = text.replace(SECRET_ASSIGNMENT, (_match, key: string) => {
    record("secret-assignment");
    return `${key}=[redacted]`;
  });
  text = text.replace(OPENAI_KEY, () => {
    record("openai-api-key-pattern");
    return "[redacted-openai-api-key]";
  });
  text = text.replace(BEARER, () => {
    record("bearer-token");
    return "Bearer [redacted]";
  });
  text = text.replace(AUTHORIZATION_HEADER, () => {
    record("authorization-header");
    return "Authorization: [redacted]";
  });
  text = text.replace(URL_USERINFO, (match, scheme: string, userinfo: string) => {
    if (!isSensitiveUrlUserinfo(userinfo)) {
      return match;
    }
    record("url-credentials");
    return `${scheme}[redacted]@`;
  });
  text = text.replace(COMMON_PROVIDER_TOKEN, () => {
    record("provider-token");
    return "[redacted-provider-token]";
  });
  return text;
}

function containsUrlCredentials(input: string): boolean {
  URL_USERINFO.lastIndex = 0;
  let match = URL_USERINFO.exec(input);
  while (match) {
    if (isSensitiveUrlUserinfo(match[2] || "")) {
      URL_USERINFO.lastIndex = 0;
      return true;
    }
    match = URL_USERINFO.exec(input);
  }
  URL_USERINFO.lastIndex = 0;
  return false;
}

function isSensitiveUrlUserinfo(userinfo: string): boolean {
  return userinfo.includes(":") || /%3a/i.test(userinfo) || testPattern(COMMON_PROVIDER_TOKEN, userinfo);
}

function testPattern(pattern: RegExp, input: string): boolean {
  pattern.lastIndex = 0;
  const result = pattern.test(input);
  pattern.lastIndex = 0;
  return result;
}
