import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { defaultConfig, loadConfig } from "../config/config.js";
import type { Diagnostic, RepositoryMetadata } from "../graph/schema.js";
import type { RepositorySnapshot } from "../adapters/contracts.js";

const execFileAsync = promisify(execFile);
const ROOT_MARKERS = [".git", "prograph.config.json", "package.json", "Cargo.toml", "tsconfig.json", "jsconfig.json"];

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepositoryRoot(input = ".", cwd = process.cwd()): Promise<string> {
  let current = path.resolve(cwd, input);
  if (!(await exists(current))) {
    throw new Error(`Repository path does not exist: ${current}`);
  }
  if (!(await stat(current)).isDirectory()) current = path.dirname(current);
  let candidate = current;
  while (true) {
    if ((await Promise.all(ROOT_MARKERS.map((marker) => exists(path.join(candidate, marker))))).some(Boolean)) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return current;
    candidate = parent;
  }
}

export async function getRepositoryMetadata(root: string): Promise<RepositoryMetadata> {
  let gitCommit: string | undefined;
  try {
    gitCommit = (await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  } catch {
    // Git metadata is advisory; standalone directories are valid repositories.
  }
  const realRoot = path.resolve(root);
  const identity = createHash("sha256").update(realRoot).digest("hex").slice(0, 16);
  return { root: realRoot, identity, ...(gitCommit ? { gitCommit } : {}) };
}

export interface ScanResult {
  snapshot: RepositorySnapshot;
  diagnostics: Diagnostic[];
  excludedFileCount: number;
}

export async function scanRepository(root: string): Promise<ScanResult> {
  const repository = await getRepositoryMetadata(root);
  const diagnostics: Diagnostic[] = [];
  let config;
  try {
    config = await loadConfig(root);
  } catch (error) {
    config = defaultConfig();
    diagnostics.push({
      code: "invalid-configuration",
      severity: "error",
      message: String(error),
      file: "prograph.config.json",
      adapter: "repository",
      metadata: {},
    });
  }
  const files = await fg(config.include, {
    cwd: root,
    ignore: config.exclude,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
  });
  files.sort();
  const allCandidateFiles = await fg(config.include, {
    cwd: root,
    onlyFiles: true,
    unique: true,
    dot: true,
    followSymbolicLinks: false,
  });
  const absoluteFiles = new Map<string, string>();
  const fileContents = new Map<string, string>();
  for (const relativeFile of files) {
    const normalized = relativeFile.split(path.sep).join("/");
    const absolute = path.join(root, relativeFile);
    absoluteFiles.set(normalized, absolute);
    try {
      fileContents.set(normalized, await readFile(absolute, "utf8"));
    } catch (error) {
      diagnostics.push({
        code: "unreadable-file",
        severity: "warning",
        message: `Unable to read ${normalized}: ${String(error)}`,
        file: normalized,
        adapter: "repository",
        metadata: {},
      });
    }
  }
  const metadataFiles = await fg(
    ["**/package.json", "**/Cargo.toml", "**/tsconfig.json", "**/jsconfig.json", "**/tauri.conf.json", "**/tauri.conf.json5"],
    { cwd: root, ignore: config.exclude, onlyFiles: true, unique: true, dot: true, followSymbolicLinks: false },
  );
  for (const relativeFile of metadataFiles) {
    const normalized = relativeFile.split(path.sep).join("/");
    if (fileContents.has(normalized)) continue;
    const absolute = path.join(root, relativeFile);
    absoluteFiles.set(normalized, absolute);
    try {
      fileContents.set(normalized, await readFile(absolute, "utf8"));
    } catch {
      // Source-file read failures are reported above; metadata detection is best effort.
    }
  }
  return {
    snapshot: { repository, config, files: [...absoluteFiles.keys()], absoluteFiles, fileContents },
    diagnostics,
    excludedFileCount: Math.max(0, allCandidateFiles.length - files.length),
  };
}
