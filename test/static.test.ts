import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC_FILES = [
  "src/cli.ts",
  "src/config.ts",
  "src/jobs.ts",
  "src/redaction.ts",
  "src/secretPatterns.ts",
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

describe("package hygiene", () => {
  it("does not package local security reports or source/test internals", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      private?: boolean;
      files?: string[];
    };
    expect(pkg.private).toBe(true);
    expect(pkg.files).toEqual(["dist/", "README.md", "LICENSE", "NOTICE"]);
    expect(readFileSync(".gitignore", "utf8")).toMatch(/^\.gstack\/$/m);

    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8"
    });
    expect(packed.status, packed.stderr).toBe(0);
    const files = (JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>)[0].files.map(
      (file) => file.path
    );

    expect(files.some((file) => file.startsWith(".gstack/"))).toBe(false);
    expect(files.some((file) => file.startsWith("src/"))).toBe(false);
    expect(files.some((file) => file.startsWith("test/"))).toBe(false);
    expect(files.some((file) => file.startsWith("tmp-fixtures/"))).toBe(false);
    expect(files.some((file) => file.startsWith("upstream-reference/"))).toBe(false);
  });
});
