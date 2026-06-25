import { isSensitiveBasename } from "./config.js";
import { redactSecretPatterns } from "./secretPatterns.js";

export type Sanitized<T> = {
  value: T;
  redactions: string[];
  truncated: boolean;
};

export function sanitizeUnknown<T>(input: T, maxOutputChars: number): Sanitized<T> {
  const redactions: string[] = [];
  let truncated = false;

  function sanitize(value: unknown): unknown {
    if (typeof value === "string") {
      const sanitized = sanitizeText(value, maxOutputChars);
      redactions.push(...sanitized.redactions);
      truncated = truncated || sanitized.truncated;
      return sanitized.value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        result[key] = sanitize(nested);
      }
      return result;
    }
    return value;
  }

  return {
    value: sanitize(input) as T,
    redactions: Array.from(new Set(redactions)),
    truncated
  };
}

export function sanitizeText(input: string, maxOutputChars: number): Sanitized<string> {
  const redactions: string[] = [];
  let text = redactSecretPatterns(input, (kind) => redactions.push(kind));
  text = redactSensitivePaths(text, redactions);

  let truncated = false;
  if (text.length > maxOutputChars) {
    text = `${text.slice(0, maxOutputChars)}\n[truncated by codex-bridge output limit]`;
    truncated = true;
  }

  return {
    value: text,
    redactions: Array.from(new Set(redactions)),
    truncated
  };
}

function redactSensitivePaths(input: string, redactions: string[]): string {
  return input.replace(/(?:^|[\s"'`(])((?:\/[^\s"'`)]+)+)/g, (match, candidate: string) => {
    const parts = candidate.split("/").filter(Boolean);
    if (parts.some((part) => isSensitiveBasename(part))) {
      redactions.push("sensitive-path");
      return match.replace(candidate, "[redacted-sensitive-path]");
    }
    return match;
  });
}
