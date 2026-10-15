# Semantic Core Step 2 implementation record

**Status (15 October 2026): Step 2 is in progress; Core 2.0 is not accepted as complete.** This record describes the implemented project-aware ingestion milestone, restricted Rust continuation, validation, and remaining acceptance gates. It continues the existing [architecture](semantic-core-2.md) and [closed Step 1 foundation](semantic-core-step1.md). It does not propose a third core implementation step or change the architecture's requirements.

Step 1 is committed as `6870c1f`. Its functional gate passed. The proposed one-second 1M-site publication gate remains unmet: the durability-preserving review measured 5.850 seconds for publication, including 4.605 seconds rebuilding navigation, plus 1.902 seconds sealing immutable roots. Full membership and index construction remain proportional to selected facts. Hashing sealed roots and using one navigation pass are justified improvements, but do not qualify sub-second publication. `synchronous=FULL`, support validation, atomic membership/projection/pointer publication, and recovery checks remain enabled. Sorting inserts made the same retained corpus slower and was rejected. See the raw [review evidence](benchmarks/semantic-core-step1-review.json).

## Architecture actually implemented

The legacy graph remains the compatibility authority for its existing domains. The additional semantic path is now:

```text
read-only repository inventory
  -> project/config discovery and compiler contexts
  -> TypeScript compiler units | explicit verified SCIP import | explicit Clang TU | explicit Rust runner
  -> immutable native/common facts, claims, occurrences and input ownership
  -> sealed base runs
  -> supported call-summary pass, with dependency-ordered owned output runs
  -> one atomic semantic snapshot with SQL navigation projections
  -> additive CLI / MCP / HTTP / evidence inspector
```

Common TypeScript and explicitly imported/native definition/reference/call assertions originate in facts. They are not derived by promoting legacy graph edges. React, Tauri, boundaries, architecture and Knowledge Overlay still use their existing adapters and the conservative whole-graph bridge. Legacy `graph.sqlite` is still schema `1.2.0`; package version is `0.3.0`. `semantic.sqlite` storage schema is `2.0.0-step2.2`, format 2. TS, SCIP and Clang mapping versions are independently `2`; pass version is `call-summary@1`. Mapping versions participate in freshness and native retention; incompatible prior producer runs are excluded rather than silently reused. This milestone deliberately does **not** change the default meaning of existing callers/callees, activate semantic facts as the sole authority, or call syntax frontends precise providers.

The implementation remains a synchronous local SQLite writer. Import document/batch yields allow cooperative cancellation; snapshot publication itself blocks its caller. Cross-database publication remains non-atomic. There is no production worker scheduler, resumable provider runner, general reachability GC, or delta navigation projection.

## Project and indexing contexts

`src/core/semantic/projects.ts` discovers plans using the scanner's selected files. Scanner metadata inventory now includes named tsconfigs/jsconfigs, environment lockfiles, Pyright config, Go workspace manifests and Gradle manifests. Adding metadata does not execute a build or expand excluded dependency/generated trees into display sources.

| Language | Actual context input | Qualified handling and remaining gaps |
|---|---|---|
| TS/JS | Each tsconfig/jsconfig, actual extends reads, ordered compiler options, project references, package/lock inputs, compiler version, selected sources | Native TypeScript config parsing drives selection; separate variants when files appear in multiple projects. Referenced projects are independent units; required declaration outputs must exist. Orphans have an explicit inferred unit. External module/ambient lookup prevents narrow reuse. |
| C/C++ | Each compilation-database entry, working directory, source, ordered arguments or opaque command, output, language interpretation | Multiple commands for one source remain different units. Explicit `-x` and compiler driver select C/C++ interpretation of `.h`. The optional Clang backend qualifies actual includes/forced includes/defines/standard/target/sysroot through an allowlisted syntax-only invocation and dependency closure. Shell-only commands are retained, never tokenized/executed. |
| Python | pyproject/Pyright manifest, package-relative source inventory | Discovery only; interpreter/search paths/stubs are not qualified by reading the manifest. A verified SCIP sidecar can declare environment file digests. |
| Rust | Discovery observes manifests/edition; explicit runner captures workspace metadata, package versions/features, Cargo lock, target cfg, compiler/analyzer versions/digests and source inputs | Partial qualification for closed workspaces/path dependencies. Offline compiler checking and actual rust-analyzer SCIP run in an owned copy. External normal dependencies, Cargo config, build scripts, proc macros and sysroot semantics are unqualified/refused. Existing conservative graph behavior remains. |
| Go | go.mod/go.work, locks and source inventory | Discovery only; packages/tags/GOOS/GOARCH/module closure are not qualified. |
| Java | Maven/Gradle manifest and source inventory | Discovery only; classpath/module path/JDK/generated roots are not qualified. |
| C# | solution/project manifest and source inventory | Discovery only; frameworks/references/language/preprocessor environments are not qualified. |

