import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC_FILES = [
  "src/cli.ts",
  "src/config.ts",
  "src/jobs.ts",
  "src/redaction.ts",
  "src/server.ts",
  "src/tools.ts",
  "src/upstream.ts"
];

describe("removed upstream paths", () => {
  it("does not include reverse ChatGPT/OpenAI API or write tool code", () => {
    const source = SRC_FILES.map((file) => readFileSync(file, "utf8")).join("\n");

    expect(source).not.toContain("ask_chatgpt");
    expect(source).not.toContain("codex_run");
    expect(source).not.toContain("codex_reply");
    expect(source).not.toMatch(/\/responses\b/);
    expect(source).not.toMatch(/chat\.completions/i);
    expect(source).not.toContain("process.env.OPENAI_API_KEY");
    expect(source).not.toContain("workspace-write");
    expect(source).not.toContain("danger-full-access");
  });
});
