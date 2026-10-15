import { spawn } from "node:child_process";

export interface ProcessLimits { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }
export class ProviderProcessError extends Error {
  constructor(readonly reason: "cancelled" | "deadline" | "output" | "exit" | "startup", detail: string) { super(`Provider ${reason}: ${detail.slice(0, 2048)}`); }
}
/** Argv-only execution. POSIX descendants share a killable process group; no shell is involved. */
export function runProviderProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, limits: ProcessLimits): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || !Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) throw Error("Invalid process limits");
  limits.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now(); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let bytes = 0; let failure: ProviderProcessError | undefined; let escalation: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(executable, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Group may already have exited. */ } };
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
    child.stdout.on("data", chunk => collect(stdout, chunk as Buffer)); child.stderr.on("data", chunk => collect(stderr, chunk as Buffer));
    child.on("error", error => { failure ??= new ProviderProcessError("startup", String(error)); });
    child.on("close", code => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      // A successful launcher can leave children with closed/inherited-away pipes.
      kill("SIGKILL");
      limits.signal?.removeEventListener("abort", abort);
      const out = Buffer.concat(stdout).toString("utf8"); const err = Buffer.concat(stderr).toString("utf8");
      if (failure) reject(failure); else if (code !== 0) reject(new ProviderProcessError("exit", `exit ${code}: ${err}`));
      else resolve({ stdout: out, stderr: err, durationMs: performance.now() - started });
    });
  });
}
