import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const state = vi.hoisted(() => ({ execute: vi.fn(), close: vi.fn(), event: undefined as undefined | ((event: string, filename: string) => void) }));
vi.mock("../src/core/analysis/index-execution.js", () => ({ executeIndex: state.execute }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), watch: (_root: string, _options: unknown, callback: typeof state.event) => { state.event = callback; return { close: state.close }; } }));
import { watchRepository } from "../src/core/analysis/watch.js";
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); state.execute.mockReset(); state.close.mockReset(); state.event = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), "prograph-watch-worker-")); roots.push(value); return value; }

test("watch stop aborts in-flight isolated sync and prevents subsequent callbacks", async () => {
  const repository = await root(); vi.useFakeTimers(); let signal: AbortSignal | undefined;
  state.execute.mockImplementation((_request, options) => { signal = options.signal; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(Error("cancelled")), { once: true })); });
  const onSync = vi.fn(), stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stop = await watchRepository(repository, path.join(repository, "custom"), onSync, 5);
  state.event!("change", "custom/state.json"); state.event!("change", "custom/.semantic-providers/generated.cs");
  await vi.advanceTimersByTimeAsync(10); expect(state.execute).not.toHaveBeenCalled();
  state.event!("change", "a.ts"); await vi.advanceTimersByTimeAsync(10); expect(state.execute).toHaveBeenCalledTimes(1);
  expect(state.execute.mock.calls[0]![0]).toEqual({ operation: "sync", repository, index: path.join(repository, "custom") });
  stop(); await vi.advanceTimersByTimeAsync(10); expect(signal!.aborted).toBe(true); expect(state.close).toHaveBeenCalledOnce();
  state.event!("change", "b.ts"); await vi.advanceTimersByTimeAsync(10); expect(state.execute).toHaveBeenCalledTimes(1); expect(onSync).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
});

test("watch reports a bounded worker failure, ignores generated output and retries the next source event", async () => {
  const repository = await root(); vi.useFakeTimers();
  state.execute.mockRejectedValueOnce(Error("x".repeat(10000))).mockResolvedValue({ statusAfter: { state: "fresh" } });
  const onSync = vi.fn(), stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true), stop = await watchRepository(repository, undefined, onSync, 5);
  try {
    state.event!("change", ".prograph/semantic.sqlite"); await vi.advanceTimersByTimeAsync(10); expect(state.execute).not.toHaveBeenCalled();
    state.event!("change", "a.ts"); await vi.advanceTimersByTimeAsync(10); expect(stderr).toHaveBeenCalledOnce(); expect(String(stderr.mock.calls[0]![0]).length).toBeLessThan(2100);
    state.event!("change", "a.ts"); await vi.advanceTimersByTimeAsync(10); expect(state.execute).toHaveBeenCalledTimes(2); expect(onSync).toHaveBeenCalledWith({ statusAfter: { state: "fresh" } });
  } finally { stop(); }
});
