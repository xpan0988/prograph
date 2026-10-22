# Stage 6: complete real-source pipeline profiling

22 October 2026, Australia/Sydney. Sections 1–13 record the accepted **Stage 6.1 diagnostic milestone of the remaining Core 2.0 work**. [Section 14](#14-stage-62--rust-traversal-implementation) records the focused Stage 6.2 implementation and measurements for candidate 1. Core 2.0 remains incomplete; the general 60-second complete-analysis gate and Core-only peak RSS are not qualified.

Candidate 1 implements the focused Rust traversal/receiver-observation change. Bounded identity encoding and export residency work remain deferred. The evidence does **not** justify a storage redesign, a new provider, compiler removal, reduced semantic output, or weaker durability.

Machine-readable evidence: [profiling receipt](benchmarks/semantic-core-stage6-profiling.json). It contains phase boundaries, process samples reduced to a timeline, CPU rankings with source-map locations, allocation checkpoints, corpus file hashes, tool/binary hashes, complete output witnesses and validation. Raw 9.1 MiB CPU data and temporary indexes remain outside Git at `/private/tmp/prograph-stage6-profile-20261022`; no heap dump or raw profiler trace is committed.

## 1. Exact baseline and corpus

The initial checkout was clean on `main`, tracking `origin/main`, at **`d6bfa109229748ecc4da875713ea7e9c31aa5a9a`**. Its accepted runtime is **`f0af75338e8b3b1cb9462c354d71c901bc5aa4d2`**; the subsequent commit records acceptance. Source inspection, fresh TypeScript compilation and direct execution were used as authority. The installed `prograph context` command refused the old local index because its global query projections were stale. No navigation rebuild or unrelated analysis was performed.

The exact frozen capture used by the [accepted comparison](benchmarks/semantic-core-stage6-source-indexes.json) still exists:

| Property | Verified value |
|---|---|
| Source root, kept unchanged to preserve repository identities | `/var/folders/j5/y1jjfjyd0sj9yh7n9qjk3wyc0000gn/T/prograph-source-scale-pair-0GBZO2/source` |
| Original Pastey HEAD recorded during capture | `8714e1ee57e00b70fdf1e03d6c182a8ef984ded0` |
| All 421 captured regular files, sorted `[path,sha256]` JSON SHA-256 | `046e71411c366bd85acffc12a83cfc80590016e0223629aac9ac11f454ab6e6b` |
| Selected `[path,digest(text)]`, canonical sorted inventory | `729c1eb199f09ccd9739634699bdc004388402544fcc8806c674ba471b6365b8` |
| Selected files / UTF-8 bytes | 315 / 7,452,350 |
| Code files / UTF-8 bytes / physical lines | 261 / 6,535,832 / **173,142** |
| Languages by code file extension | 174 Rust, 6 Python, 57 `.ts`, 24 `.tsx` |
| Selected TS semantic units | `tsconfig.json`: 64; `tsconfig.node.json`: 1; inferred: 16 sources |
| Dependency link | Existing `source/node_modules` resolves to `/Users/xiyuanpan/Pastey/node_modules` |

Blank/comment lines count. A trailing LF does not add another physical line; the older raw `split` count is 173,403. All 421 hashes and selected inventories were rechecked after **each** run. This is a frozen dirty-source capture with a recorded original HEAD, not a clean checkout of that HEAD. Its dependency link is not a frozen dependency archive. Compiler input barriers ran, tool hashes are recorded, and all accepted semantic identities agree, but arbitrary future use of that symlink is not reproducible without rechecking dependencies.

Host: Apple M5, arm64, 10 logical CPUs, **16 GiB RAM**, macOS 26.5.2 / Darwin 25.5.0, local APFS volume (about 140 GiB free initially). Node **25.9.0**, V8 **14.1.146.11-node.25**, npm 11.12.1. Installed ts-morph 27.0.2 / common 0.28.1 uses bundled **TypeScript 5.9.2**; the repository's build compiler package is **5.9.3**. Tree-sitter 0.25.1, Rust grammar 0.24.0, Python grammar 0.25.0; better-sqlite3 **12.10.0**, whose actual native SQLite is **3.53.1**. Node's separate built-in SQLite version is not the writer version. Vitest 4.1.8, Vite 7.3.5. Package/lockfiles were not changed; their hashes and relevant SDK/native binaries are in the receipt.

## 2. Measurement definitions

| Measurement | Meaning and limits |
|---|---|
| `performance.now()` phase begin/end | Measured monotonic wall duration, includes children/nested work; asynchronous waits included. Parent and child phases must not be summed together. |
| `process.cpuUsage()` deltas | Measured cumulative **process-wide** user/system CPU; includes background V8 threads. May exceed one CPU-second per wall second. Not per-subsystem CPU. |
| `process.resourceUsage().maxRSS` | OS-reported process high-water RSS in **KiB**, cumulative since process start. Identifies a peak interval from boundary increases, not an object's retained size. |
| Boundary `memoryUsage()` | Instantaneous process RSS and V8 heap used/total; bytes. `external` includes tracked external allocations and ArrayBuffer backing; **ArrayBuffers are a subset**, not additive. Native add-ons need not report every allocation. |
| `getHeapStatistics()` | V8 allocator heap/physical committed pages, available heap, V8 malloc and allocated-byte counters. Committed heap is not equivalent to kernel-resident heap. V8 malloc is not SQLite/native total memory. |
| External `ps`, requested every 100 ms | Sampled root/descendant RSS and cumulative CPU display. Can miss fast transients and short-lived children. Phase alignment uses process elapsed time approximately; launch offset and sample interval limit precision. Missing phase samples are `null`, never zero RSS. |
| Inspector CPU sampling, requested 1,000 microseconds | 49,994 samples; observed mean interval about 1.66 ms. Tables weight samples by actual `timeDeltas`. These are **sampled stack-residence seconds**, not exact CPU accounting. SQLite/native leaf frames can include waits. “Self” excludes sampled descendants, not native code hidden beneath a JS frame. |
| Allocation sampling, 32 KiB interval | Estimates of sampled JS allocations not reported collected at each checkpoint. Allocation ancestry is not a dominator retained-size analysis. Includes SDK startup. Misses native trees, SQLite and many external buffers; small categories are noisy. |
| GC `PerformanceObserver` | Observed GC event count/duration/kind, delivered after synchronous execution yields. Sum of event durations is not all parallel GC CPU or all application suspension. No observer was installed in the baseline; GC there is **unavailable**, not zero. |
| SQL counts, file byte sizes, hashes | Exact post-run observations on this snapshot, outside timing in separate processes. Counts are output/storage counts unless explicitly labelled method invocations. |

No shared in-process RSS is assigned to Core, TypeScript, Tree-sitter or SQLite. In particular, **RSS minus heap used, heap committed, or compiler sampled allocations is not Core-only RSS**. macOS residency/compression, allocator arenas, mapped code, shared pages and overlapping external accounting defeat that subtraction.

## 3. Actual execution and ownership

The production path is not a simple compiler-facts-first streaming pipeline. The ordinary fresh analysis first constructs complete compatibility-shaped source observations, stages owned derivations, then runs precise TypeScript extraction and publishes everything.

1. **Admission / worker.** CLI/server indexing uses [`executeIndex`](../src/core/analysis/index-execution.ts): one active indexing slot, at most four waiting, a separate freshness slot, and a fresh Node **child process** with `--max-old-space-size=2048` (512 for status). [`index-worker`](../src/core/analysis/index-worker.ts) calls `analyzeRepository`, returns a bounded summary and exits. It is not a persistent compiler worker or a JS `Worker` thread. The measured direct-library entry matches the accepted API benchmark; worker startup, admission/IPC and process teardown are outside the API timer.
2. **Discovery / reading.** [`scanRepository`](../src/core/repository/repository.ts) resolves the root, gets advisory Git metadata in a brief subprocess, loads configuration, globs and sorts selected paths, then reads every selected source into `snapshot.fileContents`. A second metadata glob adds configuration/lock/manifests. `files`, `absoluteFiles`, `fileContents`, config and root receipts remain in `scan.snapshot`. Decoding file buffers creates source strings; read buffers become collectible. No permanent parallel encoded copy of every source is maintained.
3. **Complete syntax graph.** [`analyzeRepositoryWithLease`](../src/core/analysis/analyze.ts) holds an outer `GraphBuilder`, merges base directories and sequential language adapters, validates identities and merges complete adapter results. `builder.result()` repeatedly allocates arrays of existing object references. Most array copies are shallow; they must not be counted as new full payloads.
4. **First TypeScript compiler.** [`compilerApiAdapter.analyze` / `createProject`](../src/adapters/language/typescript/index.ts) creates a ts-morph project from scanner-selected paths, loads dependencies/libraries and resolves compiler symbols for the legacy-shaped observations. Several descendant-kind scans are performed. The result has plain graph objects and a compiler input receipt. No explicit language-service disposal occurs; compiler objects become eligible for GC after their last references, without a guaranteed reclamation boundary.
5. **Rust syntax trees.** [`rustSyntaxAdapter.analyze`](../src/adapters/language/rust/index.ts) creates one parser, parses **174** files and stores every `{source,tree,nodeMap,...}` in `parsedFiles`. It then traverses all trees for **5,973** definitions and indexes, followed by all calls. Definitions and node maps retain syntax nodes; nodes retain their trees. `walk` materializes `namedChildren`; every visited definition callback searches ancestors for impl/trait. Receiver inference repeatedly walks an enclosing function and reconstructs its earlier `let` candidates. Per-call `definitions.find` scans the complete definition list. These describe the Stage 6.1 traversal; section 14 records its replacement. Trees still survive the cross-file definition barrier. The installed Node binding has finalizer-based destruction (`Tree::~Tree`); its JS Tree API does not expose the `delete()` sometimes found in other bindings. Python extraction parses one file per loop, but also relies on GC/finalizers rather than explicit disposal.
6. **Owned base and Semantic Pass DAG.** [`deriveOwnedAnalysis`](../src/core/semantic/analysis-passes.ts) opens the first SemanticStore, computes a fingerprint over sorted **complete** source nodes/edges and file hashes, then [`writeSyntaxBase`](../src/core/semantic/owned-projection.ts) JSON-normalizes the graph, groups all output by file, fingerprints groups, writes bounded batches, seals runs and reads sealed projections back. The original outer graph and normalized base coexist. Each of twelve passes assembles a new input GraphBuilder plus node/edge claim maps from the base and ancestor projections. Pass outputs are normalized, partitioned, written, sealed and rehydrated; `completed` retains projections until the DAG ends. Boundary recipes and dependency plans are bounded whole-output collections, not streaming iterators. Derived relationships preserve their support and negative selector admission. The first store closes before `owned-analysis` ends.
7. **Additional parsing inside boundaries.** [`boundary-pass.callRanges`](../src/core/semantic/boundary-pass.ts) caches ranges per requested file, but creates a new TS SourceFile and small no-lib/no-resolve Program for TS binding qualification, or reparses Rust with Tree-sitter. `SourceCoordinates` is rebuilt per requested occurrence/registration. This is real repeated parsing, visible in CPU stacks, but the entire boundary pass is only 0.620 s here. Sharing an arbitrary existing compiler context would not automatically preserve its binding semantics.
8. **Precise common/native facts.** [`indexSemanticFoundation`](../src/core/semantic/typescript.ts) discovers project units, opens the second SemanticStore, and constructs **three more** compiler Programs (143 / 50 / 211 SourceFiles including libraries/dependencies). They cover 64 / 1 / 16 selected TS sources. `indexTypeScriptUnit` obtains a checker, enumerates a complete per-file AST-node array, performs declaration and reference/call passes, and accumulates `pending` FactInput arrays, with a 250,000-fact / 32 MiB document bound. A normalized pending-fact copy is canonicalized for ownership fingerprints before 500-fact storage batches. Symbol/scope/input maps live across the unit. Coordinate UTF-16-to-byte tables allocate typed arrays per file. Compiler input/source checks and document call-summary passes remain inside this phase.
9. **External/native providers.** [`retainProviders`](../src/core/semantic/provider-runs.ts) and [`replayProviders`](../src/core/semantic/provider-replay.ts) reuse/reexecute only qualified, locally authorized registrations. This fresh corpus has **zero retained native runs, zero registered replay results and no external semantic producer execution**. Other production paths use managed/Rust/Clang runners, captured workspaces and source/tool receipts, then SCIP/native facts and prepared runs before the same single publication. [`runProviderProcess`](../src/core/semantic/process.ts) launches a POSIX guard and compiler group with output/deadline/parent-death handling; output chunk buffers are concatenated/decoded at completion. Those SDK peaks are not exercised here. Rust syntax in this run is in-process Tree-sitter, not rust-analyzer or Cargo semantics.
10. **Atomic snapshot publication.** [`SemanticStore.publish`](../src/core/semantic/store.ts), [`publishProjections`](../src/core/semantic/publication.ts) and [`publishCompatibilityCache`](../src/core/semantic/compatibility-cache.ts) validate sealed ownership/input environments, hash run digests, insert snapshot memberships, validate support eligibility, publish navigation/symbol/call visibility and the bound report, update compatibility/query projections and advance authority/pointer in **one FULL/WAL transaction**. Winner resolution decodes payloads into `changes`. Fresh query bootstrap then rereads `cg_current`, decodes another complete `plan`, and updates scope/scalar/FTS/file/architecture/boundary projections. Both large collections coexist. The accepted reverse node-membership indexes remain in use. The second store closes after publication.
11. **Legacy SQLite, JSON and cleanup.** The complete outer `GraphBuilder`, `graph` arrays and owned result coexist with semantic extraction/publication. After authoritative commit, [`persistGraph`](../src/core/storage/sqlite.ts) independently writes `graph.sqlite`, serializes each payload, rebuilds its legacy global projections, and closes it. These nonauthoritative caches are not part of the semantic atomic commit. [`analyzeRepositoryWithLease`](../src/core/analysis/analyze.ts) then synchronously pretty-stringifies the entire graph and diagnostics as arguments to asynchronous `Promise.all` writes. Full JSON strings, newline concatenation/flattening, UTF-8 write buffers and graph objects overlap. Manifest/state are also written. Leases close on return; the direct API returns the complete graph. The ordinary worker retains that result through summary generation and releases all process state on natural exit. No persistent compiler/parser cache or process survivor was observed; process exit is the final reclamation boundary.

The sample process trees contained only the root Node process. The advisory Git child can finish between samples; zero sampled children alone would not prove no subprocess execution. The absence of external semantic execution is also established by the fresh registration catalogue, zero native outcomes and source control flow. No compiler/provider memory is hidden inside a child-RSS total for this corpus.

## 4. Bounded experimental sequence

Exactly **four** serial fresh indexes were built. There was no fifth confirmatory analysis, million-scale benchmark, full regression suite, cache eviction, forced `global.gc()`, provider installation, or competing heavy test/benchmark run. Source reads for inspection were allowed; regression/build work happened outside measurement intervals.

| Run | Complete API wall s | Process user+system CPU s | Process peak KiB | GiB | Purpose |
|---|---:|---:|---:|---:|---|
| Accepted historical indexed sample | 100.549 | historical receipt | 1,644,736 | 1.569 | Context only; same frozen input/runtime |
| Clean uninstrumented baseline | **84.784** | 73.231 | **1,787,360** | **1.705** | No diagnostic listener, inspector or process sampler |
| Light phase/resource observations | **76.095** | 69.421 | **1,911,840** | **1.823** | Boundaries, GC observer, external process sampling |
| CPU sampled | **82.831** | 72.924 | **2,035,040** | **1.941** | Same boundaries plus inspector CPU sampling |
| Allocation sampled | **91.344** | 83.941 | **1,291,600** | **1.232** | Sampling checkpoints, method counters, live writer settings |

The 84.784 s baseline is the new baseline, not a code speedup over 100.549 s. The 76.095 s phase run decomposes the **same complete pipeline**, not retrospectively measured portions of the historical 100.549 s observation. The accepted harness retained an additional pre-timer scanner snapshot and installed a publication timer; this baseline does neither. That small source-copy difference and uncontrolled caches/scheduling/GC prevent claiming identical memory conditions.

Relative elapsed differences are −10.2% light versus baseline, −2.3% CPU versus baseline, and +7.7% allocation versus baseline; CPU versus light is +8.9%, allocation versus light +20.0%. These are **observed deltas, not isolated profiler overhead estimates**. The lower allocation-run RSS is especially not a production improvement: inspector operations materially change collection/residency. Its seven timed checkpoint profile/summarization calls consumed 0.438 s directly; other profiler overhead is unisolated. No forced-GC result is offered as a fix.

The external sampler's accumulated command/collection elapsed times were 14.69 / 16.40 / 20.19 s, respectively. This is parent elapsed overhead across many short commands, not target CPU or a duration to subtract from indexing. It is a confounder even on a multi-core host. OS caches, memory compression, other desktop applications, thermal/power state and SSD flush scheduling were uncontrolled. These four samples establish neither p95 nor a cold-cache SLO.

## 5. Phase timings

Measured from the light run. CPU includes all process threads; nested rows are indented by label only. Small API preparation, state creation and boundary overhead account for the remaining approximately 19 ms outside the major rows. The publication-stage total is nested inside Semantic Foundation.

| Phase | Wall s | User+system CPU s | Output/work |
|---|---:|---:|---|
| Repository discovery/read | 0.040 | 0.048 | 315 files, 7.45 MB selected text |
| Complete syntax graph | **23.534** | **24.801** | 38,489 nodes, 72,656 edges, 46,897 diagnostics |
| ↳ First TS adapter | 1.125 | 2.040 | 3,099 nodes / 8,660 edges |
| ↳ Rust parse | **0.242** | 0.240 | 174 trees |
| ↳ Rust definition traversal | **8.400** | 8.445 | 5,973 definitions |
| ↳ Rust call traversal/resolution | **13.285** | 13.407 | Rust total: 34,558 nodes / 62,603 edges |
| ↳ Python adapter | 0.113 | 0.165 | 763 nodes / 1,325 edges |
| Owned analysis/staging | **24.110** | **17.065** | 1,018 selected owned runs |
| ↳ Whole-source graph fingerprint | 0.516 | 0.649 | Complete sorted node/edge serialization |
| ↳ Syntax fact staging/sealing/readback | **18.184** | **12.724** | 317 base/catalogue owners |
| ↳ Remaining twelve pass loops | 5.410 | 3.692 | Includes graph assembly, extraction, shard storage/support/readback |
| Semantic Foundation | **23.837** | **22.710** | 1,193 total selected runs |
| ↳ Three TS units, including staging/passes/input verification | **9.252** | **8.500** | 6.627 / 0.219 / 2.407 s; Program setup 0.160 / 0.101 / 0.207 s |
| ↳ Native retain/replay | <0.001 | <0.001 | Zero native runs |
| ↳ Final cross-unit freshness barrier | 0.283 | 0.556 | 4,653 distinct input receipts |
| ↳ Snapshot publication | **14.232** | **13.591** | Complete atomic publication |
| Legacy SQLite export and global projection rebuild | **4.072** | **4.253** | 197,582,848-byte compatibility DB |
| JSON/manifest/diagnostics/state export | **0.483** | **0.513** | 102,548,074-byte graph JSON plus other exports |
| Complete API operation | **76.095** | **69.421** | All work above; no export omitted |

Pass loop durations: React 0.214 s; Tauri 0.398; schema 0.031; documentation 0.185; package 0.036; Cargo 0.072; Tauri config 0.030; capabilities 0.035; tests 0.882; Knowledge 0.859; boundaries 0.620; dependencies 2.034. Their adapter algorithm times are often much smaller than their storage/assembly loops (e.g. test adapter 0.175 s versus 0.882 s loop).

| Publication substage | Wall s |
|---|---:|
| Content key | 0.005 |
| Membership | 0.098 |
| Support eligibility | 0.030 |
| Navigation / visibility intervals | 0.963 |
| Symbols marker | <0.001 |
| Caller/callee summary | 0.016 |
| Bound snapshot report | <0.001 |
| Compatibility and query projection | **12.339** |
| Pointer / transaction commit | **0.780** |

The syntax-staging wall/CPU gap and transaction samples justify investigating commit/write overhead. The final commit row includes native SQLite commit/checkpoint/synchronization and bookkeeping; it is not measured SSD-only time. CPU may run on background threads during waits, so wall minus process CPU is not exact I/O time. No block-device trace or syscall-by-syscall attribution was collected. On this macOS runtime, resource-usage filesystem counters are not a useful byte-level I/O witness.

## 6. Memory timeline and attribution

Light run; MiB are 2²⁰ bytes. Boundary values are instantaneous. High-water is cumulative OS process peak, converted from KiB. This table describes **process ownership overlap**, not subsystem RSS.

| Boundary, seconds from API start | RSS MiB | Heap used / total MiB | External MiB | Cumulative peak MiB | Interpretation |
|---|---:|---:|---:|---:|---|
| Discovery done, 0.044 | 170.6 | 56.3 / 66.5 | 9.5 | 170.6 | Runtime/modules + source inventory |
| First TS done, 1.170 | 460.9 | 213.6 / 339.5 | 14.3 | 466.3 | Compiler project and graph allocations have occurred |
| Rust parsed, 1.419 | 613.9 | 220.5 / 342.7 | 14.3 | 613.9 | All 174 native trees now coexist |
| Syntax graph done, 23.579 | 841.5 | 138.3 / 350.5 | 2.3 | 893.3 | Heap has fallen; RSS remains high |
| Whole graph fingerprint done, 24.100 | 1,222.8 | 481.1 / 644.9 | 2.3 | 1,222.8 | About **381 MiB RSS / 343 MiB heap** boundary growth during whole-graph encoding |
| Owned analysis done, 47.688 | 1,436.3 | 763.5 / 854.2 | 2.4 | 1,444.9 | Original graph + normalized base/projections/maps/plans/allocator residency |
| First precise TS Program ready, 47.882 | 1,483.8 | 828.2 / 901.1 | 2.4 | 1,483.8 | Compiler construction overlaps prior allocations |
| First precise TS unit done, 54.349 | 1,214.3 | 291.0 / 461.6 | 5.4 | 1,588.8 | Collection reduced heap/residency; earlier transient peak retained in high-water |
| Freshness barrier done, 57.296 | 1,246.5 | 147.9 / 303.4 | 26.1 | 1,588.8 | Small heap does not mean small RSS or small Core |
| Semantic publication done, 71.528 | 1,128.1 | 432.2 / 563.9 | 3.4 | 1,588.8 | Compatibility materialization; then native transaction completes |
| Legacy SQLite done, 75.612 | 1,160.0 | 187.2 / 345.0 | 6.3 | 1,588.8 | All DBs closed; complete graph still available for export |
| JSON done, 76.095 | 1,485.3 | 398.0 / 554.1 | **115.1** | **1,867.0** | Largest process peak occurs **during JSON export**, not at compiler completion |

The external sampler saw a lower maximum **1,718,512 KiB**, near the final export; it missed the short high-water transient. The OS high-water increased from 1,626,912 to 1,911,840 KiB within the JSON phase, an additional **278 MiB** above the previous record. End-to-end instantaneous RSS rose about **325 MiB** across that phase. Heap rose **211 MiB**, tracked external memory about **109 MiB**, including about **113 MiB ArrayBuffers at its end**. These values overlap and cannot be added as independently owned peaks. The graph's 97.8 MiB UTF-8 JSON, full pretty-string materialization/newline flattening, and asynchronous encoded write buffers explain a defensible export-residency mechanism; exact individual-string retained sizes were not measured.

Rust parse raised RSS about **153 MiB** while heap grew about 7 MiB and tracked external stayed flat. Native tree allocation is a strong explanation from code/lifetime evidence, not a measured 153 MiB native-tree subtotal. Native allocator fragmentation, compiler residue, libraries and unreported add-on allocations remain mixed. The 1,246 MiB RSS / 148 MiB heap-used barrier observation makes the same limitation clear.

## 7. Actual CPU hotspots

CPU profile: 82.862 s profile window, 82.860 s weighted sample time, 49,994 samples. Async continuations do not always retain their full causal parent stack. Recursive frames are deduplicated per sample when computing inclusive weights. Rows overlap; neither inclusive times nor the following rankings are additive budgets.

| Hot path and mapped source | Inclusive / self sampled s | Measured light-run wall context | Required or redundant work / complexity |
|---|---:|---|---|
| `sqliteTransaction`, better-sqlite3 transaction wrapper, invoked by [`batch` / `seal`](../src/core/semantic/store.ts) | **51.638 / 21.162** | 18.184 s syntax staging; 24.110 s owned analysis; 14.232 s publication | Callback-inclusive total spans several phases. “Self” is mainly native BEGIN/COMMIT/savepoint boundary residence, with CPU **and waits** unresolved. Many bounded transactions amplify FULL commit/index work; cannot remove validation or downgrade FULL. |
| Rust [`walk`](../src/adapters/language/rust/index.ts) | **21.817 / 0.719** | Rust definitions 8.400 s + calls 13.285 s | Full named-child arrays and ancestor navigation dominate; repeated per-node ancestor searches and per-call function scans add avoidable work. Native binding is the expensive descendant. |
| Tree-sitter native boundary labelled `TreeCursor` by V8 | **12.775 / 12.775** | Inside Rust traversals, not all parsing | Unsymbolized/shared native label, **not proof of 12.775 s spent constructing cursors**. Immediate sampled ancestry includes `get parent -> enclosing` (6.202 s) and `namedChildren -> walk` (3.305 s, plus 1.916 s through unmarshalling). |
| Rust [`inferredReceiverType`](../src/adapters/language/rust/index.ts) | **10.296 / 0.005** | Included in 13.285 s call phase | Walks each enclosing function for preceding lets per receiver call: roughly O(Σ calls-in-function × function-AST-size). Pure repeated observation is a strong optimization target. |
| [`writeSyntaxBase`](../src/core/semantic/owned-projection.ts) | **19.451 / 0.049** | 18.184 s staging, with call-tree sampling differences | Required immutable writes plus normalization, per-file fingerprints, readback and commit amplification. A whole source view exists in parallel. |
| [`addFact`](../src/core/semantic/store.ts) | **9.330 / 6.027** | Inside staging/TS/pass loops | Required validation, endpoint checks, canonical identities, fact/provenance/claim/support lookups and indexed inserts. 234,946 calls in allocation run; many small SQL operations per fact. |
| [`publishCompatibilityCache`](../src/core/semantic/compatibility-cache.ts) | **12.357 / 3.911** | 12.339 s compatibility stage | Required winner/support/query view; redundant fresh-bootstrap decode/materialization is separable. 165,977 winners and bootstrap payloads; indexes and per-row SQLite work dominate the remainder. |
| [`publishCompatibilityQueries`](../src/core/semantic/compatibility-global.ts) / `updateCompatibilityNodes` / scalar `counter` | 7.484 / 0.353; 4.205 / 1.957; **2.222 / 2.222** | Nested compatibility stage | Scope/counter/FTS maintenance is required. Counter calls can potentially aggregate bounded deltas; preserve prefix underflow/error/rollback semantics. Accepted reverse indexes already removed the old quadratic deletion scan. |
| [`canonical`](../src/core/semantic/model.ts) | **3.962 / 3.225** | 0.516 s whole-graph fingerprint plus many other call sites | Recursive sorted entry arrays and complete intermediate strings; repeated encoding/byte charging/fingerprinting. Complexity follows total bytes plus per-object key sorting, with expensive full-graph peak allocation. |
| [`persistGraph`](../src/core/storage/sqlite.ts) / legacy `materializeGlobalQueries` | 4.291 / 0; 1.293 / 0.586 | 4.072 s legacy export | Required compatibility contract, duplicate projection/serialization costs. Queries rebuild scope, architecture, cycles and FTS from the full graph. |
| Rust per-call `definitions.find` callback | **1.297 / 1.297** | Included in call traversal | O(calls × 5,973 definitions), replaceable by equivalent owner lookup. |

Other investigations: the union of frames under bundled `typescript.js` is **2.554 sampled s**, compared with **11.724 s inclusive `indexTypeScriptUnit`**, which also contains storage/checks/passes. Legacy TS is about 1.22 sampled s. Semantic/legacy SHA digest stacks together occupy about **1.179 sampled s**; canonical encoding is a larger target than raw SHA-256. Rust parsing is only 0.242 s. Boundary reparsing is visible but small. GC's sampled leaf weight is 0.918 s; the light run observed 567 GC events / 0.797 s event-duration sum, longest 30.94 ms. Neither repeated sorting, GraphBuilder copying nor GC is demonstrated to dominate CPU in isolation.

Allocation-run method counters, exact for that diagnostic execution: **6,719,601 `SemanticStore.sql` requests**, **3,343 `batch` calls**, **1,193 begins and seals**, **235,199 `addEntity`**, **234,946 `addFact`**, **41,438 `addOccurrence`**. `sql` requests are cached-statement retrievals, not 6.7 million prepares or disk writes. `GraphBuilder.result()` ran **35 times**, producing **3,041,049 array slots** (about 23.2 MiB of pointer payload cumulatively at eight bytes/slot, excluding overhead); this is allocation traffic, not simultaneous retained payload size. Profiler sample hits are not invocation counts.

## 8. Retention, duplication and allocation evidence

Allocation sampling began before module imports, with collected objects excluded. Seven checkpoint requests and a final stopped profile were taken without explicit forced GC. Heap inspection itself changed GC/residency, so this is separate from production peak accounting.

| Checkpoint | Estimated sampled JS MiB | Findings |
|---|---:|---|
| Rust adapter return | 129.71 | Rust call-callback ancestry 56.13 MiB inclusive; direct call/evidence allocations 20.40 MiB; `withEdgeId` 16.48 MiB self; unresolved-target construction 10.85 MiB self; diagnostic construction 4.50 MiB self. These overlap by ancestry. |
| Owned analysis return | 132.53 | Rust call ancestry still 39.89 MiB; owned projection category 10.46 MiB, including `readOwnedProjection` 5.76 MiB self; original and hydrated graph payloads survive into later phases. |
| After three TS units | 135.61 / 135.44 / 135.81 | TS/ts-morph allocation ancestry about 33.6 MiB, including compiler SDK startup and common runtime; not the compiler Program retained size. No isolated compiler RSS can be derived. |
| Publication complete | 136.50 | Sampled Rust graph/evidence allocations, hydrated projection objects, maps, canonical strings and SDK/module data remain. |
| JSON complete / returned result | 135.07 / 127.31 | Complete graph is deliberately returned. Compiler/ts-morph category remains about 33 MiB; this includes static loaded SDK allocations. Tree-sitter JS wrappers about 1.86 MiB; **native trees are outside this profile**. |

The baseline V8 allocation counter increased about **35.44 GiB** during one analysis, versus about 35.76 GiB in the light run and 36.11 GiB in allocation mode. This is cumulative V8 allocation traffic, not peak live memory, native bytes or solely graph allocation. It supports substantial short-lived encoding/traversal/copying traffic; allocation sampling does not attribute all of those dead allocations. The light run's 763 MiB end-owned heap and 148 MiB post-barrier heap show a much larger temporary population than the sampled checkpoint survivors.

Dominant lifetime mechanisms, separating source evidence from inference:

* **Source map:** measured 7.11 MiB UTF-8 selected text, held by the snapshot through owned and compiler/freshness work. Source strings are shared by reference in Rust parsed-file records; that is not another independent full source copy. Program SourceFiles can hold independently read text, and coordinates build temporary byte tables. Shorter source lifetime is useful but cannot by itself remove a 1+ GiB peak.
* **Rust ASTs and traversal:** code proves whole-corpus tree residency through definitions/calls and node-to-tree references. Transient wrapper/cache/finalizer work is CPU-heavy. Nodes/trees become eligible for collection after the adapter; sampling cannot prove exact collection time. Reparse-after-definition was already rejected as a memory fix by the [prior isolated experiment](benchmarks/semantic-core-stage6-source-exploration.json), which increased RSS; that experiment is not reused as a production result.
* **Compiler state:** one legacy compiler plus three unit Programs, checkers, SourceFiles and unit maps are constructed sequentially, without explicit disposal. Previous allocations overlap following work until collection. Some state is genuinely needed for project-wide resolution. Neither a 33 MiB sampled SDK category nor a phase RSS delta isolates Program memory. A permanent compiler leak is **not established**.
* **Original/normalized/hydrated graph populations:** `normalizeProjection` deep JSON-copies source payloads; per-file readback materializes further objects while the outer graph remains live. `completed`, base node/edge maps and each pass's input builder/claim maps overlap. At DAG return many are no longer semantically needed but can remain uncollected. No dominator snapshot was taken, so unreachable-but-uncollected and strongly retained objects are distinguished only where source ownership proves it.
* **Fingerprint materialization:** complete canonical JSON and recursively joined child strings temporarily coexist with sorted arrays and the graph. The fingerprint phase alone raises boundary heap by about 343 MiB. Hash-only callers need identity bytes, not a final giant string; storage callers still need their actual payload.
* **Compatibility bootstrap:** exact post-run work reports **166,065 classified rows / 74,523,948 decoded bytes**, **165,977 resolved keys / 74,485,681 decoded bytes**, then **165,977 bootstrap payloads**. Winner `changes` and the freshly decoded query `plan` overlap. Counts and byte charges are not retained-heap sizes, but prove repeated whole-output materialization. Fact value text totals include 35,572,935 bytes of syntax relations, 20,089,221 of syntax nodes and 13,029,581 of syntax diagnostics; the problem is much larger than the 7.45 MB source map.
* **JSON export:** a 102,548,074-byte pretty graph, a separate diagnostics export, complete graph objects and encoded asynchronous-write buffers overlap. The measured peak interval, heap/external increases and source evaluation order make this the clearest final peak-residency target. Returned graph objects remain required by the direct API; removing that contract is not assumed.
* **Native/SQLite:** two sequential semantic connections close before the following outer phase. Statement caches are per-store; entity caches cap at 4,096 entries. Their closed JS wrapper objects/maps are not explicitly cleared by `close`, although the native DB is closed. Exact retained statement/native allocator memory was not measured. Observed live writer settings were **WAL, synchronous=2/FULL, cache_size=-16000, mmap_size=0, page_size=4096** on both semantic connections. The cache setting is a configured KiB budget, not measured resident cache. Increasing it is not recommended from these data.

## 9. Compiler, native memory and waits: remaining limits

External semantic producer memory is **not exercised** on this corpus. The sampler can account for observed child RSS/lifetime on another explicitly configured run, but this milestone does not qualify rust-analyzer, Clang, Python, Go, JVM or .NET peak usage. Summed process RSS would also double-count shared pages and would not be proportional/private memory. Supervisor/Python/`ps` overhead is separate from the root ProGraph process, not a semantic provider.

Bundled TS and Tree-sitter run inside the same PID as Core. No native allocator tracing, malloc stack logging, VM-region/private-footprint attribution, heap dominator snapshot, SQLite `db_status`/`sqlite3_memory_used` instrumentation or kernel I/O trace was collected. better-sqlite3 does not expose the necessary native allocation breakdown through the API used here. Reopened connection PRAGMAs cannot establish the historical writer's resident cache or synchronization mode. In particular, its read-only connection defaults to `synchronous=1`; actual live semantic writers were separately observed at **2**. No durability setting was changed.

The evidence identifies peak intervals, required retained graph categories and avoidable overlapping representations. It does **not** partition the original 1.57 GiB or new 1.70 GiB process peak into defensible additive Core/compiler/SQLite/native subtotals. Core-only <=1 GiB is therefore **unmeasured**, not accepted or silently failed by substituting combined RSS.

## 10. Ranked implementation candidates

These are proposals, not changes made by this milestone. Estimates are hypotheses for this corpus/host and have wide uncertainty. Shared hotspots overlap; benefits must not be summed mechanically.

### 1. Remove repeated Rust traversal observations

**Evidence/root cause:** 21.817 sampled inclusive seconds in `walk`, 10.296 under receiver inference, 7.759 under ancestor `enclosing`, 1.297 in the definition linear-search callback; parse itself only 0.242 s. Sources: `rust/index.ts` `walk`, `enclosing`, `inferredReceiverType`, definition/call loops.

**Proposal/mechanism:** preserve visit/output order while traversing only needed syntax categories with reusable cursor state and carrying owner/impl/trait context; index definitions by owner ID; build per-function receiver/earlier-let observations once, preserving call position, lexical scope and shadowing. Keep the existing cross-file definition barrier. Do not reparse every file as a purported memory fix.

**Expected impact:** roughly **5–10 s less CPU/wall** if half of repeated native navigation/function scanning is eliminated; lower wrapper/native allocation traffic, but **peak RSS saving unknown** and final JSON peak may be unchanged. Difficulty: moderate. **Risks:** inferred receiver choice, binding ambiguity, confidence, macro/recovery traversal, source order/anchors and scoped imports. Pass ownership/snapshot rules should not change; graph output compatibility must remain exact.

**Independent verification:** complete ordered Rust node/edge/diagnostic comparisons on the pinned corpus and multiple real corpora; randomized syntax/recovery/import/shadowing/Unicode fixtures against the accepted extractor; full semantic/compatibility hashes; then one isolated complete production comparison and allocation/native timeline. Prior cursor prototype evidence is a lead, not approval to copy it without registered tests.

### 2. Stream canonical identity bytes at hash-only call sites

**Evidence/root cause:** fingerprint heap growth about 343 MiB, 3.962 sampled seconds under `canonical`, about 1.179 in digest stacks, and many normalize/charge/hash passes over identical immutable payloads. Sources: `model.ts`, `analysis-passes.ts` fingerprint, `owned-projection.ts`, `projection-shards.ts`, TS document fingerprint.

**Proposal/mechanism:** add a bounded canonical-byte encoder feeding SHA-256 directly for `digest(canonical(...))` callers; retain ordinary canonical strings where storage/query payloads require them. Reuse an already encoded immutable payload locally where its exact bytes are currently recomputed. Avoid whole-graph joined strings, recursive duplicate strings and duplicated fact/provenance copies. Do not cache by mutable object identity or skip collision checks/validation.

**Expected impact:** **1–3 s CPU**, perhaps **200–400 MiB less transient heap/RSS** in fingerprint intervals; may leave the final export peak unchanged. Difficulty: moderate. **Risks:** persistent IDs are byte contracts: property ordering, sparse arrays, unsupported values, escaping, negative zero, surrogate/UTF-8 chunk boundaries and versioned context inputs. Any hash difference can invalidate ownership/history/recovery compatibility; zero differences are required.

**Independent verification:** seeded and adversarial byte/hash oracle against unchanged `canonical`/`digest`, including the previous 1,500-case lead and unsupported/sparse behavior; fixture IDs, all claim/occurrence/support/snapshot keys, historical queries and fresh/reused-output equality. Compare allocation peaks without forced GC; measure complete exports unchanged.

### 3. Reduce staging transaction amplification with bounded atomic cohorts

**Evidence/root cause:** 3,343 batch calls and 1,193 seals, 21.162 sampled self seconds at transaction boundaries, and staging wall 18.184 s versus 12.724 process CPU seconds. This suggests commit/synchronization plus per-row SQLite cost; exact fsync share is unresolved. Sources: `SemanticStore.batch`, `seal`, `writeSyntaxBase`, sharded writers and TS staging.

**Proposal/mechanism:** only after checking exact transaction/flush behavior on a small controlled fixture, consider bounded outer staging transactions/cohorts with required inner validation/savepoint semantics. Retain fact quotas and bounded cancellation. Keep sealed digest generation and successful staging durability explicit; keep atomic snapshot publication separate and unchanged. Prepared statement/index call reduction may be evaluated within the same bounded batch.

**Expected impact:** potentially **3–10 s wall**, with a smaller/uncertain CPU reduction; memory neutral or higher unless cohort bytes are capped. Difficulty: high relative to the preceding candidates. **Risks:** larger failure rollback scope, staging/seal durability, disk-full handling, source changes during staging, retained run reuse, cancellation latency and writer lock duration. Semantic/support/provenance checks cannot be coalesced away. No `synchronous` downgrade or index removal is proposed.

**Independent verification:** fault injection at every cohort/batch/seal boundary, all four process crash probes, old snapshot reads, failed-fact rollback, source/negative-input edits, bounded cancellation and full fresh/reuse oracle. Separately count actual commits and measure process CPU versus native wait time before claiming this estimate.

### 4. Bound compatibility bootstrap and release pass intermediate views

**Evidence/root cause:** 165,977 winner changes and another complete decoded bootstrap plan; about 74.5 MB of decoded payload per traversal; 12.339 s compatibility publication. Original graph, normalized source base, pass maps and sealed readbacks coexist. Sources: `compatibility-cache.ts`, `compatibility-global.ts::publishCompatibilityQueries`, `analysis-passes.ts`, `owned-projection.ts`, `GraphBuilder.result`.

**Proposal/mechanism:** process fresh bootstrap from an ordered bounded iterator or verified reusable changes, with all nodes available before edges and required architecture phases; retain only the support/winner state each phase needs. Reuse readonly base views and release predecessor projections once their final DAG consumer completes. Preserve public direct-library GraphData results; avoid an architectural storage rewrite.

**Expected impact:** **1–4 s CPU/wall**, perhaps **50–200 MiB reduced simultaneous JS residency**, with substantial uncertainty. Difficulty: moderate/high. **Risks:** bootstrap versus replacement/reset differences, node priority/winners, counters, query ordering, negative dependencies, support eligibility and historical compatibility views. Immutable source and sealed outputs must stay immutable. Iteration must remain inside the publication transaction; no partial authority/query snapshot can escape.

**Independent verification:** existing complete compatibility/global oracle across scopes, fresh/replacement/reset/alternate-support/remove-owner cases, actual reverse-index plans, counter prefix underflow and rollback tests, historical snapshot exports, all eight pinned hashes and bounded work quotas. Independent peak measurements must show a smaller live overlap, not merely a lower sampled end heap.

### 5. Stream the existing pretty compatibility export

**Evidence/root cause:** new process high-water inside a 0.483 s export; 97.8 MiB graph file, about 211 MiB boundary heap and 109 MiB external growth. Source: final `JSON.stringify`/`Promise.all` in `analyze.ts`, plus explicit historical `compatibility-export.ts`.

**Proposal/mechanism:** write byte-identical pretty JSON in bounded chunks with backpressure; bound diagnostics serialization too. Keep all fields/order/newline and failure semantics. Retain direct API GraphData and the authoritative snapshot independently. A generation/temp-file strategy needs its own permission/symlink/old-file/error contract; the prior prototype did not qualify those details.

**Expected impact:** **0–0.3 s CPU saving** (streaming may be slower), plausibly **200–400 MiB less transient export RSS**. Difficulty: moderate. **Risks:** JSON escaping/order and unsupported values, file permissions, symlinks, stale temporary files, write failure, partial export reporting and crash recovery. Complete output is required; no omitted legacy cache or delayed work outside the timer.

**Independent verification:** byte-for-byte small/extreme Unicode/nested/sparse/error fixtures against `JSON.stringify(...,null,2)+'\n'`; real graph byte/payload equality excluding only existing volatile metadata; injected midstream errors, old-target preservation where promised, symlink/permission/stale-temp tests, historical rollback export tests, and one matched complete timing/RSS comparison.

### 6. Shorten source/compiler lifetimes after proven last use

**Evidence/root cause:** scanner map spans nearly the entire analysis, compiler work overlaps unreclaimed owned graph allocations, and Programs/trace maps have no explicit disposal boundary. Sources: `analyze.ts`, TS legacy adapter, `semantic/typescript.ts`, `typescript-inputs.ts`, `coordinates.ts`.

**Proposal/mechanism:** separate lifetime scopes, retain only required source/input receipts after the final freshness barrier, avoid keeping per-file AST-node/pending arrays beyond their last use, and investigate the actual ts-morph language-service disposal contract after each unit. Share source text/coordinate observations only within identical source digest and compiler context. Do not remove project-wide resolution or freshness checks and do not share ASTs across incompatible TS contexts.

**Expected impact:** source map alone saves only about **7 MiB encoded text** plus representation overhead; compiler/transient state could save **tens to hundreds of MiB**, presently unquantified. CPU neutral or slightly worse if disposal forces rebuilding; some repeated parsing is required by different contexts. Difficulty: moderate. **Risks:** late compiler lazy reads, source anchors, external/default-library receipts, TS context/provenance, mutation during later units and incremental reuse. This is not an established leak fix.

**Independent verification:** compiler input/negative-search/source-reuse/incremental oracles, multi-project context tests, concurrent mutation barriers, all full payload hashes, and allocation/native lifetime observation without forced-GC acceptance. Isolate disposal from cache or traversal changes.

## 11. Recommended order and achievable improvement

The diagnostic recommendation was to implement candidate **1 first**, as a single Rust extractor change with an unchanged-output oracle; section 14 records that bounded implementation. It attacks measured repeated work and avoids publication/identity/storage changes. Next address candidate **2** and candidate **5** in separate reviewable changes to attack the two identified allocation peaks. Then evaluate bounded compatibility/pass residency (**4**). Transaction cohorts (**3**) require a smaller commit/wait experiment and the strongest recovery validation before a production change. Source/compiler lifetime work (**6**) follows actual reachability/API evidence; simply calling disposal or clearing a map is not evidence of a solved peak.

These are pre-implementation planning ranges, superseded for candidate 1 by section 14, and must not be added to its measured result. For the first traversal + identity + streaming-export changes, a **rough 8–18 s complete-wall improvement** and **200–500 MiB lower combined process peak** are plausible planning ranges, with low confidence and non-additive mechanisms. Applied to the new 84.8 s sample, that still suggests roughly **67–77 s**, not a demonstrated 60 s result. Different GC/native/export peaks may become dominant after each change. The stricter Core-only 1 GiB question cannot be answered by this arithmetic. Batching/compatibility work might close more of the time gap, but its benefit and durability cost need independent measurement. No gate, language semantics or acceptance threshold is revised.

The prior [exploration receipt](benchmarks/semantic-core-stage6-source-exploration.json) remains unintegrated. It combined changes and overlapped tests. Its 79–88 s samples, disposal/cache changes and lower RSS are not independent performance evidence for this plan. In particular, reparse increased native Rust peak; bounded canonical hashing/cursor/JSON/counter prototypes require production-quality tests and separate qualification.

## 12. Reproduction and diagnostic support

New opt-in support is limited to [`analysis/diagnostics.ts`](../src/core/analysis/diagnostics.ts) and numeric phase calls at the existing boundaries. A process-local consumer must explicitly call `installAnalysisDiagnostics`. With no consumer, phase entry returns a shared no-op and no resource sampler, GC observer, inspector session, child sampler or file writer is started. Observer exceptions and reentrant observations are isolated from indexing. Events contain names/timestamps/numeric counts, not source/AST/graph references. The profiling driver separately installs process-local method counters/SQLite probes only for diagnostic runs; no such patches execute in the production CLI.

Profiling changes scheduling, GC timing, adapter/manifest duration fields and volatile repository-node timing metadata when enabled. Raw instrumentation costs are included in diagnostic timing. It does not change fact selection, hashing, provenance, ownership, support, input barriers, snapshot/authority transactions or exports. Every run's full accepted hashes agree.

For another controlled reproduction, preserve this baseline checkout/runtime and exact corpus root or explicitly treat relocation as different repository identity. Verify every regular-file hash in `corpus.files`, the selected inventory, link target, toolchain/binary digests and unchanged source/config first. Store outputs on a local volume outside the corpus and refuse existing output directories. Build once, then run the following **serially**, with fresh `WORK` and no tests/builds/providers in parallel:

```sh
npm run build:node
# SOURCE is the verified original frozen source path above.
# WORK is a new external directory. Baseline is always first.
node --max-old-space-size=2048 scripts/semantic-profile.mjs baseline "$SOURCE" "$WORK/baseline-index" "$WORK/baseline.json"
node scripts/semantic-profile-verify.mjs "$SOURCE" "$WORK/baseline-index" "$WORK/baseline-witness.json"

python3 scripts/semantic-profile-process.py "$WORK/phases-processes.json" -- node --max-old-space-size=2048 scripts/semantic-profile.mjs phases "$SOURCE" "$WORK/phases-index" "$WORK/phases.json"
node scripts/semantic-profile-verify.mjs "$SOURCE" "$WORK/phases-index" "$WORK/phases-witness.json"

python3 scripts/semantic-profile-process.py "$WORK/cpu-processes.json" -- node --max-old-space-size=2048 scripts/semantic-profile.mjs cpu "$SOURCE" "$WORK/cpu-index" "$WORK/cpu.json"
node scripts/semantic-profile-verify.mjs "$SOURCE" "$WORK/cpu-index" "$WORK/cpu-witness.json"

python3 scripts/semantic-profile-process.py "$WORK/memory-processes.json" -- node --max-old-space-size=2048 scripts/semantic-profile.mjs memory "$SOURCE" "$WORK/memory-index" "$WORK/memory.json"
node scripts/semantic-profile-verify.mjs "$SOURCE" "$WORK/memory-index" "$WORK/memory-witness.json"
```

The `ps` sampler requires OS process-list permission; a sandboxed refusal is not a zero-child measurement. It retains only the launched process tree and executable names, not other applications' arguments/environment. After the four runs, its error handling was hardened to preflight permission before launch and terminate its own job on sampling failure; the successful sampling loop is unchanged. The real-source verification helper is pinned to this accepted corpus/witness and intentionally refuses changed inputs or semantic hashes.

[`semantic-profile-summary.mjs`](../scripts/semantic-profile-summary.mjs) reduces the four run/witness/process files and CPU trace. Its supporting `corpus.json`, `toolchain.json`, `storage-shape.json`, `implementation.json` and `validation.json` are inventories copied into the committed receipt, outside the measurement timer; they must be regenerated/verified for another host. `corpus.hash` is SHA-256 of sorted `[relativePath,sha256(rawBytes)]` entries using `JSON.stringify`, matching the accepted capture. `storage-shape` uses counts and summed UTF-8 SQLite payload bytes grouped by predicate/entity kind, plus `cg_meta`/`cq_meta` work reports. Toolchain hashes cover the actual installed package metadata, SDK bundles and loaded native binaries; record bundled `ts.version` and actual `SELECT sqlite_version()` separately. The receipt records raw summary/CPU SHA-256 and diagnostic source hashes; final script hashes identify the delivered tools, including the post-run sampler error-path hardening. The summarizer is a receipt reducer, not another benchmark. No raw data needs to enter Git.

## 13. Correctness, validation and unresolved observations

Each of four indexes matched all accepted witnesses exactly: **234,946 visible claims**, **41,438 occurrences**, **3,757 caller/callee pairs**, **197,892 scope rows**, **393 boundary memberships**, **78,396 legacy edges**, **46,940 diagnostics** and **40,640 non-repository nodes**. The existing hash witness conservatively omits the repository node. The additional Stage 6.2 complete-file comparison below includes it; measured run timing lives in the manifest, so no graph field needs exclusion for that comparison. Complete normalized JSON node/edge/diagnostic hashes also agree across all four runs; normalized legacy SQLite nodes/edges/diagnostics agree with the authoritative compatibility tables. No facts were discarded for speed. All semantic DBs have **908,472,320 bytes**, pass full integrity and foreign-key checks, and use WAL. Live semantic writers use FULL.

Two **post-run harness assertions**, not measured analysis failures, were corrected without rerunning any benchmark: JSON strings inside SQLite rows needed structural normalization because the owned cache canonically orders object keys; and reopened read-connection `synchronous` could not be used to assert writer durability. The eight accepted hashes already matched before those failures. The corrected witnesses were run in separate processes; writer settings were observed on the final planned run. Neither issue required changing production correctness behavior.

Tests actually executed:

* `npm run build:node`, followed by **3/3** `analysis-diagnostics.test.ts` tests: disabled/detached observation, duplicate/reentrant/failing observer behavior, and enabled-versus-disabled complete fixture semantic/compatibility equality.
* `npm run typecheck`: Node and UI checks passed.
* Serial `vitest --maxWorkers=1` over `authority-support`, `compatibility-global`, `compatibility-export`, `semantic-incremental`: **8/8**, four files, zero skips (14.89 s). Covers effective support/negative selectors, reverse index plans and scalar/global compatibility, historical/durable exports and independent compiler/pass rebuild equality.
* `npm run build`: complete clean Node/UI production build passed.
* `scripts/semantic-recovery.mjs`: all **four** actual process crash points passed; old snapshot retained; corruption refused without modifying the corrupt file.
* All four real-source post-run full-hash/integrity/export witnesses and the actual raw-profile reducer completed successfully. No new complete 271-test run or CI matrix is claimed; 271 passing is the accepted baseline record.
* Diagnostic scripts passed Node syntax checks and Python AST parsing. A disposable 400 ms process exercised the final sampler; a simulated denied `ps` preflight refused before starting its job.

There is no newly identified blocking semantic correctness defect. Remaining uncertainty includes exact native/compiler/Core RSS separation, native tree/finalizer retained size, SQLite cache/statement/allocator memory and fsync/wait costs, individual allocation-retainer dominators, external SDK process peaks, profiler perturbation, and cache/thermal/tail behavior. Linux/Windows and real 1M-source qualification were not performed. These gaps limit predictions; they do not justify weakening semantic identity/anchors, provenance/confidence/coverage, ownership/support/negative dependencies, source barriers, atomic snapshots, historical reads, recovery, bounded Agent queries or complete legacy exports.

This milestone stops with diagnostics and this implementation plan. No optimization milestone has begun.

## 14. Stage 6.2 — Rust traversal implementation

22 October 2026. This implements **candidate 1 only**, against clean `main` / `origin/main` at **`8ed2d3202900f827f3184ecc3f301aeeaeb6ec7d`**. The preceding sections retain the accepted Stage 6.1 observations and hypotheses. [Stage 6.2 evidence](benchmarks/semantic-core-stage6-rust-traversal.json) records source/dependency hashes, complete witnesses, both focused profiles and resource measurements. Implementation **`c4569685f2027e4cbf9c2b28e47121e42daf8bf9` is accepted** by the complete local checks and the actual Node 20/22/24 CI matrix recorded below. Baseline CI run [39689557793](https://github.com/xpan0988/prograph/actions/runs/39689557793) was still executing its Node 20/22/24 tests when the checkout was verified; its presence was not treated as a passing result.

### Implemented change and complexity

Only [`rust/index.ts`](../src/adapters/language/rust/index.ts) changes production behavior:

* `walk` uses one TreeCursor and a depth-indexed context stack. It visits the same named-node preorder as recursive `namedChildren`, including recovery nodes, skipping the same anonymous subtrees. A lazy `currentNode` wrapper is requested only by selected callbacks. Definition kind classification is constant rather than recreated for every visited node.
* The definition pass carries nearest impl, trait, function, module path and graph owner. Descendant contexts do not mutate sibling contexts. The call pass carries nearest owner/function/module; node ownership is keyed by native node ID **within one parsed file/tree**. All files' definitions still exist before any call resolution.
* `definitionsById` supplies expected constant-time owner lookup; first insertion wins, matching the old `definitions.find` even for duplicate recovery identities. Existing candidate arrays and their order are unchanged.
* `inferredReceiverType` builds **raw**, function-local parameter/let observations once per parsed file/function. Per-name binding lists keep declaration preorder and source positions. Binary search selects the last inferable earlier declaration; a reverse-preorder fallback preserves behavior if recovery ever yields nonmonotone positions. Raw type text is resolved with each call's existing module/import/owner context. Nothing survives the analysis invocation or crosses revisions.

Let `N` be named AST nodes, `h` enclosing depth, `C` calls, `D` definitions, `S(f)` a function subtree, and `B(name)` its matching inferable bindings. Previously the definition walk did `O(N*h)` ancestor work, calls used up to `O(C*D)` definition comparisons plus ancestor walks, and receiver queries repeatedly did `O(S(f))` traversal/materialization per applicable call. Now the two whole-tree walks are `O(N)` cursor/context visits, owner lookup is expected `O(1)`, and receiver observation is `O(sum S(f))` over **distinct queried functions**, then expected map lookup plus `O(log B(name))` selection. Nested function subtrees can still overlap; this is not a claim of globally linear receiver work on arbitrarily nested syntax. Import filtering/candidate resolution, hashing, graph creation and field-specific syntax operations remain unchanged.

Additional resident state is `O(D + observed parameters/bindings + traversal depth)`, including 3,754 observed functions and 2,191 inferable local bindings on this corpus. Parameter entries were not separately counted. This does not introduce a Rust resolver. The accepted heuristic gives parameters precedence over later lets, ignores assignments and uninferrable shadowing lets, and observes nested blocks/functions in its enclosing-function subtree. Tests preserve those limitations exactly; no inferred relationship is promoted or semantically corrected. Function-scoped import ownership and call-specific type resolution remain intact.

The existing opt-in phase end events now include numeric visit/lookup/cache counters. They retain no source/AST references and do not alter graph metadata, adapter version, provider provenance or serialization. Counters increment during the traversal even without an observer; their small cost is included in the production run. The only new helper, [`rust-traversal-benchmark.mjs`](../scripts/rust-traversal-benchmark.mjs), runs explicitly and never executes in the CLI.

### Exact equivalence

[`tests/oracles/rust-stage6-1.ts`](../tests/oracles/rust-stage6-1.ts) is the **original extractor from `8ed2d32`**, with import locations adjusted for tests. A test pins the entire implementation body SHA-256 to `3dff3c0c665e7909d3a9c0dd25654724c079b8d5fbd4356da9ba0cdc3f1c3030`; it does not share the optimized traversal/cache helpers. The nine new tests compare complete results with deep equality **and exact `JSON.stringify` equality**, without sorting, omissions or normalization. They cover the two existing Rust fixture corpora, same names across modules/files, nested functions/blocks, shadowing/reassignment/earlier-later declarations, self/Self/explicit types, impl/trait/static/instance ambiguity, scoped imports/aliases, Unicode, macros and malformed/incomplete syntax. Two hundred seeded mutation/truncation cases (`0x6a12b`) add independent recovery shapes. Explicit assertions retain the old confidence and binding behavior, rather than relying only on matching counts.

For all 174 frozen real Rust files, before/after **complete ordered adapter JSON** is byte-identical (`cmp`): **61,299,471 bytes**, SHA-256 **`a26d9d32455a6f1922087a86a130a555a8c64e002eefa6c87de736d40bc0f4e8`**. It contains 34,558 nodes, 62,603 edges and 45,191 diagnostics, including all IDs, qualified names, ranges/anchors, evidence/provenance, confidence, resolution methods, unresolved targets, candidate ordering, ownership, imports, macro metadata and adapter metadata. No adapter result field is volatile or excluded.

The complete fresh production result also matches **all eight accepted semantic/compatibility hashes** and the three full ordered JSON node/edge/diagnostic hashes from Stage 6.1. The existing whole-analysis witness conservatively excludes the repository node; it retains every other node and all ordered edges/diagnostics. An additional complete-file comparison against the saved Stage 6.1 baseline proves **byte equality of all 102,548,074 graph-export bytes**, including the repository node, with **no fields excluded**: SHA-256 `0183e8f4f580a5d567f21160b8285568de60307a536c415fe6c0ced30001d28a`. All 15,529,775 standalone diagnostic bytes also agree (`631fa69e6fdd6f49b339303a9b454228e05a9f79fb362d9a5a7e6b86bf6503ce`). This corrects the earlier report's explanation that the repository graph node needed omission for run timing: `analyze.ts` copies adapter metadata into that node, while run durations are separate. The complete manifest and state compare with exact ordered structural equality after excluding only `/generatedAt`, and for the manifest `/analysisDuration`, `/semanticCore/durationMs`, `/adapterRuns/*/durationMs`. Those fields are directly constructed from the run clock/elapsed timers. No identity, source/config hash, count or semantic metadata is omitted. SQLite JSON payload key order is structurally normalized only as already justified in section 13. This normalization is **not** used for the Rust extractor comparison. Full integrity/FK checks pass; legacy SQLite and authoritative compatibility payloads agree. Counts remain 234,946 claims, 41,438 occurrences, 3,757 caller/callee pairs, 40,641 total nodes, 78,396 edges and 46,940 diagnostics. `semantic.sqlite` remains 908,472,320 bytes. Post-run source status is **fresh**, all 315 files agree, with 4,644 recorded semantic inputs checked. No semantic, snapshot, provenance, support or compatibility change was found.

### Controlled measurements

Exactly **one** fresh-process Rust before/after pair and **one** fresh complete production analysis were executed, serially without competing heavy local tests or benchmarks. No confirmatory run was used. The exact same frozen source root, all 421 raw hashes, selected inventory and every Stage 6.1 compiler/native dependency fingerprint were verified before measurement; the source inventories were rechecked afterward. This remains the dirty Pastey capture documented in section 1, not a clean original-HEAD checkout. Host/runtime are unchanged: Apple M5 / Mac17,3, ten logical CPUs, 16 GiB, macOS 26.5.2 / Darwin 25.5.0, Node 25.9.0, V8 14.1.146.11-node.25, `--max-old-space-size=2048`.

Both focused runs use the **same harness**, installing the existing numeric phase observer and 1 ms inspector CPU sampling. Module imports and repository scanning precede the adapter timer. Complete serialization/hashing/profile writes follow it and are excluded from adapter RSS high-water readings. Those output writes are equally complete on both sides. Sampling overhead is not independently measured. Wall/CPU values below are measured; CPU is process-wide user+system, including background V8 threads.

| Focused interval | Before wall s | After wall s | Before process CPU s | After process CPU s |
|---|---:|---:|---:|---:|
| Parse 174 Rust trees | 0.241 | 0.234 | 0.238 | 0.236 |
| Definition traversal/indexing | 8.298 | 0.434 | 8.402 | 0.480 |
| Calls, receiver observations, graph work | 12.587 | 1.140 | 12.976 | 1.273 |
| Complete Rust adapter | **21.133** | **1.815** | **21.626** | **1.999** |

Observed adapter reduction is **19.318 s wall / 19.627 s process CPU**, about **91%** in this single directional pair. This exceeds the original 5–10 s hypothesis; it is not a repeated-trial distribution. Parse time is effectively unchanged. There is no isolated wall timer for receiver inference; it is nested in the call phase and its contribution is identified by sampling.

| Focused sampled stack | Before inclusive s | After inclusive s | Before self s | After self s |
|---|---:|---:|---:|---:|
| Adapter `walk` | 20.448 | 1.496 | 0.538 | 0.309 |
| `inferredReceiverType` | 9.557 | 0.355 | 0.002 | 0.007 |
| `enclosing` | 7.457 | removed | 0.198 | removed |
| `enclosingOwner` | 0.403 | removed | 0.009 | removed |
| Native/binding `TreeCursor` leaf label | 11.684 | 0.998 | 11.684 | 0.998 |

Inclusive costs overlap and **must not be summed**. Samples are weighted by actual `timeDeltas`, with identical recursive frames counted once per stack. Before: 16,927 samples over 21.144 s; after: 1,517 over 1.826 s. The TreeCursor label includes native binding work rather than an independently attributed C++ function. Before, `namedChildren` is 9.815 s inclusive, node unmarshalling 3.404 s inclusive, and the compiled per-call `definitions.find` predicate accounts for 1.139 s sampled self. After, `namedChildren` no longer dominates the profile. The full source locations and top self rows are recorded in the receipt. Native stack samples are not separately measured SQLite I/O; this focused adapter does not write SQLite or run external compilers.

Exact counters after optimization: each major walk visits **743,342** named nodes; lazy cursor wrapper requests are **15,837** in definitions and **62,603** in calls. These are **not total wrapper allocations**: child/field APIs still produce wrappers. There are **56,630** indexed owner lookups and **32,724** receiver lookups, but only **3,754** receiver observation builds, visiting **622,115** function-subtree nodes in total and recording **2,191** inferable local declarations. Before-side invocation totals were not instrumented retrospectively; they must not be inferred from sample counts.

### Residency and whole-production result

| Focused process observation | Before MiB | After MiB |
|---|---:|---:|
| RSS after parse | 232.7 | 232.6 |
| RSS after definitions | 501.8 | 279.0 |
| RSS after calls | 583.1 | 522.5 |
| OS process peak through adapter return | 584.3 | 523.7 |
| V8 heap used after adapter return | 151.4 | 134.8 |

The peak difference is **62,080 KiB (60.6 MiB)** in this pair. It is consistent with fewer transient wrappers/arrays; it does **not** establish individual cache sizes or native tree savings. All 174 ASTs remain across the definition barrier; no extra parse or early disposal was introduced. AST/native memory is not separately measurable with these Node bindings. The caches' added tables were observed by exact logical counts, not a retained-size snapshot; process RSS and end heap cannot defensibly allocate bytes to those tables, Core, Tree-sitter or TypeScript. No forced GC or extra memory-profile run was used.

The sole complete fresh production analysis, with diagnostics/inspector **disabled**, took **59.704 s**, process CPU **49.799 s**, OS process peak **1,322,128 KiB (1.261 GiB)**. Its normal manifest reports Rust **1.735 s** and semantic foundation **24.699 s**. Final process RSS is 1,200,635,904 bytes; V8 heap used/committed is 415,991,472 / 576,258,048 bytes; tracked external is 120,648,182 bytes, including 118,282,979 ArrayBuffer bytes. These are instantaneous end measurements, not the peak's attribution. No phase timeline or native child sampler is installed in this production sample. As before, this corpus executes no registered external semantic producer; bundled TypeScript/native SQLite/Tree-sitter share the Node process.

The Stage 6.1 **84.784 s / 1,787,360 KiB** result supplies context. It uses the same source/dependencies, host, API harness and flags, but was measured earlier; the whole difference is **not** attributed to this change. OS caches, SQLite waits, background scheduling and GC/allocator timing are uncontrolled. In particular, the new Rust pair establishes redundant CPU removal; it does not explain every second or byte of the complete result. A single sample 0.296 s below 60 s is **not acceptance of the general time gate**. Core-only 1 GiB remains unqualified. Full graph/source residency, canonical allocations and final JSON buffers still exist; no other optimization candidate is implemented.

### Validation and reproduction

Local acceptance passed with Node 25.9.0. `npm run typecheck` checks both Node and UI sources. The full suite ran **once**, with `npm test -- --maxWorkers=1 --reporter=default --reporter=json --outputFile=...`: **283/283 tests, 36/36 files, zero failed or pending**, 2,517.18 s reported by Vitest. All nine new Rust tests passed (0.607 s, including the 200 seeded cases). Before measurement, the first seven focused cases had also passed; the two existing-fixture comparisons were added before the full run. Actual Rust/Python/Go/Java/C# producers, all six registered provider replay paths, all 18 independent multi-provider rebuild checks, source/input freshness, all prior-writer upgrades, snapshot/ownership/support, compatibility and retained historical exports executed successfully. Then `npm run build` completed Node/UI output, `semantic-recovery.mjs` passed all four points (`before-seal`, `before-publish`, `during-publish`, `after-publish`) with integrity and retained baselines, and corruption was refused without modification. Finally `verify-ci-evidence.mjs` verified the executed evidence. Raw report hashes, tool profiles and upgrade/recovery observations are in the receipt. The implementation CI matrix passed on **`c4569685f2027e4cbf9c2b28e47121e42daf8bf9`**, normal fast-forward push on `main`, first attempt: [run 39692694809](https://github.com/xpan0988/prograph/actions/runs/39692694809). Actual job logs confirm checkout of this SHA, all nine Rust traversal tests, **283/283 tests across 36 files with zero pending**, complete Node/UI build, all four recovery probes, corruption refusal and the strict executed-evidence verifier in **every job**. Lint and all pinned-provider installation steps also passed. These are actual results, not dispatch/status-only assertions.

| CI runtime | Job ID | Result | Oracle seed |
|---|---:|---|---|
| Node 20.20.2 | 119542486214 | 283 passing; build/recovery/verifier passed | 20 |
| Node 22.23.3 | 119542486135 | 283 passing; build/recovery/verifier passed | 22 |
| Node 24.21.0 | 119542485952 | 283 passing; build/recovery/verifier passed | 24 |

The receipt records job steps/log evidence, immutable artifact IDs and archive digests. Baseline [run 39689557793](https://github.com/xpan0988/prograph/actions/runs/39689557793), initially pending before changes, also finished green on all three runtimes. The final acceptance commit changes only this report, the compact receipt and the Step 2 record; its `src`, `tests`, `scripts`, workflow and build-input trees are unchanged from the tested implementation. Their Git object IDs are recorded. No separate matrix result is claimed for the documentation-only acceptance commit.

Use a new external `WORK`, refuse reused index directories, and preserve source-root identity. Verify the source/dependency fingerprints against the Stage 6.1 receipt before executing anything. Compile a source archive of `8ed2d32` into `ACCEPTED/dist` using the **same** installed dependency tree and compiler, then build the optimized Node runtime. The test oracle body pin independently verifies the original implementation. Run these serially with no heavy local tests/builds/providers alongside them:

```sh
node --max-old-space-size=2048 scripts/rust-traversal-benchmark.mjs "$ACCEPTED/dist" "$SOURCE" "$WORK/rust-before.json"
node --max-old-space-size=2048 scripts/rust-traversal-benchmark.mjs "$PWD/dist" "$SOURCE" "$WORK/rust-after.json"
cmp "$WORK/rust-before.json.output.json" "$WORK/rust-after.json.output.json"
node --max-old-space-size=2048 scripts/semantic-profile.mjs baseline "$SOURCE" "$WORK/production-index" "$WORK/production.json"
node scripts/semantic-profile-verify.mjs "$SOURCE" "$WORK/production-index" "$WORK/production-witness.json"
```

Compare saved complete `exports/graph.json` and `diagnostics.json` with `cmp` and streaming SHA-256; for manifest/state remove only the explicit clock fields listed above and compare complete ordered JSON structures. Use the existing `repositoryStatus` API for the separate freshness observation. The Rust helper refuses a mismatched selected inventory. It retains complete result JSON and raw inspector profiles **outside Git**; the compact receipt retains their hashes and reduced CPU/resource evidence. Raw evidence from this run is at `/private/tmp/prograph-stage6-2-20261022`. The accepted build, source/dependency link, compilation and file-witness reads are outside all measurement timers. Inspector files can be opened independently in DevTools; use weighted stacks, not summed inclusive rows.

No incorrect semantic change was discovered or repaired. Validation preflight did find partially cleaned older temporary SDK directories; their remaining launchers were insufficient evidence of complete toolchains. Fresh Node, Go, JDK, .NET and SCIP.NET bundles were restored at their pinned versions and verified against their **original complete bundle hashes** before the full suite started. Python, Java/Go/SCIP tools and rust-analyzer pins are recorded with the local validation evidence. No provider, expensive oracle or assertion was disabled. No optimization after candidate 1 was authorized by Stage 6.2; identity/export work required a separate milestone.

## 15. Stage 6.3 — legacy JSON export residency

The separately authorized [Stage 6.3 record](semantic-core-stage6-export-residency.md)
and [receipt](benchmarks/semantic-core-stage6-export-residency.json) describe bounded
byte-preserving JSON serialization and the user-approved per-file atomic-export
contract. Rust, canonical encoding and Semantic Core publication are unchanged.
The focused pair preserves all four accepted files byte-for-byte, trading
395.462 → 843.442 ms export time for 1,352,384 → 503,936 KiB cumulative process RSS
in the saved-output harness. One complete phase run measures 58.864 s /
1,330,896 KiB, with the process high-water reached before JSON export. This is
not whole-pipeline memory or time qualification; Core-only RSS remains unknown.
Complete local regression and actual Node 20/22/24 CI acceptance are pending.
Stage 6.4 is not authorized by this work.
