import { randomUUID } from "node:crypto";
import type { ToolResult } from "./upstream.js";

export type CodexJobStatus = "running" | "completed" | "failed";

export type CodexJob = {
  jobId: string;
  operation: "codex_read";
  createdAt: number;
  updatedAt: number;
  status: CodexJobStatus;
  result?: ToolResult;
  error?: string;
  promise: Promise<void>;
};

export class CodexJobRegistry {
  private readonly jobs = new Map<string, CodexJob>();

  constructor(
    private readonly options: {
      maxJobs: number;
      ttlMs: number;
      maxConcurrent: number;
    }
  ) {}

  get size(): number {
    this.prune();
    return this.jobs.size;
  }

  runningCount(): number {
    this.prune();
    return [...this.jobs.values()].filter((job) => job.status === "running").length;
  }

  get(jobId: string): CodexJob | undefined {
    this.prune();
    return this.jobs.get(jobId);
  }

  start(run: () => Promise<ToolResult>): CodexJob {
    this.prune();
    if (this.runningCount() >= this.options.maxConcurrent) {
      throw new Error("Another codex_read job is already running. Poll it or wait before starting a new one.");
    }
    const now = Date.now();
    const job: CodexJob = {
      jobId: randomUUID(),
      operation: "codex_read",
      createdAt: now,
      updatedAt: now,
      status: "running",
      promise: Promise.resolve()
    };
    job.promise = Promise.resolve()
      .then(run)
      .then((result) => {
        job.status = "completed";
        job.result = result;
        job.updatedAt = Date.now();
      })
      .catch((error: unknown) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.updatedAt = Date.now();
      });
    this.jobs.set(job.jobId, job);
    this.pruneOverflow();
    return job;
  }

  expiresAt(job: CodexJob): string {
    return new Date(job.updatedAt + this.options.ttlMs).toISOString();
  }

  private prune(): void {
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "running" && now - job.updatedAt > this.options.ttlMs) {
        this.jobs.delete(jobId);
      }
    }
    this.pruneOverflow();
  }

  private pruneOverflow(): void {
    if (this.jobs.size <= this.options.maxJobs) {
      return;
    }
    const sorted = [...this.jobs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of sorted.slice(0, this.jobs.size - this.options.maxJobs)) {
      if (job.status !== "running") {
        this.jobs.delete(job.jobId);
      }
    }
  }
}
