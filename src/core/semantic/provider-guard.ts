/** Private argv-only process guardian. The compiler never inherits this IPC fd.
 * Keep this process outside the SDK group: it must survive its owner's death
 * long enough to kill that group and drain successful output without truncation.
 */
import { spawn, type ChildProcess } from "node:child_process";

interface Request { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
let child: ChildProcess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let ending = false;
const kill = () => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group has exited. */ } } };
const finish = (message: Record<string, unknown>) => {
  if (ending) return;
  ending = true; kill(); clearTimeout(timer);
  if (process.connected) process.send?.(message, () => { if (process.connected) process.disconnect(); });
};
process.on("disconnect", () => { ending = true; kill(); clearTimeout(timer); });
process.on("SIGTERM", () => { kill(); process.exit(143); });
process.on("exit", kill);
process.once("message", (value: unknown) => {
  if (!process.connected || ending) return;
  const request = value as Request;
  if (!request || typeof request.executable !== "string" || !Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string") || typeof request.cwd !== "string" || !request.env || typeof request.env !== "object" || Object.values(request.env).some(value => typeof value !== "string") || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0 || Buffer.byteLength(JSON.stringify(request)) > 8 * 1024 ** 2) {
    finish({ type: "failure", reason: "startup", detail: "Invalid bounded provider guard request" }); return;
  }
  let bytes = 0;
  const sdk = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  child = sdk;
  process.send?.({ type: "spawn", pid: sdk.pid }, error => { if (error) { ending = true; kill(); clearTimeout(timer); } });
  timer = setTimeout(() => finish({ type: "failure", reason: "deadline", detail: `${request.timeoutMs}ms exceeded in guardian` }), request.timeoutMs);
  for (const [input, output] of [[sdk.stdout, process.stdout], [sdk.stderr, process.stderr]] as const) input.on("data", (chunk: Buffer) => {
    if (ending) return;
    bytes += chunk.length;
    if (bytes > request.maxOutputBytes) { finish({ type: "failure", reason: "output", detail: `${request.maxOutputBytes} bytes exceeded in guardian` }); return; }
    if (!output.write(chunk)) { input.pause(); output.once("drain", () => input.resume()); }
  });
  sdk.on("error", error => finish({ type: "failure", reason: "startup", detail: String(error).slice(0, 2048) }));
  // Exit (rather than close) also kills descendants holding inherited pipes open.
  sdk.on("exit", () => {
    kill(); child = undefined;
    if (process.connected) process.send?.({ type: "reaped" }, () => {});
  });
  sdk.on("close", (code, signal) => finish({ type: "exit", code, signal }));
});
