import { describe, it, expect, beforeEach } from "vitest";
import { ProcessTracker } from "../src/process-tracker.js";
import { spawn } from "node:child_process";

describe("ProcessTracker", () => {
  let tracker: ProcessTracker;

  beforeEach(() => {
    tracker = new ProcessTracker();
  });

  it("returns undefined for untracked task", () => {
    expect(tracker.getOutput("999")).toBeUndefined();
    expect(tracker.getProcess("999")).toBeUndefined();
  });

  it("tracks a process and captures stdout", async () => {
    const proc = spawn("echo", ["hello world"]);
    tracker.track("1", proc, "echo hello world");

    await new Promise<void>((r) => proc.on("close", r));
    // Small delay for event processing
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out).toBeDefined();
    expect(out!.output).toContain("hello world");
    expect(out!.status).toBe("completed");
    expect(out!.exitCode).toBe(0);
    expect(out!.command).toBe("echo hello world");
    expect(out!.startedAt).toBeGreaterThan(0);
    expect(out!.completedAt).toBeGreaterThan(0);
  });

  it("tracks a process and captures stderr", async () => {
    const proc = spawn("sh", ["-c", "echo errdata >&2"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.output).toContain("errdata");
  });

  it("reports error status for non-zero exit", async () => {
    const proc = spawn("sh", ["-c", "exit 42"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("error");
    expect(out!.exitCode).toBe(42);
  });

  it("waitForCompletion returns immediately for already-completed process", async () => {
    const proc = spawn("echo", ["done"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = await tracker.waitForCompletion("1", 1000);
    expect(out).toBeDefined();
    expect(out!.status).toBe("completed");
  });

  it("waitForCompletion returns undefined for untracked task", async () => {
    const out = await tracker.waitForCompletion("999", 1000);
    expect(out).toBeUndefined();
  });

  it("waitForCompletion waits for process to finish", async () => {
    const proc = spawn("sh", ["-c", "sleep 0.1 && echo waited"]);
    tracker.track("1", proc);

    const out = await tracker.waitForCompletion("1", 5000);
    expect(out).toBeDefined();
    expect(out!.output).toContain("waited");
    expect(out!.status).toBe("completed");
  });

  it("waitForCompletion times out if process takes too long", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    const out = await tracker.waitForCompletion("1", 200);
    expect(out).toBeDefined();
    expect(out!.status).toBe("running");

    // Cleanup
    proc.kill("SIGKILL");
  });

  it("stop sends SIGTERM and marks process stopped", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    // Small delay to let process start
    await new Promise((r) => setTimeout(r, 50));

    const stopped = await tracker.stop("1");
    expect(stopped).toBe(true);

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("stopped");
    expect(out!.completedAt).toBeGreaterThan(0);
  });

  it("stop returns false for untracked task", async () => {
    expect(await tracker.stop("999")).toBe(false);
  });

  it("stop returns false for already-completed process", async () => {
    const proc = spawn("echo", ["quick"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    expect(await tracker.stop("1")).toBe(false);
  });

  it("getProcess returns the background process record", () => {
    const proc = spawn("echo", ["test"]);
    tracker.track("1", proc, "echo test");

    const bp = tracker.getProcess("1");
    expect(bp).toBeDefined();
    expect(bp!.taskId).toBe("1");
    expect(bp!.command).toBe("echo test");
    expect(bp!.status).toBe("running");
    expect(bp!.pid).toBeGreaterThan(0);

    proc.kill("SIGKILL");
  });

  it("handles process error event", async () => {
    const proc = spawn("nonexistent-binary-that-does-not-exist-xyz");
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("error", () => r()));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.status).toBe("error");
    expect(out!.output).toContain("Process error:");
  });

  it("sets pid to -1 when spawn fails (pid undefined)", async () => {
    const proc = spawn("nonexistent-binary-that-does-not-exist-xyz");
    tracker.track("1", proc);

    const bp = tracker.getProcess("1")!;
    expect(bp.pid).toBe(-1);

    await new Promise<void>((r) => proc.on("error", () => r()));
  });

  it("waitForCompletion respects abort signal", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const out = await tracker.waitForCompletion("1", 60000, ac.signal);
    expect(out).toBeDefined();
    expect(out!.status).toBe("running");

    proc.kill("SIGKILL");
  });

  it("notifies waiters when process completes", async () => {
    const proc = spawn("sh", ["-c", "sleep 0.1"]);
    tracker.track("1", proc);

    const [r1, r2] = await Promise.all([
      tracker.waitForCompletion("1", 5000),
      tracker.waitForCompletion("1", 5000),
    ]);

    expect(r1!.status).toBe("completed");
    expect(r2!.status).toBe("completed");
  });

  it("reports signal when process is killed", async () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    await new Promise((r) => setTimeout(r, 50));
    proc.kill("SIGTERM");

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    const out = tracker.getOutput("1");
    expect(out!.signal).toBe("SIGTERM");
  });

  it("caps output buffer at 1 MB and evicts oldest entries", () => {
    const proc = spawn("sh", ["-c", "true"]);
    tracker.track("1", proc);

    const bp = tracker.getProcess("1")!;

    // Emit 6 × 256KB chunks via stdout (1.5 MB total, exceeds 1 MB cap)
    for (let i = 0; i < 6; i++) {
      const chunk = Buffer.alloc(256 * 1024, 0x41 + i);
      proc.stdout?.emit("data", chunk);
    }

    // Eviction should keep totalBytes at or below 1 MB
    expect(bp.totalBytes).toBeLessThanOrEqual(1_048_576);
    // Oldest entries should have been evicted
    expect(bp.output.length).toBeLessThan(6);
    // Last chunk should still be present
    expect(bp.output[bp.output.length - 1]).toContain(String.fromCharCode(0x41 + 5));

    proc.kill("SIGKILL");
  });

  it("handles oversized single chunk larger than 1 MB", async () => {
    const proc = spawn("sh", ["-c", "true"]);
    tracker.track("1", proc);

    // Emit a single chunk > 1 MB via stdout event
    const oversized = Buffer.alloc(1_100_000, 0x41); // 1.1 MB of 'A'
    proc.stdout?.emit("data", oversized);

    const bp = tracker.getProcess("1")!;
    // Single chunk can't be evicted (need length > 1), so it stays
    expect(bp.output).toHaveLength(1);
    expect(bp.totalBytes).toBe(1_100_000);

    proc.kill("SIGKILL");
  });

  it("remove() cleans up completed process and cache", async () => {
    const proc = spawn("echo", ["cleanup"]);
    tracker.track("1", proc);

    await new Promise<void>((r) => proc.on("close", r));
    await new Promise((r) => setTimeout(r, 50));

    // Populate the cache
    tracker.getOutput("1");

    // Remove should succeed for completed process
    expect(tracker.remove("1")).toBe(true);
    expect(tracker.getOutput("1")).toBeUndefined();
    expect(tracker.getProcess("1")).toBeUndefined();
  });

  it("remove() returns false for running process", () => {
    const proc = spawn("sleep", ["10"]);
    tracker.track("1", proc);

    expect(tracker.remove("1")).toBe(false);
    expect(tracker.getProcess("1")).toBeDefined();

    proc.kill("SIGKILL");
  });

  it("remove() returns false for untracked task", () => {
    expect(tracker.remove("999")).toBe(false);
  });

  it("returns cached output string and invalidates on new data", async () => {
    const proc = spawn("sh", ["-c", "echo hello && sleep 1"]);
    tracker.track("1", proc);

    // Wait for initial output
    await new Promise((r) => setTimeout(r, 200));

    const out1 = tracker.getOutput("1");
    expect(out1!.output).toContain("hello");

    // Call again — should return same cached string
    const out2 = tracker.getOutput("1");
    expect(out2!.output).toBe(out1!.output);

    // Push new data via stderr to invalidate cache
    proc.stderr?.emit("data", Buffer.from("extra"));
    await new Promise((r) => setTimeout(r, 50));

    const out3 = tracker.getOutput("1");
    expect(out3!.output).toContain("hello");
    expect(out3!.output).toContain("extra");
    // Should differ from the pre-invalidation output
    expect(out3!.output).not.toBe(out1!.output);

    proc.kill("SIGKILL");
  });
});
