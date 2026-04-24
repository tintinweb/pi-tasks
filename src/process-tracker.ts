/**
 * process-tracker.ts — Background process management for tasks.
 *
 * Tracks spawned child processes, buffers their output, and supports
 * blocking wait and graceful stop (SIGTERM → 5s → SIGKILL).
 */

import type { ChildProcess } from "node:child_process";
import type { BackgroundProcess } from "./types.js";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

export interface ProcessOutput {
  output: string;
  status: BackgroundProcess["status"];
  exitCode?: number;
  signal?: string;
  startedAt: number;
  completedAt?: number;
  command?: string;
}

export class ProcessTracker {
  private processes = new Map<string, BackgroundProcess>();
  private outputCache = new Map<string, string>();

  /** Register a spawned process for a task. */
  track(taskId: string, proc: ChildProcess, command?: string): void {
    const bp: BackgroundProcess = {
      taskId,
      pid: proc.pid ?? -1,
      command,
      output: [],
      totalBytes: 0,
      status: "running",
      startedAt: Date.now(),
      proc,
      abortController: new AbortController(),
      waiters: [],
    };

    const appendOutput = (chunk: Buffer) => {
      const str = chunk.toString();
      const byteLen = Buffer.byteLength(str);
      bp.totalBytes += byteLen;
      bp.output.push(str);
      this.outputCache.delete(taskId);
      while (bp.totalBytes > MAX_OUTPUT_BYTES && bp.output.length > 1) {
        const removed = bp.output.shift()!;
        bp.totalBytes -= Buffer.byteLength(removed);
      }
    };

    proc.stdout?.on("data", (data: Buffer) => {
      appendOutput(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      appendOutput(data);
    });

    proc.on("close", (code, signal) => {
      if (bp.status === "running") {
        bp.status = code === 0 ? "completed" : "error";
      }
      bp.exitCode = code ?? undefined;
      bp.signal = signal ?? undefined;
      bp.completedAt = Date.now();
      for (const resolve of bp.waiters) resolve();
      bp.waiters = [];
    });

    proc.on("error", (err) => {
      if (bp.status === "running") {
        bp.status = "error";
        appendOutput(Buffer.from(`Process error: ${err.message}`));
        bp.completedAt = Date.now();
        for (const resolve of bp.waiters) resolve();
        bp.waiters = [];
      }
    });

    this.processes.set(taskId, bp);
  }

  /** Get current output and status for a task's process. */
  getOutput(taskId: string): ProcessOutput | undefined {
    const bp = this.processes.get(taskId);
    if (!bp) return undefined;
    let cached = this.outputCache.get(taskId);
    if (cached === undefined) {
      cached = bp.output.join("");
      this.outputCache.set(taskId, cached);
    }
    return {
      output: cached,
      status: bp.status,
      exitCode: bp.exitCode,
      signal: bp.signal,
      startedAt: bp.startedAt,
      completedAt: bp.completedAt,
      command: bp.command,
    };
  }

  /** Wait for a task's process to complete, with timeout. */
  waitForCompletion(taskId: string, timeout: number, signal?: AbortSignal): Promise<ProcessOutput | undefined> {
    const bp = this.processes.get(taskId);
    if (!bp) return Promise.resolve(undefined);
    if (bp.status !== "running") return Promise.resolve(this.getOutput(taskId));

    return new Promise<ProcessOutput | undefined>((resolve) => {
      let settled = false;
      const timer = setTimeout(finish, timeout);

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve(self.getOutput(taskId));
      }

      const self = this;
      bp.waiters.push(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Stop a task's background process. SIGTERM → 5s → SIGKILL. */
  async stop(taskId: string): Promise<boolean> {
    const bp = this.processes.get(taskId);
    if (!bp || bp.status !== "running") return false;

    bp.status = "stopped";
    bp.proc.kill("SIGTERM");

    // Wait up to 5s for graceful exit
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { bp.proc.kill("SIGKILL"); } catch { /* already dead */ }
        resolve();
      }, 5000);

      bp.proc.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    bp.completedAt = Date.now();
    for (const resolve of bp.waiters) resolve();
    bp.waiters = [];
    return true;
  }

  /** Get the process record for a task. */
  getProcess(taskId: string): BackgroundProcess | undefined {
    return this.processes.get(taskId);
  }

  /** Remove a completed/error/stopped process from tracking. */
  remove(taskId: string): boolean {
    const bp = this.processes.get(taskId);
    if (!bp || bp.status === "running") return false;
    this.processes.delete(taskId);
    this.outputCache.delete(taskId);
    return true;
  }

  /** Kill all running processes and clear tracking state. */
  dispose(): void {
    for (const [, bp] of this.processes) {
      if (bp.status === "running") {
        try { bp.proc.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
    this.processes.clear();
    this.outputCache.clear();
  }
}
