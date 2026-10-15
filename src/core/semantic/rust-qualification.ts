/** Reviewed release receipts. Archive and executable hashes bind packaging to a platform. */
export const RUST_ANALYZER_RELEASE = {
  release: "2026-10-12",
  revision: "2ad81e72b7e978cb800dffe1bcce5c9f98032acf",
  commitDate: "2026-10-11",
  semanticVersion: "0.3.3081",
  artifacts: {
    "darwin:arm64": {
      name: "rust-analyzer-aarch64-apple-darwin.gz",
      archiveSha256: "a2e45e828b37bfc4b507c2ca456e8b61096e0bdfbae225f3d33295546d1eeacf",
      executableSha256: "c863e967a7244fa3687d7bd6235ac7abae5a7ce44bcbf8307eb1dc80aa85f397",
    },
    "linux:x64": {
      name: "rust-analyzer-x86_64-unknown-linux-gnu.gz",
      archiveSha256: "040cab4e2abc490fadd95c3f6cbc60b941a78761dbc3acf0ec66fd7a97f31db3",
      executableSha256: "fd89304c85f6c1996b036ea8f2c9ad9d3e25a197dbd713661c7fe51ec9dc8e49",
    },
  },
} as const;

export function qualifyRustAnalyzer(output: string, executableSha256: string, platform: string = process.platform, arch: string = process.arch) {
  const artifact = RUST_ANALYZER_RELEASE.artifacts[`${platform}:${arch}` as keyof typeof RUST_ANALYZER_RELEASE.artifacts];
  if (!artifact || artifact.executableSha256 !== executableSha256) throw Error(`Rust analyzer executable is not a qualified ${platform}/${arch} release artifact`);
  if (output.length > 4096) throw Error("Rust analyzer version output exceeds qualification bound");
  // Parse identity fields, not the complete human-facing display format.
  const header = /^rust-analyzer\s+(\d+\.\d+\.\d+)(?:-standalone)?(?=\s|$)/.exec(output.trim());
  if (header?.[1] !== RUST_ANALYZER_RELEASE.semanticVersion) throw Error(`Rust analyzer semantic version mismatch: ${output.slice(0, 200)}`);
  const suffix = output.trim().slice(header[0].length);
  const hashes = suffix.match(/\b[a-f0-9]{7,40}\b/gi) ?? [];
  if (hashes.length > 1 || hashes.some(hash => !RUST_ANALYZER_RELEASE.revision.startsWith(hash.toLowerCase()))) throw Error(`Rust analyzer revision mismatch: ${output.slice(0, 200)}`);
  const dates = suffix.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  if (dates.some(date => date !== RUST_ANALYZER_RELEASE.commitDate && date !== RUST_ANALYZER_RELEASE.release)) throw Error(`Rust analyzer date mismatch: ${output.slice(0, 200)}`);
  return { release: RUST_ANALYZER_RELEASE.release, revision: RUST_ANALYZER_RELEASE.revision, semanticVersion: header[1], platform, arch,
    artifact: artifact.name, archiveSha256: artifact.archiveSha256, executableSha256, observedRevision: hashes[0]?.toLowerCase() ?? null,
    observedDate: dates[0] ?? null, revisionEvidence: hashes.length ? "embedded-and-pinned-artifact" : "pinned-release-artifact" };
}