Unit context identities include repository identity, unit key, environment/config inputs, options and relevant compiler version. Source text digests belong to unit input fingerprints; an ordinary edit does not silently select another build variant. Ordered compiler arguments are never sorted for identity. Physical compiler/config dependencies are retained independently of display-source selection. Discovery failures are exposed as context coverage gaps. Malformed-only TypeScript projects retain the original failed-attempt/historical-snapshot behavior.

This is not complete build discovery. Manifest observation is not a build target, interpreter, crate graph or classpath qualification claim.

## Semantic providers and native facts

Existing `SyntaxProvider` / graph-emitting `SemanticProvider` adapters remain compatible. Fact producers are separate direct entry points: TypeScript unit indexing, `importScip`, `indexClang`, and explicit `indexRust`. They emit validated facts under staging owners, then seal/publish; they do not manufacture `GraphNode`/`GraphEdge`. A unified runner/probe/resource/provider descriptor registry is still unfinished.

Registered native predicates now include `typescript.Signature`, `scip.SymbolInformation`, `scip.Relationship`, `scip.Occurrence`, `cxx.Declaration`, and `context.Project`. They retain structured native information alongside common navigation. Unknown predicates, oversized payloads, invalid entity/range/context/support/provenance data are refused. The registry validates common endpoint contracts and payload bounds; exhaustive per-language typed native schemas remain unfinished.

Native values preserve signatures, package tuples, documentation samples/truncation, relationship flags, raw occurrence roles/highlighting/enclosing ranges, mangled/type/template information, declared virtual status, base type spelling and attributes. These fields do not imply that common inheritance, runtime dispatch, specialization or macro expansion graphs have been implemented.

The following is the exact capability matrix for this milestone. `S` means observed syntax, `H` conservative legacy heuristic, `P` partial compiler/provider binding, `N` native metadata only, `U` unsupported/unqualified. Definitions/references in this table refer to the **fact navigation API**, not merely symbol nodes in the legacy graph.

| Provider/language | Syntax | Symbols | Definitions | References | Calls | Types | Inheritance | Generics/templates | Macros | Dynamic dispatch | Native predicates | Build context |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TS/JS compiler | S | P | P | P | P static | N signatures | U common graph | N signatures | U | U | Signature, Facet | P config + actual loaded inputs |
| explicit Clang C | S | P | P | P local TU | P static declaration | N qualified spelling | U | U | U expansion | U | cxx.Declaration | P actual allowlisted TU inputs |
| explicit Clang C++ | S | P overloads | P | P local TU | P static declaration | N qualified spelling | N base spellings | N compiler AST fields | U expansion | U final target | cxx.Declaration | P actual allowlisted TU inputs |
| explicit Rust runner | S | P | P | P | U | N signatures | N reported trait relationships | N reported symbols/signatures | U | U | SCIP information/relationships/occurrences | P checked closed Cargo workspace/features/target |
| generic verified SCIP | producer-defined | P reported symbols | P reported roles | P reported roles | U | N if reported | N relationship flags | N signature metadata | N reported roles only | U | SCIP information/relationships/occurrences | sidecar inputs; producer completeness unqualified |
| Python fallback | S | S | U | H graph only | H graph only | S | S | U | U | U | none language-native | manifest observed |
| Rust fallback | S | S/H | U | H graph only | H graph only | S/H | S | S | S declarations | U | none language-native | manifest/edition observed |
| Java fallback | S | S | U | H graph only | H graph only | S | S | S | U | U | none language-native | manifest observed |
| Go fallback | S | S | U | H graph only | H graph only | S | S | S | U | U | none language-native | manifest observed |
| C# fallback | S | S | U | H graph only | H graph only | S | S | S | U | U | none language-native | manifest observed |

All precise runs report partial coverage. No installed backend or successful process is labeled complete. Qualified TypeScript and local Clang tests ran. Generic protocol fixtures with Python symbol strings test interchange semantics, not real Python compiler qualification. A real `@sourcegraph/scip-python@0.6.6` package was inspected and invoked in an isolated temporary corpus with OS network/process/file restrictions and Node permissions. It failed before indexing because its bundled filesystem layer mutates `path.resolve`, which Node 25 permission mode makes read-only. No restrictions were removed to produce an index. Python, Java, Go and .NET semantic indexers remain unqualified/unintegrated; generic import can consume their compatible indices but this is not an all-language support claim.

## Qualified Rust producer/runtime slice

