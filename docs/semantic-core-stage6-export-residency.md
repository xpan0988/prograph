# Stage 6.3 — bounded legacy JSON export

Status: implementation measured; required full local regression and CI are in progress.
No Stage 6.3 acceptance yet. The 60-second and
1-GiB gates remain unqualified. Core-only RSS has not been established.

## Baseline and scope

The starting checkout was clean `main` at
`a598004f253d68361936bd09786c9a27776b0e04`, documenting the accepted Rust
implementation `c4569685f2027e4cbf9c2b28e47121e42daf8bf9`. The baseline push CI
[run 39698750479](https://github.com/xpan0988/prograph/actions/runs/39698750479)
completed successfully. The Rust adapter's SHA-256 is
`2e80243e80bc424a53be87c5757037465f8cdc43e0628b9e9b3379d2bf47196d`;
Stage 6.3 must leave it unchanged.

The accepted Stage 6.2 complete run was 59.704 seconds with 1,322,128 KiB process
high-water RSS. That single sample is context, not a controlled Stage 6.3 timing
comparison or a qualified 60-second result. See
[the Stage 6.2 receipt](benchmarks/semantic-core-stage6-rust-traversal.json).

This work concerns serialization and temporary data in legacy exports only.
Canonical identity, snapshot encoding, SQLite transactions, the Semantic Pass
DAG, GraphBuilder and compiler ownership are outside scope.

## Accepted write path and filesystem contract

Both `analyzeRepository` and incremental `sync` publish Semantic Core and finish
`persistGraph` before beginning legacy JSON exports. `persistGraph` writes
per-row JSON into legacy SQLite; it does not stringify the complete graph.
Its existing global-query materialization is outside this change.

The final `Promise.all` evaluates four write arguments synchronously:
`graph.json`, `manifest.json`, `diagnostics.json`, and `writeIndexState`'s
`state.json`. Every argument uses `JSON.stringify(value, null, 2) + "\n"`.
Consequently complete graph and diagnostics JSON strings coexist with the
required returned `GraphData`, source/analysis objects and asynchronous UTF-8
write buffers. Completion order is unspecified. A rejection does not cancel
other writes already started. The semantic snapshot can already be committed;
legacy JSON files are not one transaction with it or with each other.

The accepted `writeFile` calls open with `w`: existing files are truncated in
place, retaining their inode and mode. Final symlinks are followed, including
dangling links whose referents can be created. Hard-linked peers see the same
in-place update. An existing writable file can be overwritten without write
permission on its parent directory. Partial output can become visible after
failure or termination.

These behaviors were checked directly using regular files, symlinks, hard
links, mode `0444` files, and mode `0555` directories on the benchmark host.
Atomic replacement preserves a valid old file on failed serialization/write,
but requires parent-directory write permission and a new inode. It cannot also
preserve hard-link update semantics. The request to preserve every old
filesystem behavior therefore conflicts with the new failure-safety requirement.
The user explicitly approved this strengthened per-file atomic-export contract
on 22 October 2026, including documented safe refusal of unsupported destinations.

Historical compatibility export already has a different contract: write five
files sequentially with exclusive creation inside an unpublished generation,
sync the generation, and exclusively publish a directory symlink. An existing
destination is refused. Streaming inside that private generation need not
change its publication or recovery behavior. Reconstruction still materializes
the selected compatibility graph and its existing canonical hash; those
lifetimes and encodings are unchanged.

## Implemented serialization and publication

`storage/json-stream.ts` walks objects iteratively in native property order,
preserves array order and native pretty-print whitespace, and escapes bounded
string slices with the native JSON string encoder. It captures object keys and
array lengths using the same enumeration rules, invokes `toJSON` once per
visited property, omits unsupported object values, and emits `null` for
unsupported array values. Ancestor tracking detects cycles. Output includes
the accepted trailing newline.

Chunks contain at most 16,384 UTF-16 code units, with surrogate pairs kept
together. One encoded buffer of at most 49,152 UTF-8 bytes is written at a time;
short writes are awaited before proceeding. No complete document is accumulated.
Traversal retains active object-key lists and depth frames; it does not remove
the caller's required `GraphData`. Logical allocation counters describe buffers
created by this writer, not V8 reclamation timing or process-wide native memory.

`storage/json-export.ts` resolves stable final symlink chains, including dangling
links, without replacing the link itself. Existing ordinary regular files must
have one link, no special mode bits, and actual write permission (checked without
truncation). A random sibling is opened exclusively with mode `0600`. After
streaming, the writer preserves existing owner/group and mode bits, or uses
`0666 & ~umask` for a new file, syncs/closes it, and rechecks destination witnesses.
Existing files use same-directory rename. Absent destinations use exclusive hard
link creation followed by temporary unlink, preventing overwrite of a newly
created competing destination. POSIX parent directories are synced afterward.

Analysis and incremental sync call the same sequential four-file export helper:
graph, manifest, diagnostics, state. This establishes completion order for these
files, but **does not make them a transaction**. A later failure can leave earlier
files updated and later files unchanged. Each visible file is complete. Semantic
Core's FULL/WAL publication and source freshness barrier are untouched and can
already have committed when a legacy export fails. Direct library return objects
and CLI/MCP/API schemas are unchanged; successful calls still await exports.

Historical compatibility export retains exclusive private-generation writes,
generation sync, cleanup on failure and exclusive directory-symlink publication.
Only serialization inside that generation changes.

The independent test oracle is the literal accepted native serializer at the
pre-change revision. Initial focused tests cover empty and large arrays,
sparse and unsupported values, nested metadata, enumeration order, Unicode and
surrogate boundaries, boxed primitives, `toJSON`, getter order, seeded cases,
cycles, and backpressure. Existing mixed-repository tests compare complete
analysis and historical-export bytes against it. No graph bytes are normalized.

Hard-linked files, special files/modes, unwritable parents, or owner/group values
the process cannot preserve fail safely. Atomic replacement changes the inode;
extended ACLs, xattrs, arbitrary concurrent mutations and positive Windows
filesystem/durability behavior are not qualified. Cooperating analysis writers
remain serialized by IndexLease. Witness checks detect observed path changes;
they are not CAS against hostile filesystem edits after the final check.

## Failure and recovery evidence

The focused tests exercise actual regular/symlink/dangling-link destinations,
permissions, stale siblings, link loops and changed/replaced destinations;
injected third-write `EIO` and `ENOSPC`; abort after a write; invalid cyclic/BigInt
serialization; file-sync failure; and real child-process SIGKILL midstream.
The accepted bytes survive each pre-publication failure, with only the writer's
own temporary file cleaned on handled errors. A killed process can leave a
random stale sibling. Restart ignores it and succeeds after midstream SIGKILL.
ENOSPC is safely injected, not physical disk exhaustion.

A distinct new-file commit-window limitation is explicit and tested as a
filesystem-state simulation: termination after exclusive link but before unlink
can leave a **complete** final/temp hard-linked pair. Overwrite then refuses the
two-link file until the identified stale sibling is explicitly removed; it does
not guess which aliases belong to the user. Termination after rename or a
parent-sync error can likewise report failure despite a complete new file being
visible. No partial document replaces an accepted file. No power-loss hardware
experiment or cross-file rollback guarantee is claimed.

## Controlled measurements and complete equivalence

The exact frozen Pastey capture remains available. All 421 copied-file hashes,
recorded dependency/native binary hashes, source `node_modules` realpath and
pinned managed provider tool trees were checked before measurement. The selected
315 files contain 7,452,350 bytes; 261 code files contain 6,535,832 bytes and
173,142 physical lines. The original HEAD is
`8714e1ee57e00b70fdf1e03d6c182a8ef984ded0`, but this is a captured dirty tree:
HEAD alone cannot reconstruct it. Raw inventory hash is
`046e71411c366bd85acffc12a83cfc80590016e0223629aac9ac11f454ab6e6b`;
selected inventory is
`729c1eb199f09ccd9739634699bdc004388402544fcc8806c674ba471b6365b8`.

Host: Apple M5, 16 GiB physical RAM, macOS 26.5.2 arm64, Node 25.9.0,
`--max-old-space-size=2048`. Exact runtime/native/package versions and hashes are
in the [machine receipt](benchmarks/semantic-core-stage6-export-residency.json).
The experiments were serial, with no competing heavy test/benchmark process.
No forced GC, CPU profile or allocation inspector was used.

| Focused saved-output export, one fresh process per arm | Accepted writer | Bounded atomic writer |
|---|---:|---:|
| Export wall time | 395.462 ms | 843.442 ms |
| Cumulative process peak RSS | 1,352,384 KiB | 503,936 KiB |
| Process RSS immediately before export | 503,037,952 B | 437,141,504 B |
| Process RSS immediately after export | 1,036,926,976 B | 516,030,464 B |
| External memory immediately after export | 120,452,184 B | 2,604,983 B |
| ArrayBuffer memory immediately after export | 118,193,475 B | 344,226 B |

The time trade-off is **+447.980 ms** for this pair, including new sync/publication
work. Cumulative RSS falls by 848,448 KiB in this harness. Input loading is outside
the timer but inside the cumulative RSS measurement, and separately parses the
saved diagnostics in both arms (production shares `graph.diagnostics`). Initial
heap/GC states differ despite identical commands and inputs. Twenty-millisecond
samples miss synchronous peaks; OS caching, run order and allocator/GC variation
remain confounders. Do not extrapolate that RSS difference to the whole pipeline.

Both arms produce four complete files byte-identical to accepted output (`cmp`),
including manifest and state. The graph is **102,548,074 B**, SHA-256
`0183e8f4f580a5d567f21160b8285568de60307a536c415fe6c0ced30001d28a`;
diagnostics are **15,529,775 B**, SHA-256
`631fa69e6fdd6f49b339303a9b454228e05a9f79fb362d9a5a7e6b86bf6503ce`.
The bounded writer creates 6,260 graph buffers (largest 16,466 B), 948 diagnostics
buffers (largest 16,404 B), one manifest buffer and three state buffers. Encoded
bytes total the file sizes; this reduces simultaneous residency, not total bytes
eventually encoded. Unreachable buffers can remain in V8/native allocator pages
until collection/reuse. Logical allocation counts are not an allocator census.

One fresh complete analysis with the existing lightweight phase runner measured
**58.864 s / 1,330,896 KiB** cumulative process peak. This is not a controlled
whole-pipeline improvement over Stage 6.2's uninstrumented 59.704 s / 1,322,128 KiB.
Instrumentation overhead was not separately calibrated; no confirmatory run was
needed or performed. The pipeline retains the accepted 40,641 nodes, 78,396 edges,
46,940 diagnostics, 234,946 facts/claims and 908,472,320-byte semantic database.

| Selected complete-run interval (nested rows must not be summed) | Wall time | RSS begin → end (MiB) | Cumulative peak at end (KiB) |
|---|---:|---:|---:|
| Syntax graph | 3.090 s | 170.4 → 754.3 | 830,128 |
| Owned analysis | 25.549 s | 754.3 → 1,107.8 | 1,330,896 |
| Owned fingerprint (inside owned analysis) | 0.509 s | 755.9 → 1,021.6 | 1,160,608 |
| Syntax fact staging (inside owned analysis) | 19.573 s | 1,021.6 → 1,093.7 | 1,160,608 |
| Owned dependency projection (inside owned analysis) | 1.379 s | 1,289.6 → 1,107.8 | 1,330,896 |
| Semantic foundation | 25.282 s | 1,061.1 → 1,096.6 | 1,330,896 |
| Semantic publication (inside foundation) | 14.124 s | 1,051.7 → 1,097.5 | 1,330,896 |
| Legacy SQLite export | 3.911 s | 1,096.6 → 1,152.2 | 1,330,896 |
| JSON export | 0.935 s | 1,152.2 → 1,102.1 | 1,330,896 |

The observed process high-water now occurs before JSON export, bracketed by
owned dependency projection boundaries. JSON export raises no new high-water.
Its endpoint V8 heap used changes 480.41 → 440.21 MiB, committed heap 591.89 →
515.70 MiB, external 2.93 → 6.72 MiB and ArrayBuffers 0.68 → 4.46 MiB. These are
instantaneous process-wide endpoints, not subsystem attribution or export peaks.
The complete receipt contains CPU-time deltas and cumulative high-water readings
for all phase intervals. Compiler/native/SQLite memory remains shared and cannot
be obtained by subtraction.

The complete production graph and diagnostics also pass raw `cmp` against the
accepted Stage 6.2 files. All eight accepted complete semantic/compatibility
hashes match, along with source inventories, legacy SQLite/cache equivalence,
SQLite integrity and foreign-key witnesses. Required ownership/support,
freshness, regression and CI acceptance evidence is still being collected.

## Reproduction and acceptance

Build the exact implementation and verify the capture/dependency fingerprints
against the Stage 6.1 and this receipt before using the recorded paths. Preserve
the accepted output separately. Use fresh output directories for every command:

```sh
npm run build:node
node --max-old-space-size=2048 scripts/semantic-export-profile.mjs before ACCEPTED_INDEX FRESH_BEFORE BEFORE_REPORT.json
node --max-old-space-size=2048 scripts/semantic-export-profile.mjs after ACCEPTED_INDEX FRESH_AFTER AFTER_REPORT.json
cmp ACCEPTED_INDEX/exports/graph.json FRESH_AFTER/exports/graph.json
cmp ACCEPTED_INDEX/diagnostics.json FRESH_AFTER/diagnostics.json
node --max-old-space-size=2048 scripts/semantic-profile.mjs phases FROZEN_SOURCE FRESH_INDEX PRODUCTION_REPORT.json
node scripts/semantic-profile-verify.mjs FROZEN_SOURCE FRESH_INDEX WITNESS.json
cmp ACCEPTED_INDEX/exports/graph.json FRESH_INDEX/exports/graph.json
cmp ACCEPTED_INDEX/diagnostics.json FRESH_INDEX/diagnostics.json
```

The two focused arms are the only focused performance pair; the phase run is the
only full production analysis. Hashing and database/source verification occur
after timing, in separate processes. Raw reports remain outside Git at the
receipt's temporary evidence root, with recorded SHA-256 values. No oversized
profiler traces or heap dumps are committed. Exact full regression/build/recovery
and actual Node 20/22/24 CI results must pass before acceptance.

## Remaining lifetimes and constraints

This design requires the graph owned by analysis to remain stable during
asynchronous export; the direct API still returns that complete object only
after exports finish. It does not snapshot arbitrarily concurrently mutated
library objects. No forced GC is used or proposed as evidence of a fix.

Source strings, Tree-sitter/native allocations, bundled TypeScript compiler
objects, GraphBuilder representations, semantic projection collections and
historical compatibility reconstruction remain Stage 6.4 investigations.
Process RSS cannot be assigned to Core by subtracting compiler heap or V8 heap
figures. Whether the high-water moves to another phase requires a measured run.
