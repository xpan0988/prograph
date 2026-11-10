# Core 2.0 final acceptance

## Decision

The provisional Core 2.0 assessment remains **18 Met / 3 Partial / 1 Unmet** against the original 22 criteria. Agent navigation and publication worked in the tested workflows. Final acceptance remains open on supported build environments (#6), native resource containment (#14), real-source performance (#20), and scale readiness (#22). The thresholds in the [architecture contract](semantic-core-2.md#initial-experiment-gates) still apply.

The audit began on clean `main` at `e8a4ca4e483c9abb5162cfd3822056ca70459a1b`. Baseline implementation `439e051f6b701895b0b8935f22ce27ae2cc2ee7d` had 325 tests and successful Node 20/22/24 jobs in [run 40191373538](https://github.com/xpan0988/prograph/actions/runs/40191373538). The [Step 2 implementation record](semantic-core-step2.md) and Stage 6.1–6.6 reports remain the source for prior qualification and rejected candidates. Current execution receipts are in [the final audit evidence](benchmarks/core-2-final-acceptance.json).

## Production usability

| Assessment | Observed behavior |
|---|---|
| Fully working in the exercised slice | Clean tarball installation and initialization, custom-index analysis and reopen, MCP stdio handshake and tool discovery, bounded structured and legacy JSON results, exact-name definition/reference navigation, verified static callers and callees, cross-module dependencies, file impact, ambiguity and pagination. |
| Working with declared limitations | Claude Code 2.1.318 and Codex 0.163.0 each confirmed freshness and retrieved the definition and callers through production MCP. The successful Codex run used `writes` approval mode for the dedicated read-only server. Indexed definitions and call evidence remain snapshot-relative. The TypeScript runtime records the launcher working directory, so changing it can make an otherwise identical source checkout stale. Qualified callers describe compiler-observed static relationships. Coverage, truncation, and lack of results are independent. |
| Broken or misleading at baseline | Production tarball startup required a development-only dependency. Initialization restricted every repository to a TypeScript/Tauri sample. An index for a different repository could return exact symbols for the wrong checkout. Missing compatibility symbols emitted invalid MCP text content. File impact traversal missed import edges entering a file node. The compatibility calls cap could look exhaustive. A missing bare TypeScript package was treated as resolved from its name alone. |
| Outside the verified slice | Universal caller absence, complete dynamic dispatch, full build-system discovery, and unrestricted native-provider environments. Positive platform evidence is limited to macOS arm64 and Linux x64. |

On pinned `sindresorhus/p-limit` `a8a6fbec4e0e866d6d779b10889bb4f5567e70eb`, the independent source witness places `validateConcurrency` at `index.js:144` and its direct references at lines 10 and 95. The compiler result names the default export `default` with qualified name `index.js::pLimit` and the setter `index.js::pLimit::concurrency::set`. Both clients traced those calls from the same symbol key. The wire test uses the bound source digest, enumerates three distinct `run` symbols over separate pages, and checks the imports from `benchmark.js` against source and resolved endpoints. For its `./index.js` import, the TypeScript projection selects the companion `index.d.ts`. A runtime implementation edge requires separate evidence. The ProGraph checkout witness reads the actual `SemanticQuery` declaration from an independently indexed archive of the accepted source.

Use `get_status` for live freshness, then `query_semantic` for evidence. Per-partition coverage is pageable under semantic `status`. An empty result has `absenceProven: false`. A mismatched verified repository binding fails with an error. Standalone/older semantic snapshots without a snapshot-bound report declare the binding unchecked. Historical reads use the selected snapshot and remain available after edits or failed publication.

The TypeScript compatibility adapter now retains a bare package reference without compiler evidence as unresolved. It remains visible with `--include-unresolved` or the MCP equivalent. Adapter version 5 causes an existing index produced by adapter version 4 to report stale until sync. The package node and relationship identity rules are unchanged.

## Implementation

| Commit | Change |
|---|---|
| `0868e279a8a98b723f7ab819a361ba2512d62c52` | Fix packaged runtime dependency and init scope. Add repository binding, bounded coverage, structured MCP output, and honest empty/capped results. |
| `601f8add9af89ff9f612f558da01f5a2ade0ffcc` | Stream compatibility query bootstrap winners in key order by phase. Avoid keeping both the winner changes and a second decoded graph during a full compatibility rebuild. |
| `373ee931332800f4e7f9372b901011c057154b02` | Keep the last valid snapshot on known provider resource stops. Enforce input and artifact admission, refuse nonregular inputs, distinguish signal termination, and reject missing declared sources and colliding C# project variants. |
| `389356738173e4530fe7b8a544724037ec11f6df` | Declare all MCP tools read-only. |
| `a2e10ff3b6a3be9f4598813f606143416b513de0` | Include indexed file nodes in impact roots so import relationships participate in traversal. |
| `fd9bcd91af1e8bc6089f67c39387b519edcbdd13` | Preserve the active snapshot on managed decoder and Clang admission-limit failures, and reject missing guardian outcomes. |
| `5975b9806d6b66c7976c8beb1051a2c90efc6ad0` | Exclude unbound bare package references from trusted TypeScript dependency answers. |
| `3d73f5ef26f07d91333daa6eb90fdaaa523d0cc1` | Run the accepted byte-level storage oracles with the same real TypeScript policy on both sides. The current-policy dependency and clean/incremental tests execute separately. |

Publication continues to use the existing FULL/WAL transaction and cache/version contracts. Bootstrap still processes nodes before edges, preserves per-kind order, charges its original row and byte budgets, and publishes the authority marker with the report. The initial extraction graph, owner and selector catalogues, degree and relationship keys, and staging/seal transactions still grow with the workload.

## Supported environments and resource limits

| Provider | Executed scope | Remaining boundary |
|---|---|---|
| TS/JS | Compiler-backed configured and inferred units, project references and recorded positive/negative inputs. | External ambient/module lookup can require broad invalidation. The compiler and Core share a process. |
| C/C++ | Explicit allowlisted Clang arguments-array compilation units, local and forced includes, header dependency changes and variant options. | Shell commands, unqualified flags/generated artifacts, cross-TU linkage, and final runtime targets remain outside the verified scope. |
| Rust | Pinned rust-analyzer and Cargo/rustc, offline closed/path-dependency workspaces, feature/target variants and source receipts. | External normal dependencies, original Cargo configuration, build scripts, proc macros and sysroot navigation remain unqualified. |
| Python | Explicit interpreter, package and stub inputs with pinned SCIP. | Arbitrary environments and runtime metaprogramming remain unqualified. |
| Go | Pinned offline non-cgo compiler/indexer with explicit module context, tags, target and receipt-pinned cache if needed. | Arbitrary multi-module workspace layouts and cgo remain unqualified. |
| Java | JDK 21, pinned javac producer, explicit classpath/module path and release. | Maven/Gradle scripts and processors are excluded. Generated/classpath inputs require explicit capture. |
| C# | Explicit project/framework/reference/define variants with .NET 10 and pinned SCIP. | Duplicate paths in a single context are refused. MSBuild targets, generators and implicit build environment reconstruction remain unqualified. |
| Generic SCIP and syntax fallback | Source-verified bounded import or declared syntax observations. | Producer completeness and runtime dispatch are unqualified. |

Known deadline, output, input quota and native signal failures during replay abort publication. The existing guardian kills the observed POSIX process group on cancellation and owner death. The real Rust replay regression exceeds the captured source-file quota, verifies the exact previous snapshot and callers, and re-syncs successfully after the oversized file is removed. External writes before artifact admission, aggregate temporary-disk consumption and native process-tree RSS still need OS-level enforcement. Node's heap limit and sampled RSS do not impose a provider RSS limit. A production hard-limit mode needs an enforceable process-tree and storage boundary with a preflight refusal path when unavailable. There is no positive Windows qualification.

## Performance and real-source scale

The controlled bootstrap probe rebuilt compatibility query projections twice from clones of the same published Pastey database. The two runs processed **165,517** winners with identical work counters and complete row hashes across **21** logical query tables. Integrity and foreign keys passed. The writer reported WAL and synchronous FULL in both runs.

| Bootstrap replay | Wall | Process CPU (user / system) | Replay process peak RSS |
|---|---:|---:|---:|
| Accepted control | 67.123 s | 25.971 / 15.610 s | 337,376 KiB |
| Streaming candidate | 62.537 s | 23.460 / 13.166 s | 176,112 KiB |

The RSS reduction applies to the isolated bootstrap replay. The separate full-pipeline runs analyzed **172,935** physical source lines from Pastey commit `8714e1ee57e00b70fdf1e03d6c182a8ef984ded0`, with the same 309 selected files, dependencies and source digest. Both published 40,491 nodes, 78,181 edges and 46,845 diagnostics. Raw complete graph and diagnostic export bytes agree. The complete SQL comparison covered 76 semantic and 29 legacy tables. After accounting for run clocks and derived report keys, the only raw difference was the legacy query-cache generation UUID. The full-pipeline comparison predates the intentional TypeScript bare-package confidence correction.

| Full real-source pipeline | Wall | Process CPU (user / system) | Shared process peak RSS |
|---|---:|---:|---:|
| Accepted control | 138.536 s | 80.731 / 38.076 s | 1,061,152 KiB |
| Streaming candidate | 250.283 s | 117.873 / 60.394 s | 685,344 KiB |

The 60-second gate failed in both runs. Excluding the two compatibility export phases still leaves each run above the gate. The shared process includes Core, SQLite, Tree-sitter and the TypeScript compiler. The candidate's single observation below 1 GiB does not establish stable Core-only RSS. These are Apple M5 / 16 GiB / APFS runs on battery in low-power mode with different background load and uncontrolled filesystem caches. The earlier AC-power Stage 6 observations use a different frozen inventory and had materially different timings. A cross-host comparison and cold/tail qualification remain unavailable.

The existing CPU profile locates repeated traversal and canonical encoding in JavaScript and substantial synchronous SQLite work around staging transactions. In the current full pair, syntax fact staging took 32.129 / 88.439 s wall and 23.575 / 49.094 s combined process CPU. SQLite compatibility publication took 35.848 / 67.357 s, and the pointer/commit phase took 1.771 / 2.996 s. Wall time beyond process CPU also includes scheduler and filesystem effects. The samples do not isolate individual fsync calls or establish a portable throughput gain. The earlier rejected ownership-lifetime and SQL prototypes remain outside the runtime.

An independent process-tree sample on pinned go-cmp `b133f1f1932e48f466f597a3346ce6f5a49a0dc1` accepted 31 documents. Its 100 ms samples observed separate peaks of 307,536 KiB for the Go compiler and 33,856 KiB for scip-go, and a 530,864 KiB summed tree peak. Short-lived children can be missed and summed RSS counts shared pages per process. This qualifies an observation, with no enforcement or other-language memory claim.

The selected-owner probe runs production FULL/WAL publication against 1,000 and 10,000 owners with one dependent claim and a changed selector. At 10,000 owners, replacing one owner took **206.292 ms**, including **47.852 ms** building the content key and **155.930 ms** in membership work. The corresponding 1,000-owner replacement was **21.131 ms**. History retained the prior claim and the replacement removed it from the current view. Unchanged selections retained the same content key. This is a catalogue probe. It does not qualify an end-to-end no-change source sync or arbitrary selector fanout.

The real million-line attempt used upstream CPython v3.14.0, commit `ebf955df7a89ed0c7968f79faec1de49f61ed7cb`, matched against the upstream Git tag and recorded by source digest. The scanner selected **1,959,715** physical source lines in 3,191 source files. The harness stopped analysis at its **420-second** deadline and the database had no published snapshot. Sampled process RSS reached **3.73 GiB (3,911,104 KiB)**, above the original 2-GiB 1M-source target. This is a measured lower bound from a timed run with no native memory cap. The dependent no-change, file edit, shared header edit, variant change, clean rebuild and failure/recovery sequences at million-line scale remain unqualified because no usable initial snapshot exists. The p-limit edit, clean rebuild, failed configuration and recovery evidence is reported separately. The original 1-second publication threshold and 10M-source target also remain open.

The p-limit no-change sync reanalyzed zero files. Its source edit produced the same complete visible-claim, owner, support, node, edge and diagnostic witnesses as an independent clean index. A malformed JS config failed the next attempt, left that publication readable, and sync recovered after the config and source were restored. The final TypeScript policy was also tested by reopening the same index and syncing it in place. The uninstalled `yocto-queue` reference kept its relationship ID and moved out of trusted results.

## Original acceptance matrix

| Required criterion | State | Evidence or exact limitation |
|---|---|---|
| 1. Facts authoritative for migrated domains | Met | Activated directory queries read owned compatibility and semantic facts from one transactionally published authority. Reopen and publication/recovery oracles check the binding. |
| 2. Symbol/occurrence navigation end to end | Met | Real CLI/MCP and two actual agent clients, source-anchored definitions/references, callers/callees, ambiguity and pagination. The regression suite covers HTTP and inspector reads. |
| 3. Multiple providers coexist safely | Met | Independent claims and contexts, native replay/retention and alternative support, with multi-provider clean/incremental and prior-writer checks. |
| 4. Major language precise providers | Met | Qualified compiler slices for TS/JS, Clang, Rust, Python, Go, Java and C#. The provider table defines the scope. |
| 5. Honest syntax fallback | Met | Syntax evidence retains its basis and unavailable precise contexts remain visible. Rejected source selections produce no precise result for an omitted input. |
| 6. Build/project/variant identity/invalidation | Partial | Positive/negative input and variant checks cover the declared slices. Complete Cargo dependency/generation, Maven/Gradle/MSBuild modeling and broad external build resolution remain open. |
| 7. Production-usable streamed SCIP | Met | Bounded parsing, source/artifact authentication, document limits, stable ingestion/upgrade oracles and pinned producer tests. |
| 8. Native facts/common projections coexist | Met | Existing typed predicates and independent claims preserve native records separately from projected navigation. |
| 9. Generalized passes replace hard-coded order | Met | Versioned owned passes and independent negative-selector, support and invalidation checks. |
| 10. Explicit semantic boundary operations | Met | Qualified Tauri, HTTP/OpenAPI, GraphQL and gRPC/Protobuf operation and participant evidence remains covered. |
| 11. Ownership/support/selector incrementality | Met | Changed owner/support closure, deletion of last support and retained alternative support are exercised. Larger catalogue costs are tracked under #22. |
| 12. Incremental = clean oracle | Met | Deterministic multi-edit fixtures, stable history, all 18 seven-language rebuild checks in each Linux CI job, and the separate p-limit clean rebuild. The local run timed out after 17 checks. |
| 13. No interactive whole-graph materialization | Met | Indexed navigation and query projections with explicit candidate/result limits. Representative cycles are prepared offline. |
| 14. Work as well as result bounds | Partial | Query work bounds, process-group cleanup and failed-publication protection pass in the qualified slice. Hard native tree RSS and temporary-disk enforcement remain open. |
| 15. Existing CLI/MCP/API/UI usable | Met | Clean install, shared query paths and fresh/reopened reads. Agent wire uses additive structured results and existing JSON text. UI production build and the existing regression surface apply. |
| 16. Safe existing-index migration/read | Met | Prior-writer reads/upgrades, retained history, rollback and corruption refusal remain qualified in the POSIX slice. |
| 17. Partial never masquerades as complete | Met | Query source binding, freshness, provider coverage, truncation and evidence confidence are exposed independently. Unknown is not a closed-world negative. |
| 18. Crash-safe snapshot publication/recovery | Met | FULL/WAL and active-pointer atomicity, prior snapshot readability, four hard recovery points and corruption refusal. |
| 19. Real repository validation | Met | Pinned ProGraph and p-limit source checks, plus qualified real provider and mixed-source workloads. |
| 20. Measured documented performance | Partial | Real-source time and memory qualification, 1M/10M-source workloads, tail observations and the original one-second publication target remain open. |
| 21. No hidden known semantic correctness issue | Met | The reproduced installation, index binding, empty/capped response, module impact and variant issues are fixed and covered within the audited scope. This criterion records the known findings from the audit. |
| 22. Remaining work only genuine domain/scale limits | Unmet | Compatibility bootstrap is bounded at the payload-decoding layer. Core extraction, transaction amplification and owner/selector catalogue work still require implementation and qualification at source scale. |

## Regression and CI

The exact-commit [Semantic Core regression run 42783356918](https://github.com/xpan0988/prograph/actions/runs/42783356918) completed successfully on Ubuntu 24.04 x64 for `3d73f5ef26f07d91333daa6eb90fdaaa523d0cc1`. The job logs and digest-verified artifacts agree.

| Node version | Test files | Tests | Skipped | Build, recovery and strict evidence verifier |
|---|---:|---:|---:|---|
| [20.20.2](https://github.com/xpan0988/prograph/actions/runs/42783356918/job/129718463711) | 44 passed | 329 passed | 0 | Passed |
| [22.23.4](https://github.com/xpan0988/prograph/actions/runs/42783356918/job/129718464087) | 44 passed | 329 passed | 0 | Passed |
| [24.22.2](https://github.com/xpan0988/prograph/actions/runs/42783356918/job/129718464148) | 44 passed | 329 passed | 0 | Passed |

Each job passed the complete Node and UI build, all four recovery probes, corruption refusal, all 18 independent compiler rebuild checks, and the prior-writer upgrade.

The local macOS arm64 run on Node 25.9.0 finished with **327 passed, 2 timed out, 0 skipped** across 44 test files. The seeded multi-provider rebuild oracle matched on 17 of 18 recorded checks before its 90-minute timeout. The accepted-writer upgrade test reached its 5-minute timeout without a completed local result. Local typechecks, the Node/UI production build, four recovery probes, and corruption refusal passed separately. The local regression suite remains incomplete for those two tests. The completed Linux matrix establishes their passing CI results.

## Remaining blockers

- **#6** needs verified, read-only build descriptors for dependency and generated inputs and unambiguous project variants in the remaining declared environments. Any broader precise claim needs a compiler-backed invalidation and clean-rebuild witness.
- **#14** needs an enforceable process-tree memory and workspace storage boundary, with admission refusal when those limits cannot be installed. Current artifact admission can refuse publication after a provider has already written temporary data.
- **#20** needs repeatable results on the original 60-second and RSS workload, then a usable million-source baseline and the edit, configuration, and recovery sequences against it. Existing source and publication timings cannot establish either gate.
- **#22** needs bounded extraction residency before first owner staging, less staging transaction amplification, and a publication path that avoids visiting and writing the full selected-owner catalogue for small changes. The bootstrap improvement covers one materialization layer. The measured owner catalogue and CPython attempt show the remaining scaling costs.
