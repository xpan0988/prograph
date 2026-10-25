# Stage 6.5 — canonical fingerprint materialization

Status: **accepted single-call-site memory-residency optimization**, implementation
[`aff347fce84624d72e3bcf16324088682d34de82`](https://github.com/xpan0988/prograph/commit/aff347fce84624d72e3bcf16324088682d34de82).
Complete local and exact-commit Node 20/22/24 qualification passed. There is no accepted CPU
speedup, allocation-volume reduction, whole-process RSS guarantee or scale-gate
qualification. The string-producing canonical encoder remains unchanged.

The [compact receipt](benchmarks/semantic-core-stage6-fingerprint.json) records
all observations, including an invalid initial control. Raw inputs, canonical
bytes, CPU traces and indexes remain outside Git in
`/private/tmp/prograph-stage6-5-20261025`.

## Baseline, corpus and scope

The initial checkout was clean `main` at
`a8d02241518c804fe40565bc518e905db499d9e9`. Its actual Node 20/22/24 jobs in
[run 39758337501](https://github.com/xpan0988/prograph/actions/runs/39758337501)
all passed. Stage 6.4 is closed with its candidate rejected. Its lifetime helper
is absent; only numeric diagnostic additions distinguish production extraction
from Stage 6.3. That patch was not reapplied here.

The frozen capture's directories remained, but temporary cleanup had removed
all 421 regular files. Before measuring anything, each recorded SHA-256 was
recovered: 377 files from matching current Pastey contents and 44 from recorded
Git commit `8714e1ee57e00b70fdf1e03d6c182a8ef984ded0`. No current Pastey files were
modified. The original capture path was restored, preserving repository IDs.
Every content hash and both inventories match the accepted records. This is the
same dirty-source capture, not a new checkout falsely labelled comparable.

The selected corpus is 315 files / 7,452,350 bytes; code is 261 files /
6,535,832 bytes / **173,142 physical lines**. Raw inventory SHA-256:
`046e71411c366bd85acffc12a83cfc80590016e0223629aac9ac11f454ab6e6b`;
selected inventory:
`729c1eb199f09ccd9739634699bdc004388402544fcc8806c674ba471b6365b8`.
The dependency symlink still points to `/Users/xiyuanpan/Pastey/node_modules`.
All recorded dependency hashes and nine tool trees match. The deleted existing
SCIP Python 0.6.6 package was restored from the already pinned archive SHA-256
`be8e0a1ec180423c60e9f2c2672c208f49a35ab690ac0f8f1259e4223dbd6e42`;
its complete tree matches the previous qualification. No provider was added.

Host: Apple M5, 10 logical CPUs, 16 GiB, macOS 26.5.2 / build 25F84 /
Darwin 25.5.0 arm64. Node 25.9.0, `--max-old-space-size=2048`, same locked
TypeScript/grammar/SQLite packages and producer pins as the referenced receipts.
The detailed file/dependency pin list remains in the Stage 6.1 record.

## Exact accepted encoding contract

[`model.canonical`](../src/core/semantic/model.ts) is unchanged and remains the
independent reference. This is the existing encoding, not a replacement with
RFC 8785, locale sorting or ordinary JSON serialization:

- Null, primitive strings/booleans and finite numbers use native
  `JSON.stringify`. Negative zero becomes `0`; numeric spelling is native.
- Arrays use `value.map(canonical).join(",")`, surrounded by brackets. Order is
  retained. Sparse holes remain empty slots: a length-three empty array encodes
  as `[,,]`, while explicit `undefined` is rejected. Extra array fields are ignored.
- Objects capture `Object.entries` values before sorting. Keys use the exact
  comparator `a < b ? -1 : a > b ? 1 : 0`, comparing JavaScript UTF-16 strings.
  Each key uses native JSON quoting. Enumerable own string properties count;
  inherited and symbol properties do not. Objects do not invoke `toJSON`.
- Undefined, functions, symbols, primitive BigInt and non-finite numbers throw
  the existing identity error. Generic objects retain their existing sometimes
  surprising behavior: dates/maps with no enumerable fields encode as `{}`.
- Accessor evaluation, array species/map/join behavior and native rejection
  behavior remain observable. Cycles and deep/exotic inputs must not acquire
  silently normalized identities.

Persisted canonical strings, collision checks, validation, quotas, sorting and
snapshot encodings still use this function. `digest`, `semanticKey`, schema and
identity versions are unchanged.

## Implemented encoder and integration

[`canonical-hash.ts`](../src/core/semantic/canonical-hash.ts) adds `writeCanonical`
and `canonicalDigest`. The latter feeds SHA-256 directly. Ordinary plain data
uses recursive traversal, the same object-entry snapshot/comparator and native
quoting of bounded string slices. String slicing and chunk flushing preserve
surrogate pairs. Lone surrogates retain native JSON escaping; no malformed input
is repaired. Sparse-array comma placement matches the reference.

The output accumulator holds at most 16,384 UTF-16 units; each submitted UTF-8
chunk is at most 49,152 bytes. String quoting uses at most 4,096 input units at a
time. There is no complete encoded document or growing Buffer list on this path.
On the corpus, **56,037,908 bytes** reach SHA-256 in **3,421 updates**, with a
largest update of **16,458 bytes**, versus one complete reference string.

A descriptor-only qualification pass checks plain data without invoking input
getters or proxy traps. Local weak sets recognize shared structures and cycles;
they are not global identity caches and do not preserve results across mutations
or source revisions. Any observable/exotic structure, custom array behavior or
deep structure delegates the **whole value** to the unchanged reference before
callbacks run. This preserves evaluation/rejection order and deliberately retains
the old string materialization/resource cost on fallback. The depth threshold
selects an algorithm; it never rejects an otherwise supported identity. Both
production and reconstructed-corpus measurements report **zero fallbacks**.

The encoder also respects V8's existing `MAX_STRING_LENGTH` ceiling, measured
as 536,870,888 UTF-16 units on this runtime. It cannot mint an identity whose
canonical representation could not fit the reference's one-string result.
The native overflow probe produces `RangeError: Invalid string length` without
allocating a giant string. This is an encoding-compatibility constraint, not a
new Core RSS/disk quota. VM/OOM timing is not qualified as an identity guarantee.

Qualification adds an O(N) traversal; encoding retains O(N + sum(k log k)) work,
where k is each object's property count. Temporary traversal/entry lists remain
proportional to depth and container width, and qualification has O(object count)
weak-set bookkeeping. Encoded output buffering is bounded; the caller's original
graph remains live. No graph, compiler or sealed-fact lifetime was changed.

Only the full-graph `deriveOwnedAnalysis` fingerprint changed from
`digest(canonical(value))` to `canonicalDigest(value)`. Its input construction,
existing node/edge pre-sort, pass contracts and source receipts are unchanged.
Numeric phase counters report bytes, chunks, maximum chunk size and fallback.

The call-site audit deliberately leaves other consumers alone:

| Consumer | Treatment |
|---|---|
| Full graph fingerprint | Selected: large, hash-only complete document. |
| Per-file source and projection-shard fingerprints, node proofs, dependency plans | Hash-only candidates remain unchanged; per-operation sizes differ, and no additional allocation attribution justifies expansion. |
| Store entity/fact/provenance encoding, validation and collision checking | Actual strings remain required; unchanged. |
| Projection normalization and canonical byte charges | Actual encoding/quotas remain required; unchanged. |
| Canonical sorting/support deduplication, run/snapshot digests and reports | Existing representation and authority retained. |
| TypeScript ownership fingerprints and compatibility export hashes | Unchanged; not folded into this milestone. |

## Independent correctness evidence

Eight focused tests compare complete canonical strings, captured UTF-8 bytes and
SHA-256 values against unchanged `canonical`/`digest`. They include 2,000 seeded
cases (`0x6501`), valid and invalid nested values, numeric edges, shuffled wide
objects, sparse/non-enumerable/inherited observations, Unicode and escaping at
4,096/16,384-unit boundaries, malformed surrogates, deep/shared/mutated inputs,
large graph arrays, cycles, getters, proxies and map/species/join behavior.
A dispatch-boundary expectation in an early new test was corrected; byte/hash
assertions were not relaxed. One later invocation omitted the required baseline
environment and correctly failed; its configured rerun passed all nine focused
tests. These development failures are not passing qualification evidence.

The accepted runtime is independently archived at `a8d0224`, compiled against
the same locked dependencies. A mandatory fixture oracle compares complete graph
objects and raw export bytes, all stable semantic/legacy SQL tables, per-pass
sealed outputs, supports/selectors/runs, incremental results, pinned historical
claims and an independent fresh rebuild. The final encoder/guard passes it.
The CI verifier requires these tests to execute; absent baselines are failures.

For the exact production fingerprint, the diagnostic harness reconstructs the
input from source-owned sealed observations and current authenticated source
receipts. Its reference hash must equal the actual accepted catalogue before
profiling: **`735c91e0967a66e532efbbe0bea2c2d79fd0ed5ad4b80283f8374e43ba0e2714`**.
A separate post-timing sink compares **all 56,037,908 bytes** with the reference
file, not samples or only hashes. It also verifies EOF and the same SHA-256.
No forced collection is requested.

The corrected production pair preserves the known complete outputs:

| Output | Bytes | SHA-256 |
|---|---:|---|
| `exports/graph.json` | 102,548,074 | `0183e8f4f580a5d567f21160b8285568de60307a536c415fe6c0ced30001d28a` |
| `diagnostics.json` | 15,529,775 | `631fa69e6fdd6f49b339303a9b454228e05a9f79fb362d9a5a7e6b86bf6503ce` |

The full 14-table witness matches: 234,946 facts/claims, 41,438 occurrences,
57,693 support atoms, 1,193 sealed runs, inputs, run digests and selectors/gates.
The 76-table semantic and 29-table legacy comparison preserves the Stage 6.4
rules: documented clocks and authenticated reports derived from those clocks
are handled explicitly; the independently generated `q_meta.generation` UUID
and whole-table hashes remain recorded as unequal. **Complete SQL byte identity
is not claimed.** No additional stable field is excluded. Source freshness is
fresh with all 4,644 recorded semantic inputs checked.

## Controlled measurements and invalid control

The initial archived baseline ran from its archive directory. The candidate ran
from the repository. CWD is a qualified input. The SQL witness correctly refused
the resulting environment/catalogue differences; they were not normalized away.
That 62.212-s / 1,180,944-KiB run is retained as **invalid for comparison**.
The one permitted confirmatory run reran accepted code from the same repository
CWD, with identical harness/heap flags and a fresh output. No further complete
analysis was run. Measurements and heavy tests ran serially.
The valid candidate precedes the corrected control; order was not randomized
and OS-cache warmth was not controlled.

| Valid production observations | Accepted control | Candidate |
|---|---:|---:|
| Complete analysis/export wall | 61.828 s | 65.000 s |
| Process high-water RSS | 1,468,848 KiB | 1,005,776 KiB |
| Fingerprint wall | 557.780 ms | 638.146 ms |
| Fingerprint process CPU | 656.737 ms | 665.349 ms |
| V8 allocation traffic during fingerprint | 1,220,645,272 B | 1,404,486,840 B |
| Fingerprint begin heap used | 336,131,608 B | 341,481,096 B |
| Fingerprint end heap used | 358,086,560 B | 391,932,856 B |
| Fingerprint begin/end committed V8 heap | 470,827,008 / 611,598,336 B | 476,332,032 / 523,157,504 B |
| Fingerprint begin/end instantaneous RSS | 822,460,416 / 1,047,887,872 B | 793,886,720 / 808,157,184 B |
| Fingerprint end external / ArrayBuffer memory | 2,410,074 / 34,251 B | 2,410,074 / 37,403 B |
| Process high-water before fingerprint | 837,472 KiB | 806,080 KiB |
| Process high-water at fingerprint end | 1,157,728 KiB | 816,736 KiB |

These observations show the relevant distinction: the candidate ends with a
larger heap and allocates about 175 MiB **more**, while its fingerprint interval
adds only 10.4 MiB to process high-water versus 312.8 MiB in the control.
The largest encoded string/update is removed. No subsystem owns the difference
in shared process RSS merely because a phase boundary brackets it.

The complete candidate is 3.172 s slower in this single pair. The changed phase's
process CPU differs by only +8.612 ms; most wall difference is outside it,
including untouched staging/publication. No causal whole-analysis speedup or
portable tail-latency claim follows. The observed whole-process peak moves from
TypeScript extraction in the control to the source freshness barrier in the
candidate. Later graph/compiler/native lifetimes remain unresolved.

For context, owned analysis is 28.122 s control / 29.086 s candidate; its nested
syntax staging is 20.759 / 22.010 s. Semantic publication is 14.334 / 15.794 s.
These overlapping phases were not otherwise changed, and must not be summed as
independent costs. Their variation is larger than the changed fingerprint phase.

One targeted profile pairs two fresh, serial encoding-only processes using the
same reconstructed real input and heap flag. Preparation, file writes and the
post-timing byte oracle are excluded from the encoding region:

| Profiled encoding region | Reference | Final bounded encoder |
|---|---:|---:|
| Wall | 452.164 ms | 475.341 ms |
| Process CPU | 566.871 ms | 499.512 ms |
| V8 allocation traffic | 1,210,481,216 B | 1,422,638,648 B |
| Whole child high-water through encoding | 702,432 KiB | 424,640 KiB |

CPU sampling identifies recursive `canonical` construction in the reference;
qualification, string quoting, traversal and chunk formation replace it. Native
work can be charged to JS frames. Recursion/context-inclusive samples overlap and
must not be summed. Process CPU includes background V8 threads; main-thread wall
and process CPU do not give a consistent speedup. **No CPU improvement is
accepted.** The extra descriptor/qualification and token allocations are a real
trade-off; they have not been hidden by reporting only a smaller end heap.

The 1-ms sample union under reference `canonical` is 307.695 ms inclusive /
258.453 ms exclusive. The candidate's canonical-hash frames cover 444.020 ms
inclusive, including 134.215 ms under qualification; qualification has 131.708 ms
exclusive. Recursive contexts are counted once per group/sample. Crypto-update
frames have 83.424 ms reference / 25.156 ms candidate exclusive weight, but native
work can be charged elsewhere. These are samples, not exact function CPU clocks.
Inspector start/stop contributes about 44 ms outside the encoding resource
interval in each trace. Neither the original report's 3.962-s all-call-site
estimate nor these overlapping groups establish a current production CPU gain.

The memory samples above are process-wide instantaneous counters; max RSS is a
cumulative process high-water, and `total_allocated_bytes` differences are V8
cumulative allocation traffic across the phase, including GC/background activity.
External/ArrayBuffer counters overlap and do not account for all SHA/native or
SQLite memory. No retained-object or subsystem allocation attribution is inferred
by subtracting them from RSS.

The allocation sampler (32,768-byte interval; surviving samples, no requested
GC) estimates 112,075,504 live bytes on the reference `digest`/`update` stack at
profile end. This is consistent with retaining/flattening the full canonical
string for native SHA input. Candidate surviving samples total 955,336 bytes,
mostly inspector/runtime setup, with no comparable full-output stack. These are
sampled surviving allocations, not exact retained size, total traffic or a
standalone peak-memory proof; the process high-water observations remain separate.
The diagnostic reference deliberately keeps `encoded` for writing the byte
oracle after timing, and counts its UTF-8 bytes inside timing. Production's inline
`digest(canonical(...))` does not deliberately retain that string after the hash
returns. The child profile's end-of-region liveness is therefore not an exact
production lifetime oracle; the ordinary production timeline is the relevant
RSS witness. Both child timings also include their diagnostic counter work.

The native string-capacity counter/check was added after the ordinary production
candidate run. Its branch is unreachable for the verified 56-MB input, and it
creates no input copy. The final encoder was profiled, full-byte compared and
then qualified by tests/CI. **Exact whole-analysis timing of that final guarded
build was not remeasured**, respecting the exhausted experiment budget. The
65.000-s value is the recorded candidate observation, not a claimed final-build
performance guarantee or a passing gate.

There was no cache flush, CPU affinity/thermal control, native allocator tracing
or forced GC. Desktop processes remained active. Startup/GC/allocator and macOS
compression differences can affect RSS. Profiled child high-water includes its
input loader and startup, and its initial heaps differ; it is not encoder-only
resident memory. CPU/allocation profiling has overhead. The three complete-run
records, invalidation reason, phase samples and profile summaries remain in the
receipt. No V8/TypeScript subtraction is used to estimate Core-only RSS.

## Validation, decision and reproduction

Focused equivalence passed all nine tests. The complete local suite ran **once**:
**315/315 tests, 41 files, zero skips**, with real providers, historical baselines
and seed `0x6a31`. All 18 multi-provider clean-rebuild checks agree. Node/UI
typechecks, complete production build, the four recovery probes and strict
evidence verifier then passed serially. Corruption is refused without changing
the database. Before-seal/before-publish/during-publish crashes retain snapshot 1;
after-publish retains coherent snapshot 2, with the original baseline/history
still readable. The suite includes historical migrations/rollback and old-reader
exports, failed publication, source freshness/invalidation, incremental rebuilds,
negative support/selectors and cancellation. No gate or durability setting changed.

Actual [run 40175602197](https://github.com/xpan0988/prograph/actions/runs/40175602197)
is successful for the exact implementation SHA:

| Job | Runtime | Actual result |
|---|---|---|
| [Node 20](https://github.com/xpan0988/prograph/actions/runs/40175602197/job/121115466314) | 20.20.2 | 315 tests, typechecks, complete build, recovery and evidence verifier passed |
| [Node 22](https://github.com/xpan0988/prograph/actions/runs/40175602197/job/121115466205) | 22.23.3 | Same complete qualification passed |
| [Node 24](https://github.com/xpan0988/prograph/actions/runs/40175602197/job/121115466087) | 24.21.0 | Same complete qualification passed |

Decoded completed-job logs confirm checkout SHA, both new oracle files, 41/315
passing totals and the strict verifier. The receipt records log hashes and all
three artifact digests bound to `aff347f`. This closure changes documentation and
evidence only; source/tests/scripts/workflow Git objects remain identical to that
tested commit. A later documentation commit is not claimed as separately tested.

The memory mechanism is supported by actual bounded SHA input sizes and complete
byte equality, with ordinary and targeted lower process high-water observations.
The single-call-site change is **accepted** for this benefit. More
allocation traffic and no established CPU speedup limit that decision; integration
is not expanded to smaller hash-only callers. No general peak-RSS or time gate is
qualified. The exact final-build production-timing limitation above remains.

Reproduction requires the authenticated capture and dependency trees. Use the
repository CWD for **both** runtimes. Each output must be fresh:

```sh
npm run build:node
node scripts/prepare-semantic-baseline.mjs /private/tmp/baselines fingerprint
# Set PROGRAPH_TEST_FINGERPRINT_BASELINE_RUNTIME to the returned runtime.
npx vitest run tests/canonical-hash.test.ts tests/fingerprint-runtime.test.ts
node --max-old-space-size=2048 ACCEPTED_RUNTIME/scripts/semantic-profile.mjs phases SOURCE CONTROL_INDEX CONTROL.json
node --max-old-space-size=2048 scripts/semantic-profile.mjs phases SOURCE CANDIDATE_INDEX CANDIDATE.json
node scripts/semantic-export-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SOURCE OWNERSHIP.json
node scripts/semantic-owned-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SQL.json
node --max-old-space-size=2048 scripts/semantic-fingerprint-profile.mjs prepare SOURCE CONTROL_INDEX INPUT.json
node --max-old-space-size=2048 scripts/semantic-fingerprint-profile.mjs reference INPUT.json REFERENCE.bin REFERENCE.json
node --max-old-space-size=2048 scripts/semantic-fingerprint-profile.mjs candidate INPUT.json REFERENCE.bin CANDIDATE_PROFILE.json
```

`prepare-semantic-baseline` archives source/build inputs, not diagnostic scripts;
use the identical current harness with imports rooted in the accepted archive,
or archive the full accepted commit as this experiment did. The commands above
use that full archive for `ACCEPTED_RUNTIME`. Preparation serializes a diagnostic
input outside the measured region; it is not a production allocation reduction.
The final local/CI commands and native environments follow the existing workflow,
including the new `fingerprint` baseline. Missing producer evidence must fail the
verifier. These instructions do not authorize another exploratory benchmark loop.

## Remaining work

Core 2.0 remains incomplete. The original/normalized graphs, compiler/AST/source
inventory lifetimes, compatibility bootstrap, transaction layout and JSON export
remain unchanged. Core-only and native/compiler RSS attribution is unavailable;
the 60-second / Core-only 1-GiB gates and million-line qualification remain
unqualified. No resource sandboxing or new language environment was started.

The next independent optimization should examine the measured qualification and
repeated small canonical allocations, including reuse of an already required
immutable provenance/payload encoding within one operation. It needs its own
identity oracle and measurements. Global mutable-object caches and a blind
`semanticKey` rewrite are not approved. Stage 6.6, compatibility bootstrap and
broader lifetime/resource work require separate authorization.