`indexRust` and `semantic index-rust <Cargo.toml>` are explicit entry points. They require absolute analyzer/toolchain paths and an analyzer binary SHA-256. The current runner contract is `rust-scip-runner-1`, qualified against [rust-analyzer release 2026-10-12](https://github.com/rust-lang/rust-analyzer/releases/tag/2026-10-12), commit `2ad81e72b7`, and rustc/Cargo 1.95.0 on macOS arm64. The shipped runner accepts that analyzer identity only. No tools are installed or invoked by ordinary discovery, analyze, sync or watch. Other toolchain/OS combinations require evidence; the added Linux CI configuration is not a completed Linux run.

The runner captures selected Rust/manifests/locks into an owned `index/providers/rust/<run>/source` archive. Cargo runs offline with a private config/target directory, explicit rustc/PATH and only registry/git cache directories shared from the user Cargo home. Those caches may be populated by Cargo; they are not claimed read-only. The source repository is not written. Missing locks are generated in the copy. Locked Cargo metadata resolves workspace/path dependency closure and active features/target; packages with external normal dependencies, custom build targets or proc-macro targets are refused before compiler checking. `.cargo/config[.toml]` is refused rather than silently ignoring wrappers or environment changes. Cargo metadata may still fail on unavailable development dependencies. `cargo check --workspace --offline --locked` must succeed before indexing. Build scripts/proc macros and network access are not enabled to obtain success.

The exact release's [SCIP implementation](https://github.com/rust-lang/rust-analyzer/blob/2026-10-12/crates/rust-analyzer/src/cli/scip.rs) enables Cargo build-output loading independently of its LSP default settings. Its managed config therefore overrides that command with `/usr/bin/true`, disables proc macros and sysroot semantic sources, and declares target/features. This preserves a small qualified navigation slice; it does not claim complete Cargo/build or standard-library semantics. Cargo/rustc executable hashes, versions, cfg, package/feature/lock digests and compiler success are retained in `context.Project`. Driver libraries/SDKs are not exhaustively fingerprinted; that environment remains partial. Native SCIP traits/associated items/signatures remain native facts; no reference/highlighting field becomes a call target.

Actual producer validation exposed invalid **advisory enclosing ranges** attached to otherwise valid Rust references. The explicit `enclosingPolicy: diagnose` records the reported field and a diagnostic, marks it excluded, and omits it from asserted enclosing bounds. Primary occurrence ranges, source hashes, symbol grammar, URI roots and path validation remain strict; a malformed primary range still rejects its document. Generic imports retain strict enclosing validation by default. `documentPathPrefix` maps nested Cargo workspace roots into repository-relative paths without weakening traversal or source-root checks. This is a deliberate producer compatibility policy, not acceptance of invalid source evidence.

Argv-only producer execution caps captured output at 4 MiB and terminates POSIX process groups on deadline, cancellation, failure or successful launcher exit. A total pre-publication deadline is checked around stages, verification and importer publication entry; synchronous SQLite publication itself is not interruptible by that cooperative check. Source catalogue limits are 1,000 captured files / 8 MiB per file / 32 MiB aggregate; artifact admission is 64 MiB. Artifact size is checked after producer completion, so it is not a hard temporary-disk quota. Repository discovery precedes these capture limits. Successful and failed archives remain for inspection and need manual cleanup; resumability, disk quotas and automatic GC are unfinished.

Runner identity, target/features and normalized Cargo environment select variants; ordinary source edits retain the variant identity. Producer version and recorded physical/source inputs participate in freshness and whole-artifact replacement. Two feature contexts coexist, and source edits conservatively invalidate sibling contexts. Tests cover actual traits/associated items/path dependencies, feature selection, stable navigation, edited incremental-versus-clean common fact equality, build-script refusal without source effects, digest refusal, process descendants and cancellation. Readonly Step 1 and Step 2.1 stores remain readable; writer schema labeling advances additively to Step 2.2. Legacy schema `1.2.0` and package `0.3.0` do not change.

The reproducible command is:

```bash
prograph semantic index-rust native/Cargo.toml --repo /path/to/repo \
  --index /tmp/fresh-index --analyzer /absolute/rust-analyzer \
  --analyzer-sha256 <binary-sha256> --toolchain /absolute/toolchain/bin --format json
```

Real corpus qualification and negative cases are recorded in [semantic-core-step2-rust.json](benchmarks/semantic-core-step2-rust.json), produced by `scripts/semantic-rust-benchmark.mjs`. Counts distinguish processed observations from unique occurrence identities. Parent-process RSS excludes native child peaks. Closed-workspace success does not qualify Pastey's external dependencies/build scripts or all Rust projects.

| Actual Rust corpus | Source files / lines | Complete runner time | Processed / unique occurrences | Durable publication | DB bytes | Node peak RSS KiB | Warm references p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| fallible-iterator 0.3.0 | 2 / 3,287 | 1.021 s | 4,452 / 4,442 | 25.421 ms | 18,046,976 | 164096 | 0.61 ms |
| pxfm 0.1.29 | 259 / 103,239 | 18.934 s | 82,388 / 82,332 | 528.089 ms | 296,210,432 | 324,560 | 0.639 ms |

These successful runs checked compiler inputs, imported actual producer output and passed SQLite integrity checks. `itoa 1.0.18` was refused during offline metadata resolution because `criterion` was missing. Pastey's observed 160 Rust files / 141,435 lines were captured read-only, then its build-script/proc-macro environment was refused before any build execution. No partial native index was published for either failure. Pastey's current corpus differs from the earlier mixed-source baseline; the recorded source inventory pins the exact trial. These failures are retained in the raw evidence, not turned into qualified-language coverage.


## SCIP interchange contract

`scip-wire.ts` uses a wire-compatible subset of the [official protocol](https://github.com/scip-code/scip/blob/main/scip.proto), pinned to SHA-256 `b38021b65ef90cbbf6af9c829ff75192859ad9b5da05439ef154bea4ceb2bf03` inspected 14 October 2026. Metadata protocol version 0 is supported; unknown fields are skipped without allocating whole indices. UTF-8 disk sources are supported. Physical UTF-16 sources are explicitly unsupported. Documents support packed historical and typed current ranges, UTF-8/16/32 columns, CRLF, codepoint validation and enclosing containment. Typed and packed ranges must agree when both occur; ambiguous unspecified position encodings require an explicit historical encoding in the sidecar.

A required sidecar declares format/id, producer name/version/basis, explicit project context, current source root, index digest, source file digests, optional environment file digests, optional original file-URI project root, and optional historical position encoding. Producer/root/digest/encoding and sidecar type mismatches are rejected. The declared context, producer, source-root mapping, artifact digest and resource bounds are retained as `context.Project` facts. Source paths reject traversal, absolute/Windows/ambiguous separators, duplicate documents, symlink/realpath escapes and oversized sources. Disk source is hashed before/after ingestion and again before publication. Embedded text must match verified source.

Verification establishes artifact/source/environment consistency with the supplied sidecar. It does not authenticate the producer or independently rerun its typechecker to prove the reported binding. The producer name and basis are declared input; real producer qualification remains a separate acceptance gate.

Global identity is repository + project/environment context + full raw SCIP symbol (including package manager/name/version and descriptors). Document-local identities also include artifact id, source path and digest. Distinct producer claims coexist; replacement is scoped to `scip/<manifest-id>/`. Native information does not mutate immutable symbol identities; local names are currently exposed as `local <id>`, with producer display names available in native information.

Limits: 10 GiB index, 16 MiB document/external-symbol field, 8 MiB source, 100k occurrences/symbols per document, 1024 relationships per symbol, 100k documents/external symbols, 500 observations per write batch, 200 retained diagnostics per run. Wire validation caps nested objects/fields before protobuf decoding, validates known wire types and strict UTF-8 strings, and bounds packed scalar arrays. Negative role bitmasks are rejected. TS coordinates retain compiler line-break conventions; SCIP and Clang use physical CR/LF/CRLF lines and an explicit `physical-lines-1` identity discriminator, so Unicode separators inside strings/comments cannot shift anchors. Oversized or semantically malformed documents are excluded, diagnosed, and never partially published. Invalid framing, changed artifact/source/environment, cancellation, unsupported metadata or publication conflict keeps the prior active snapshot unchanged. Unknown wire groups are unsupported. A filename-only, streamed repository catalogue is capped at twice the document quota (200k paths by default); at most 4096 declared environment inputs are admitted. Source texts are not hydrated for this inventory. Memory consists of this bounded catalogue/digest list, one admitted document/source, SQLite/decoder working state and runtime garbage-collection overhead; measured peak is reported separately.

Accepted documents seal independently but are activated with the index summary in one snapshot transaction. Artifact replacement excludes old document assertions, including rejected documents; a partially accepted artifact cannot preserve stale definitions just because their symbol is still referenced. Cooperative yields between batches and hashing allow cancellation. A second inventory fingerprint before publication rejects source/config additions or changes during import. This is an explicit import path, not an indexer installer or a managed build runner.

```bash
prograph analyze /path/to/repository --output /tmp/custom-index
prograph semantic context --repo /path/to/repository --index /tmp/custom-index --format json
prograph semantic index-clang '<unit key from context>' --repo /path/to/repository --index /tmp/custom-index --format json
prograph semantic import-scip /path/to/index.scip --manifest /path/to/manifest.json --repo /path/to/repository --index /tmp/custom-index --format json
prograph semantic find target --repo /path/to/repository --index /tmp/custom-index --format json
prograph semantic native '<semantic key>' --repo /path/to/repository --index /tmp/custom-index --format json
```

SCIP references/highlighting are never converted to calls. Import modules are source document containers; precise enclosing executable ownership is not established from highlighting. Definition navigation retains forward/body qualifiers rather than claiming a body exists.

## Clang effect and confidence contract

`index-clang` explicitly runs fixed `/usr/bin/clang`; it never runs the compilation database's executable or shell string. Arguments must be an array. A narrow option allowlist retains include/define/forced-include/language/standard/target/sysroot settings and refuses plugins, response files, arbitrary frontend options and unknown effects. Object-output flags are stripped. Syntax-only AST and dependency extraction run with clean environment, no implicit module generation, 30-second subprocess timeouts, 16 MiB output limits, 200k AST nodes and 8 MiB local source limits. No object output is produced.

The actual compiler executable digest, version, flags and dependency digests participate in input identity and retention. Local AST declaration IDs bind references and static call targets, including overloads. Semantic declaration-parent IDs preserve out-of-line class member scope. Deterministic symbol identities use mangled name plus semantic scope, or scoped/local declaration data; a linker name alone is not treated as a compiler USR or proof that explicit ABI aliases are one semantic declaration. Only direct callee declarations through supported transparent wrappers establish targets; nested factory calls, selectors, constructor arguments and function-pointer variables remain unresolved. Calls resolve only through the callee expression's compiler declaration ID; argument symbols and function-pointer variables do not become fabricated callees. Constructors without a target ID, implicit declarations, external declarations, macro expansion anchors, runtime virtual dispatch and cross-TU linking remain gaps. Common definition values distinguish declarations with/without bodies. Shared headers retain separate C and C++ unit contexts. Clang is not assumed to reproduce another compiler/toolchain's build merely because their command was recorded.

## Passes, ownership and incrementality

`passes.ts` validates duplicate IDs, dependency cycles and missing dependencies before starting outputs. Each pass declares reads, writes, version, dependencies, invalidation scope and row/batch bounds. Dependency outputs are sealed owned runs supplied to downstream passes. The implemented call-summary pass reads base call-site/target assertions with SQL keyset batches, emits derived claims with site AND target AND inventory-selector support, and inherits the weaker confidence. It does not hold an unbounded call list in memory. Any pass failure prevents the new full snapshot from publishing; prior state remains active. This is not yet independent per-pass failure publication or a complete pass-conversion framework.

TypeScript units reuse sealed base/call-pass runs only when mapping/config/compiler context and source inventory match, all persisted physical/source hashes match, and coverage records zero unresolved bindings, semantic errors and external imports. Units with dependency-tree/ambient/external lookup remain conservative rebuilds. Imported/native groups additionally require an unchanged whole code/config inventory and verified artifact/dependency digests. Documentation-only changes retain eligible semantic units; source/config additions, deletion or modification invalidate native artifact/TU groups conservatively. Changed groups require explicit reimport/reindex; sync does not silently run external tools. The legacy bridge is rebuilt as before. Status checks recorded positive dependencies outside scanner selection, including inherited configs, actual compiler binaries and generated headers. Their changes force conservative sync; ordinary isolated source edits retain the existing incremental path. Status exposes whether recorded inputs were checked/changed/unavailable/over budget, and does not claim full negative-lookup or build-environment completeness. Watch retains its existing exclusions: edits in excluded/generated/dependency trees or outside the watched root require manual status/sync; normal watch-triggered sync checks recorded dependencies. Oversized legacy evidence retains its complete immutable artifact and original graph record; its semantic fact carries a bounded payload reference instead of failing the entire semantic attempt or raising the 64 KiB fact quota.

Immutable fact identity, independent claims, interned provenance, OR-of-AND supports, selector conflict detection and atomic ownership selection survive from Step 1. A surviving symbol is not ownership of its old assertions. This milestone does not implement narrow global dependency-closure recomputation, automatic artifact runner scheduling, negative module-search selectors for all providers, randomized all-language oracle coverage, projection deltas or claim/support/entity reachability collection.

## Queries, UI and migration

Additive operations `context`, `native`, `relationships` extend the same `query_semantic` MCP tool, `/api/semantic/:operation`, and CLI namespace. Common keys select the same snapshot across query transports. New SQL projections/indexes support context-by-variant and keyset native claim lookup; relationship indexing is separate from potentially huge occurrence streams. Existing item/candidate/byte/support/metadata budgets and cursor snapshot binding remain. Native JSON is decoded only after candidate selection. Semantic navigation samples retain their stated confidence, including probable imported inference; trusted call summaries and existing legacy trusted-default filters remain unchanged. An individual payload exceeding a requested byte budget may require raising that budget rather than receiving a continuation item. No occurrence arrays are passed to React Flow/ELK.

The inspector now offers bounded semantic candidates, explicit variant selection, sampled definitions/references with confidence/provider/basis/location, partial coverage and unchecked-source-freshness notices, truncation, and graceful semantic unavailability. It uses cancellable effects, pinned snapshot reads and concurrent definition/reference requests. It does not choose an ambiguous name automatically. Selection state resets by graph node identity, so navigating to another same-named node cannot retain the previous variant's evidence. Existing language/scope/framework/Knowledge Overlay controls remain.

Readonly Step 1 indices retain their stored schema label and old navigation. New context queries return an explicit unavailable gap if the old context table is absent. A writer opens the recognized Step 1 schema additively, creates new tables/indexes and advances only the semantic schema marker; sealed historical snapshots remain readable. Unknown formats/schemas are still refused. Legacy-only indexes still use existing read paths and acquire the additive store on analyze/sync. Multi-project identities change newly produced semantic variants; legacy graph IDs are preserved. This is a beta additive migration, not default-authority cutover or an export/rollback production migration tool.

Most legacy architecture/context/affected/cycle/UI graph query paths still materialize graph arrays. New navigation is bounded SQL; result/candidate caps do not amount to a proven SQLite work deadline or cancellable worker. Whole Core default activation would be unsafe to claim while those paths and publication remain unconverted.

## Validation and measured workloads

Raw measurements and real-repository evidence are in [semantic-core-step2.json](benchmarks/semantic-core-step2.json). Reproduction tools are `scripts/scip-benchmark.mjs`, `scripts/semantic-real-repository.mjs`, and the Step 1 publication/recovery scripts. SCIP generation occurs in a separate process from import so generator arrays do not inflate importer peak RSS. Benchmarks retain unique source anchors, facts/claims, all indexes, support checks, durable publication and final integrity checks. Warm query measurements do not evict OS cache and are not cold-start claims. Synthetic occurrence counts are not LOC or qualified language-provider coverage.

All measurements below ran locally on Apple M5 / 16 GiB / macOS arm64, Node `25.9.0`, SQLite `3.53.1`, better-sqlite3 `12.10.0`. The semantic TypeScript API is ts-morph's bundled compiler `5.9.2`; repository typecheck uses TypeScript `5.9.3`. Each raw run retains its timestamp, implementation digests and corpus identity. These are individual trials, not a statistically controlled cross-machine comparison.

| Workload | Write/import | Seal | Publication including commit | DB bytes | Peak RSS KiB | Warm reference p95 |
|---|---:|---:|---:|---:|---:|---:|
| Step 1 durable review, 1M sites | 234.328 s write | 1.902 s | 5.850 s | 1,486,991,360 | 283,152 | 1.315 ms |
| Step 2 foundation rerun, same 1M-site shape | 160.942 s write | 1.224 s | 8.453 s | 1,554,948,096 | 310,544 | 1.124 ms |
| Final SCIP mapping, 100k occurrences | 15.936 s import including publication | included | 0.482 s | 300,331,008 | 405,168 | 1.198 ms |
| Final SCIP mapping, 1M occurrences | 522.316 s import including publication | included | 16.768 s | 3,023,015,936 | 624,528 | 1.240 ms |

The foundation rerun retained 1,001,001 occurrences, 1,022,002 claims/navigation rows, 10k supported call sites and 1,000 caller summaries. Its publication spent 5.951 s building navigation and 2.039 s in pointer/commit/checkpoint work; membership was 0.423 s and support eligibility 0.013 s. Extra navigation indexes and I/O still make total publication expensive. The final SCIP workload retained 2,000,012 claims/navigation rows and has **zero calls**, deliberately: it retains both native observations and common references. Its publication spent 12.679 s in navigation, 3.446 s in membership and 0.642 s in pointer/commit work. Its size/timing is not comparable to a single-reference-only foundation row count.

The supported-claim partial index removed a measured unnecessary scan: on the same 1M SCIP work shape, zero-support eligibility dropped from 2.783 s to 0.129 ms while all support checks remained active for supported claims. This is a measured stage improvement, not evidence of a faster complete importer: the earlier complete trials took 512.333 s and 578.092 s. The later filename-only inventory/strict-wire trial took 549.038 s and published in 15.741 s; its mapping predates the final physical-line/version hardening and is retained only as characterization. The final rerun above is the version-specific result. No one-second qualification or overall importer speedup is claimed. Full projection materialization and repeated durable batch commits remain bottlenecks. Reusing owned projection segments and isolating synchronous work require their own snapshot/query/recovery proof; timing only the active pointer or reducing durability would change the benchmark contract.

| Read-only real corpus | Corpus identity | Selected source files / lines | Analyze time | Semantic occurrences / calls | DB bytes | Peak RSS KiB |
|---|---|---:|---:|---:|---:|---:|
| ProGraph final source revision | working tree over `6870c1f`; inventory SHA in raw record | 105 / 11,509 | 18.613 s | 75,175 / 7,555 | 232,853,504 | 1,289,008 |
| installed protobufjs | `8.8.0`; inventory SHA in raw record | 69 / 18,742 | 4.238 s | 22,897 / 1,532 | 70,127,616 | 653,600 |
| Pastey mixed TS/JS/Rust | `eaf2e1eb0ba3b0001eb91a1a58cb8e48ae44942c` plus observed inventory SHA | 232 / 156,563 | 38.983 s | 35,940 / 3,343 | 335,486,976 | 1,487,984 |

The protobufjs metadata's parent Git commit belongs to the containing ProGraph checkout; it is **not** a protobufjs upstream Git revision. Package version and observed source inventory are its corpus pin. Real timings cover existing syntax/legacy extraction plus additive semantics, not native indexing of every language in those repositories. All semantic results remain partial, all reported database integrity checks passed, and custom output directories kept the source repositories and their existing indexes untouched. The protobufjs/Pastey trials preceded final mapping/retention hardening; their per-run implementation hashes qualify that scope. Self-analysis and 100k/1M SCIP were rechecked after that hardening. The local larger corpus qualifies a 100k-LOC-class mixed workflow, not 1M/10M LOC compiler behavior. Compiler/project memory, global legacy materialization, synchronous publication, no-op/edit/header timing sweeps and cold reads remain unqualified at large scale.

Validation passed 101 tests (54 legacy, 17 foundation, 30 ingestion/project/pass tests), complete build, node/UI typecheck, package lint and whitespace diff checks. Four separate process-exit recovery probes retained the old snapshot before/during publication and the new snapshot after commit; integrity stayed `ok`, and a corrupt database was refused without mutation. These are process-recovery probes, not physical power-loss or disk-exhaustion testing. Export-failure injection, OS-level disk exhaustion, all-provider randomized oracle tests and worker deadline/cancellation qualification remain unperformed.

The built local UI was exercised through search, symbol inspection, explicit selection between two project variants, and bounded definition/reference samples. Confidence, compiler provider/basis, location, partial coverage, source-freshness and truncation notices were visible; existing graph controls remained usable. The final inspector change was also exercised by selecting one `analyze` method's evidence, clicking another same-named graph node, verifying the selection/evidence reset, then selecting that method's new evidence. No browser console errors were captured. These smoke checks intentionally used recorded self indexes and displayed the stale-index notice when source changed. Evidence: [bounded reference samples](benchmarks/semantic-core-step2-ui.png) and [final inspector regression](benchmarks/semantic-core-step2-inspector-reset.png).

Reproduce against a fresh external output directory after building:

```bash
npm test
npm run build
npm run typecheck
npm run lint
node scripts/semantic-benchmark.mjs 1000000 /tmp/foundation.json
node scripts/scip-benchmark.mjs 100000 /tmp/scip-100k.json
node scripts/scip-benchmark.mjs 1000000 /tmp/scip-1m.json
node scripts/semantic-recovery.mjs /tmp/recovery.json
node scripts/semantic-real-repository.mjs /path/to/repo /tmp/fresh-custom-index /tmp/real.json
```

Run expensive benchmarks sequentially. Read the emitted environment, source inventory and implementation hashes before comparing trials; an existing output directory retains history and changes write/space costs.

The regression suite preserves the legacy language/framework/knowledge/custom-index/sync/watch/API/MCP tests. Additional tests cover wire grammar/Unicode/encodings, local symbol scopes, producer facts/relationship flags, reference-only no-call behavior, malformed/truncated/oversized inputs, nested protobuf expansion quotas, source mismatch, strict UTF-8/wire/role validation, physical Unicode separator mapping, bounded filename inventories, partial siblings, invisible abandoned document batches, cancellation, native-group retention/version invalidation, status/sync for excluded inherited config and generated headers, named configs/extends/ordered C/C++ variants/shared headers, sealed dependency-ordered pass outputs, additive old-schema reads, and real Clang overload/static-call binding. Step 1 edit-oracle/support/CAS/recovery tests continue to run. Real self-analysis exposed and fixed a quadratic ownership join in the call pass using indexed target lookups and direct ownership membership. A query-plan/confidence/ownership regression guards that fix. Native C++ tests also reject constructor-argument/nested-factory fake callees and unify out-of-line members under compiler declaration scope. Real JavaScript analysis exposed and fixed inferred constructor-property identity collisions by retaining the terminal symbol name. Real mixed-language analysis exposed oversized legacy evidence; the bridge now references its intact artifact within existing fact quotas. The malformed-Rust fixture now has its own Cargo root and asserts the analyzed root; previously root discovery climbed into ProGraph and the test accidentally triggered self-analysis. Its Rust recovery assertions were preserved.

The package `lint` task is typecheck, not a separately configured code formatter/linter. The initial milestone had no CI. The continuation adds `.github/workflows/semantic-core.yml`: Ubuntu 24.04 with Node 20/22/24, locked npm installation, an archive-digest-pinned actual Rust producer and explicit Rust 1.95.0, full tests/build/typecheck and recovery artifacts. This workflow has not run on GitHub yet. Linux/Windows qualification, 10M occurrence/LOC qualification and randomized all-provider oracles are not substituted by local results.

## Step 2 acceptance audit

| Required criterion | State at this milestone | Evidence or exact unmet reason |
|---|---|---|
| 1. Facts authoritative for migrated domains | Partial | Common TS/native navigation is fact-derived; default legacy workflow authority is unchanged. |
| 2. Symbol/occurrence navigation end to end | Met for qualified slice | CLI/MCP/HTTP/inspector plus common evidence queries; real index validation. |
| 3. Multiple providers coexist safely | Met within implemented replacement domains | Independent claims, contexts and artifact/TU replacement; tests preserve sibling native groups and reject stale groups. No last-writer entity mutation. |
| 4. Major language precise providers | Unmet | TS, local C/C++ and the restricted Rust runtime slice are qualified; Python/Java/Go/.NET native integrations and full Rust environments are unfinished. Generic interchange is not equivalent to qualifying these providers. |
| 5. Honest syntax fallback | Met | Existing frontends remain; incomplete/unavailable semantic paths do not claim completeness. |
| 6. Build/project/variant identity/invalidation | Partial | TS/Clang and restricted Rust actual inputs; full Rust/other language environments are unfinished. |
| 7. Production-usable streamed SCIP | Partial | Bounded explicit importer, failure/recovery/source tests and 0.1M/1M measurements; real third-party producer and historical corpus qualification remains incomplete. |
| 8. Native facts/common projections coexist | Met for current predicates | Signatures/SCIP/Clang native values plus common navigation; exhaustive language schemas remain incomplete. |
| 9. Generalized passes replace hard-coded order | Unmet | DAG/call pass implemented; framework/boundary/architecture/knowledge/test derivations still use legacy adapter order. |
| 10. Explicit semantic boundary operations | Partial | Existing namespaced legacy operations preserved; semantic operation/participant facts and passes are unfinished. No fake SCIP calls introduced. |
| 11. Ownership/support/selector incrementality | Partial | Safe sealed local reuse/native-group invalidation exists; cross-pass/provider dependency-closure execution remains unfinished. |
| 12. Incremental = clean oracle | Partial | Existing deterministic TS/edit oracle passes; randomized, variant/environment/native-artifact and all-provider oracle qualification is incomplete. |
| 13. No interactive whole-graph materialization | Unmet | New SQL navigation is bounded; many existing legacy graph query paths are not converted. |
| 14. Work as well as result bounds | Partial | SQL candidate keysets, stream/node/process limits and byte limits exist; hard SQLite deadlines/worker cancellation and graph traversal work caps are unfinished. |
| 15. Existing CLI/MCP/API/UI usable | Met locally | Complete regression suite and built browser smoke checks; transport additions are additive. |
| 16. Safe existing-index migration/read | Partial | Legacy + readonly Step 1 + additive writer upgrade tested; full default-authority migration/export/rollback is unfinished. |
| 17. Partial never masquerades as complete | Met | Producer and query coverage stays partial/unavailable; notices distinguish source freshness and historical snapshots. |
| 18. Crash-safe snapshot publication/recovery | Met within semantic.sqlite | Transactional membership/projections/pointer; process crash and integrity/corruption probes. Cross-database atomicity remains explicitly unsupported. |
| 19. Real repository validation | See evidence | Self-analysis and additional read-only corpus results are reported below; no monorepo claim. |
| 20. Measured documented performance | Met for measured workloads | Raw environment, implementation hashes, publication stages, memory, DB sizes and query samples; one-second gate remains unmet. |
| 21. No hidden known semantic correctness issue | Reviewed within qualified slice | Unsafe/ambiguous inputs fail closed or partial; unavailable semantics are not promoted. Remaining default conversion is explicitly unmet. |
| 22. Remaining work only genuine domain/scale limits | Unmet | Provider integrations, pass conversions, work-bounded query migration, default activation and full GC are unfinished core work, not optional CFG/dataflow. |

**Conclusion:** this is a validated implementation milestone within Step 2, not acceptance of all Semantic Core 2.0 requirements. The current default polyglot behavior remains predominantly syntax-based outside qualified TS and explicitly indexed C/C++, restricted Rust or imported navigation. Advanced CFG/dataflow/PDG work has not started.

The next milestone remains **inside Step 2**: qualified provider/runtime contracts and semantic framework/boundary projections, followed by bounded default-query migration, projection reuse/worker isolation and complete ownership/GC/migration qualification. The one-second publication target remains a measured gate; neither pointer-only timing nor reduced durability is an acceptable substitute. Do not switch default authority before those correctness, recovery, compatibility and work-bound gates pass.
