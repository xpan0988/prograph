import { spawn, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ProcessLimits { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; parentGuard?: boolean }
export class ProviderProcessError extends Error {
  constructor(readonly reason: "cancelled" | "deadline" | "output" | "exit" | "startup", detail: string) { super(`Provider ${reason}: ${detail.slice(0, 2048)}`); }
}
/** Argv-only execution. Native jobs have a small, independent parent-death guard.
 * Already isolated read workers can opt out to preserve their startup budget.
 */
export function runProviderProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, limits: ProcessLimits): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) throw Error("Invalid process limits");
  limits.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now(); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let failure: ProviderProcessError | undefined; let escalation: ReturnType<typeof setTimeout> | undefined;
    const guarded = process.platform !== "win32" && limits.parentGuard !== false;
    const guard = fileURLToPath(new URL(fileURLToPath(import.meta.url).endsWith(".ts") ? "../../../dist/core/semantic/provider-guard.js" : "./provider-guard.js", import.meta.url));
    const child = guarded ? fork(guard, [], { detached: true, execArgv: ["--max-old-space-size=64"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "ipc"] })
      : spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let sdk: number | undefined; let outcome: { code: number | null; signal: string | null } | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (guarded && sdk) { try { process.kill(-sdk, signal); } catch { /* SDK group has exited. */ } }
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Guard/direct group has exited. */ }
    };
    const stop = (reason: ProviderProcessError["reason"], detail: string) => {
      if (failure) return; failure = new ProviderProcessError(reason, detail); kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    const abort = () => stop("cancelled", "execution aborted");
    const timer = setTimeout(() => stop("deadline", `${limits.timeoutMs}ms exceeded`), limits.timeoutMs);
    limits.signal?.addEventListener("abort", abort, { once: true });
    if (limits.signal?.aborted) abort();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length; if (bytes > limits.maxOutputBytes) stop("output", `${limits.maxOutputBytes} bytes exceeded`);
      else if (!failure) chunks.push(chunk);
    };
    child.stdout!.on("data", chunk => collect(stdout, chunk as Buffer)); child.stderr!.on("data", chunk => collect(stderr, chunk as Buffer));
    if (guarded) {
      child.on("message", (message: { type?: string; pid?: number; code?: number | null; signal?: string | null; reason?: ProviderProcessError["reason"]; detail?: string }) => {
        if (message.type === "spawn" && Number.isSafeInteger(message.pid) && message.pid! > 0) sdk = message.pid;
        else if (message.type === "reaped") sdk = undefined;
        else if (message.type === "exit") { outcome = { code: message.code ?? null, signal: message.signal ?? null }; sdk = undefined; }
        else if (message.type === "failure" && ["startup", "deadline", "output"].includes(message.reason ?? "")) stop(message.reason!, message.detail ?? "Guard failed");
      });
      const request = JSON.stringify({ executable, args, cwd, env, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes });
      if (Buffer.byteLength(request) > 8 * 1024 ** 2) stop("startup", "Provider control request exceeds 8 MiB");
      else child.send?.(JSON.parse(request), error => { if (error) stop("startup", String(error)); });
    }
    child.on("error", error => { failure ??= new ProviderProcessError("startup", String(error)); });
    child.on("close", code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      // A successful launcher can leave children with closed/inherited-away pipes.
      if (!guarded || !outcome) kill("SIGKILL");
      limits.signal?.removeEventListener("abort", abort);
      const out = Buffer.concat(stdout).toString("utf8"); const err = Buffer.concat(stderr).toString("utf8");
      const resultCode = guarded ? outcome?.code : code;
      if (failure) reject(failure); else if (code !== 0 || resultCode !== 0) reject(new ProviderProcessError("exit", `exit ${resultCode ?? code}: ${err}`));
      else resolve({ stdout: out, stderr: err, durationMs: performance.now() - started });
    });
  });
}
