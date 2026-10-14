# Semantic Core 2.0 — Step 1 engineering report

**Scope:** Foundation and TypeScript vertical slice, starting at `c61f293e5a20404d5c9c4932f2ad31c6d13fbfcb`. This is the implementation of the Phase A gate in [semantic-core-2.md](semantic-core-2.md), with minimal ownership and publication introduced immediately. Step 2 has not started. The attached continuation prompt describes Step 2; its all-language/default-activation acceptance criteria are not claimed here.

**Versions:** Package remains `0.3.0`; legacy graph schema remains `1.2.0`. The additive semantic database declares Format `2`, storage schema `2.0.0-step1`, common predicate version `1`, TypeScript mapping version `1`, call projection version `1`. This is a provisional physical schema, not a stable external interchange contract.

**Result:** Step 1 is functionally closed after the 14 October 2026 engineering review below. The one-second publication target remains **unmet**, with an explicit scale limitation. Whole Semantic Core 2.0 and large-repository production qualification are **not complete**. Step 2 implementation proceeds separately from this milestone.

## Architecture actually shipped

```text
Existing repository scanner / adapters / overlays
    |                         |
    |                  full legacy bridge partition
    |                         |
    +--> root TS compiler --> immutable symbols / occurrences / facts
                               + independent provider claims
                               + interned provenance / support groups
                                      |
                         staged, owned partition runs
                                      |
                        supported static-call projection
                                      |
                         transactional snapshot publication
                                      |
             semantic.sqlite --> bounded CLI / MCP / HTTP navigation

Existing GraphNode/GraphEdge --> graph.sqlite + exports --> existing UI/APIs
```

`src/core/semantic/{model,coordinates,schema,store,typescript,query}.ts` owns the foundation. `analyze.ts` and the existing isolated-file path in `sync.ts` invoke it. The TS adapter exports its existing project constructor; its legacy extraction behavior stays intact. New semantic facts come directly from compiler ASTs/checker bindings, never from legacy call edges. Existing adapters are retained verbatim inside one `legacy/full` owned partition; no per-file ownership is guessed from their evidence.

This intentionally uses **two databases during the compatibility period**. `graph.sqlite` remains authoritative for the old graph domain. `semantic.sqlite` is authoritative for the migrated navigation endpoints. They are not one atomic cross-database release. Semantic publication precedes legacy persistence/export. If interrupted between those operations, snapshot metadata and `latestAttempt.matchesSnapshot` expose disagreement; semantic results always say source freshness is unchecked. JSON exports are not the source of semantic membership. A future default activation must unify publication/catalog handling before claiming a single coherent all-domain release.

The current pipeline still retains repository text maps and legacy in-memory graph arrays. There is no worker scheduler, streamed external ingestion, generalized pass engine, or fine-grained semantic invalidation in this step.

## Identity, facts and coordinates

Canonical JSON sorts object keys using locale-independent ordering, preserves array order, and rejects undefined/non-finite values. Persisted semantic keys use SHA-256 with an explicit `sc2:<kind>:` prefix. Legacy objects pass through their existing JSON serialization semantics before bridge hashing, removing optional undefined fields.

Entities have immutable identity records with collision checks. Symbol identity combines repository identity, root context, lexical/name ancestry, compiler symbol flags and discriminators where needed. Overload declarations share their compiler symbol; distinct block declarations and static/instance members remain distinct. Local binding/lambda identities use source-position discriminators and can move after earlier edits. Checkout movement, package equivalence, merged declaration order, and cross-provider identity reconciliation are not qualified here. External declarations can create identity shells without active declaration assertions.

An occurrence is a specialized row, not a generic graph node. Its identity includes file, source digest, context, half-open UTF-8 byte range and role. Public line/column coordinates are one-based UTF-16; byte positions are zero-based. Conversion rejects a boundary inside a surrogate pair and handles LF, CRLF, CR and Unicode line separators. Definitions, references, imports, calls, module anchors, execution scopes and JSX observations use roles rather than six independent node classes. Source revisions may retain overlapping anchors with different roles.

Registered predicates are `common.Declaration`, `Definition`, `Reference`, `Import`, `CallSite`, `CallTarget`, `CallSummary`, `Facet`, plus `legacy.Node` and `legacy.Relation`. Endpoint kinds, occurrence context, run context/input fingerprint, confidence, provenance and payload limits are validated. Value payloads are capped at 64 KiB, provenance/coverage at 4 KiB, support at 32 alternatives × 32 required atoms. The registry provides common endpoint contracts; exhaustive language-native value schemas belong to Step 2.

A fact identity separates its logical observation key from target/value content. A claim adds provider provenance, confidence and support identity. Identical facts can have several independent claims; no last-writer merge overwrites a provider's assertion. Trusted conflicting `CallTarget` claims at a site exclude that site from trusted aggregated calls while preserving the conflicting claims for inspection. This is the foundation's explicit conflict rule, not a universal reconciliation engine.

## TypeScript provider and project context

The slice reuses `createProject(snapshot)` and its root tsconfig/jsconfig/inferred compatibility behavior. It hashes the root configuration and compiler version into context; the run fingerprint includes scanned inputs and actual loaded compiler sources, including ambient libraries. Loaded source digests are recorded as inputs. Bundled ts-morph standard libraries are virtual compiler inputs: their loaded text/version is fingerprinted, not incorrectly opened as physical `/node_modules/...` paths. Physical loaded inputs and scanner inputs are checked again before sealing. A mismatch fails the attempt and retains the previous snapshot.

This is **one root project**, not build discovery. Nested projects, complete extends/references/config dependency closure, package environments and target variants are not modeled as first-class plans. Recorded dependency inputs do not yet drive sync planning. External environment changes outside scanner inventory require explicit analysis; semantic queries never assert source freshness from a matching manifest alone.

| Surface | New semantic database | Preserved legacy domain |
|---|---|---|
| TS/JS/TSX/JSX | Compiler declarations, supported definitions/references/imports, static call sites/targets, JSX facets; partial coverage | Existing compiler-backed graph |
| Rust | Full-partition bridge only | Conservative Tree-sitter resolver |
| Python, Java, C, C++, Go, C# | Full-partition bridge only | Existing syntax frontends/inference |
| React | Exact JSX observations in TS facts | Existing component/render/callback graph |
| Tauri / schema boundaries / Knowledge Overlay | Full-partition bridge only | Existing behavior, IDs, namespaces and confidence |

Named declarations, overload locations, nested execution scopes and module definitions are represented. Declaration-only overloads remain definition-navigation locations with body information, not invented execution bodies. Identifier references are separate from call observations. Passing or returning a function creates references without calls. A call requires compiler signature evidence; `any`, missing signatures and compiler errors overlapping the call leave an exact call-site observation with a bounded unresolved diagnostic, without a trusted target. Method/constructor dispatch is static binding; it does not enumerate runtime implementations. Accessors, computed declarations, complex merged symbols, exhaustive native types and runtime dispatch are not claimed complete.

TS coverage is always `partial` for applicable sources. With the adapter disabled or no TS sources it is `unavailable`; indexing exceptions produce `failed` in the manifest and a legacy warning diagnostic. Diagnostics retain at most 200 messages of at most 2,048 characters. Query coverage distinguishes an empty result from incomplete analysis. There is no fake “precise polyglot” provider promotion.

## Storage and derived support decisions

The source schema is [schema.ts](../src/core/semantic/schema.ts). It uses integer joins, immutable content keys, typed navigation columns and cold JSON values, rather than storing repeated evidence/provenance JSON on every edge.

| Tables | Responsibility |
|---|---|
| `sc_meta` | Format/schema and active snapshot pointer |
| `sc_entities`, `sc_symbols` | Identity shells and symbol lookup |
| `sc_sources`, `sc_occurrences` | Revision digests and typed ranges |
| `sc_facts`, `sc_claims`, `sc_provenance` | Immutable assertions, independent claims, interned producer explanation |
| `sc_groups`, `sc_supports` | Interned OR alternatives of AND claim/selector requirements |
| `sc_runs`, `sc_owned`, `sc_inputs`, `sc_run_selectors`, `sc_diagnostics` | Partition state, ownership, input inventory, selectors, bounded diagnostics |
| `sc_snapshots`, `sc_partitions`, `sc_active` | Published manifests and eligible claim membership |
| `sc_navigation`, `sc_calls`, `sc_visible_symbols` | Snapshot-specific indexed projections |

Important indexes are `(snapshot,relation,object,occurrence,claim)` for definition/reference navigation, corresponding subject adjacency, `(snapshot,occurrence,claim)` for occurrence membership, `(snapshot,callee,caller)` for callers, `(snapshot,caller,callee)` for callees, and `(snapshot,name,entity)` for symbol lookup. Reverse ownership, support and resource-input indexes are available for future planning. There is no universal native fact table family in this slice.

Call summaries have an AND support group containing the call-site claim, compiler-target claim and inventory selector digest. Other experiments exercise multiple OR alternatives: losing one required input disables that alternative, while a different valid alternative keeps the derived claim visible. Reordered/duplicate support lists intern to the same group. A retained incoming reference can keep a symbol shell, but never keeps an obsolete declaration assertion alive.

Eligibility is computed during publication by removing unsupported claims to a fixed point, with a 64-round depth guard. References to unknown support claims are rejected before publication; immutable claims can only refer to already stored claims. Selected selector environments must agree. This is a supported call projection with a versioned ownership key, not the Step 2 general pass DAG.

**Measured choice:** retain normalized occurrences/provenance and interned supports. The equal-information layout experiment at one million rows used 273.76 MB for JSON occurrences with repeated provenance versus 27.12 MB for typed occurrence rows plus one 4 KiB provenance row. Repeating one two-claim-plus-selector support list used 315.88 MB flat versus about 9.05 MB for group/reference storage. That support shape is an upper bound on reuse benefit. The production fixture has **10,000 distinct groups and 30,000 atoms**, so interning does not magically compress unique per-call-site dependencies.

The production database is much larger than the isolated normalized payload experiment because it also stores identity canonical records, content hashes, facts, claims, ownership, snapshot membership and indexed projections. At one million generated sites it reaches 1.486 GB. Do not extrapolate the isolated 27 MB payload into a total-index size claim. Cold canonical identity duplication and index amplification merit a matched compact-layout experiment before all-language lock-in. No database-engine replacement is justified by this measurement alone.

## Publication, ownership and recovery

An indexing unit begins `staging`, accepts bounded transactional batches, and seals with coverage. Sealed runs reject mutation. A snapshot selects one sealed run per partition. Publication validates the expected parent, creates membership, prunes unsupported claims, builds projections and changes the active pointer in **one SQLite transaction**. It uses WAL and foreign keys. Snapshot content keys include sorted claim keys, partition contexts/input fingerprints and selectors. Query requests use a read transaction and pinned snapshot IDs/cursors.

Failed extraction/batches/sealing/publication retain the active snapshot. The entity lookup cache clears on rollback so rolled-back IDs cannot leak into later writes. Competing publishers fail their parent comparison. A fault after commit can report a failed attempt even though the new snapshot exists; consumers see the mismatch instead of silently trusting cache exports.

Actual subprocess crash probes terminate the built publisher before seal, before publication, during the publication transaction and immediately after commit. The first three retain snapshot 1 and its prior assertion; after commit snapshot 2 has exactly the replacement assertion. All cases retain baseline history and pass `PRAGMA integrity_check`. A corrupt database is refused without rewriting it. Separate tests cover injected rollback, unsealed publication, schema refusal, independently owned provider claims, selector replacement and deletion with retained historical navigation.

Semantic sync currently replaces the **whole root TS project, full legacy bridge and call projection**. The existing isolated-file legacy sync path remains enabled and reports its existing incremental behavior, while semantic work remains project-wide. The oracle caught stale root TS inventory telemetry after an isolated addition; sync now refreshes that count and prevents old manifest adapter-run metadata overwriting refreshed counts. No narrower semantic invalidation was enabled.

Explicit `pruneHistory(keep)` removes older snapshot memberships/projections and unused run bookkeeping. It does **not** collect immutable facts/claims/entities/support groups; reachability GC is not yet qualified. Retention is not automatically invoked. Repeated edits therefore grow disk use. Abandoned staging runs remain invisible until explicit maintenance. This is adequate for the foundation experiment but not long-lived watch/monorepo production qualification.

## Bounded agent APIs and compatibility

New operations: `status`, `find`, `definition`, `references`, `callers`, `callees`, `occurrence`, `explain`.

```bash
prograph analyze . --output /tmp/my-prograph-index
prograph semantic find SemanticStore --repo . --index /tmp/my-prograph-index --format json
prograph semantic definition <sc2-symbol-key> --repo . --index /tmp/my-prograph-index --format json
prograph semantic references <sc2-symbol-key> --repo . --index /tmp/my-prograph-index --limit 20 --format json
```

The MCP tool is `query_semantic`; HTTP is `GET /api/semantic/:operation?input=...`. CLI supports `--cursor`, `--snapshot`, `--max-bytes`; corresponding MCP/HTTP parameters use `cursor`, `snapshot`, `maxBytes`. Both directory roots and a supplied `graph.sqlite` path resolve to the sibling `semantic.sqlite`. Semantic keys differ from legacy graph IDs; aliases/default API migration are not shipped.

Find currently uses exact names and returns declaration evidence; it is not fuzzy search. Definition/reference pages use keyset occurrence pagination and sample one claim per occurrence. Callers/callees return distinct symbols, call-site counts and a sampled evidence claim. Occurrence queries return stored ranges and revision evidence. Explain returns provenance, fact values and bounded support rows. Status lists selected partitions. All return snapshot/variant/scope, coverage/gaps, truncation and snapshot-only freshness; evidence queries communicate confidence. Failed/latest manifest attempts are exposed, including whether their snapshot matches the requested snapshot.

Defaults are 50 items and 32 KiB; hard caps are 200 items and 128 KiB, with a 4 KiB minimum byte budget. Navigation fetches at most `limit+1` adjacency candidates before bounded payload lookups. Metadata reads at most nine partitions; explanations inspect at most 201 support rows. Oversized coverage is summarized and labeled truncated. Query work reports candidate/support/metadata rows, returned rows and absence of global graph materialization. These counters describe explicit SQL candidate fetches, **not all SQLite VM steps**. SQL plans supply complementary evidence of indexed access. There is no qualified hard wall-time deadline or cache-evicted cold latency distribution yet.

Cursor fingerprints bind query/input and retained snapshot. Reusing a cursor for another query/snapshot is rejected; expired snapshots require restarting pagination. Byte truncation can reduce a page below the item cap. An individually oversized explanation may produce an empty truncated response; it does not claim no semantic fact exists.

Existing commands/tools/routes/UI remain graph-domain behavior. Their broader global materialization is not removed in Step 1. Old graph-only indexes remain readable; reanalysis adds the semantic database without changing graph IDs/schema/package version. Unsupported semantic storage/schema versions are refused before schema writes, preserving the database. A failed semantic attempt does not prevent useful legacy graph persistence. No implicit installs, external builds or discovered command execution were introduced.

## Validation and measurements

Local environment: macOS arm64, Apple M5, 10 CPU cores, 16 GiB RAM, Node `v25.9.0`, SQLite `3.53.1`. The active ts-morph compiler reports TS `5.9.2`; the build/typecheck package is separately pinned by the existing lockfile. Raw storage/query/recovery evidence and compiled foundation digests are in [benchmarks/semantic-core-step1.json](benchmarks/semantic-core-step1.json).

| Final synthetic workload | 100k generated sites | 1M generated sites |
|---|---:|---:|
| Stored occurrences, including declarations | 101,001 | 1,001,001 |
| Write time | 6.088 s | 197.133 s |
| Publication | 0.303 s | 4.635 s |
| Checkpointed production database | 149.86 MB | 1,486.42 MB |
| Whole benchmark process peak RSS | 150.9 MiB | 286.2 MiB |
| Warm definition p95 | 0.151 ms | 0.116 ms |
| Warm reference p95 | 1.114 ms | 1.112 ms |
| Warm callers p95 | 0.114 ms | 0.130 ms |
| Warm callees p95 | 0.051 ms | 0.054 ms |

The fixture uses 1% call sites, 1,000 distinct callers and one high-degree target, 1,000-row staging batches, one published snapshot and two provenance rows. Reference/caller pages inspect 51 adjacency candidates. The 32 KiB byte budget yields 48 reference evidence rows and 50 caller summaries. Query plans use covering adjacency/caller/occurrence indexes without temporary sort trees for measured candidate paths. Warm p95 uses 30 samples; first-connection reads are separately recorded, **not called OS-cache-cold**. RSS includes the subsequent isolated layout experiment, and excludes compiler/provider processes because this workload invokes none.

An earlier exploratory run measured 174.294 s writes and 12.801 s publication at 1M; its first seconds overlapped self-analysis. Final measurement also overlapped later test execution briefly. Variation is retained rather than selecting the best number as a reliable service promise. Size growth is 9.92× for the 10× generated-site sweep, excluding history. Write time grows disproportionately; random content-key indexes, transaction/checkpoint I/O and projection/membership copying are investigation targets. This is not a controlled multi-run throughput distribution.

**Unmet/unqualified performance gates:** 1M publication exceeds one second in both runs, and synchronous `better-sqlite3` work can block the API event loop. Concurrent query latency during a large publication is unqualified. 100k/1M/10M LOC provider analysis, SCIP throughput, 10M/50M occurrence sweeps, cold-cache distributions, large watch histories, disk exhaustion and Windows/Linux publication behavior were not measured. No claims are made for those scales.

Validation commands:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
node scripts/semantic-benchmark.mjs 100000 /tmp/step1-100k.json
node scripts/semantic-benchmark.mjs 1000000 /tmp/step1-1m.json
node scripts/semantic-recovery.mjs /tmp/step1-recovery.json
prograph analyze . --output /tmp/prograph-step1-self
prograph semantic find SemanticStore --repo . --index /tmp/prograph-step1-self --format json
```

The full legacy suite covers TS, Rust, React, Tauri, polyglot syntax/schema boundaries, Knowledge Overlay, custom roots, status/sync and watch contracts. Foundation tests add coordinate/identity validation, independent claims, support logic/conflicts, SQL plans and bounds, staged failures/schema refusal, pinned history, declaration deletion, overloads/nested calls/reference-only uses, malformed project degradation, JSX facets, scoped name collisions, graph-only migration, MCP and HTTP. The deterministic edit oracle compares active claims (including the bridge), call projections and coverage against clean same-repository rebuilds through add/modify/rename/delete/config changes. This is not the randomized all-provider Step 2 oracle.

Self-analysis uses the actual ProGraph working tree rooted at the stated baseline, including existing mixed-language fixtures. CLI semantic symbol navigation was exercised against a custom root. Browser smoke testing used the built localhost UI: architecture rendered 75 summaries, symbol search opened `SemanticStore` with its evidence inspector, and no captured browser console errors were returned. Source changes during testing visibly produced the existing stale-index warning. UI source was not changed and no occurrence arrays were fed into React Flow. No external repositories or precise non-TS backends were used; no third-party benchmark is substituted for local evidence.

The package's `lint` script delegates to typecheck; there is no independent formatter/linter configured. `git diff --check` checks whitespace. Complete test/build outcomes are recorded in the final delivery and raw evidence artifact. Storage write/publication/recovery was exercised on macOS only.

Final local suite: **69 tests passed in three files**, comprising all 54 legacy tests and 15 Semantic Core tests. Build, Node/UI typecheck and the configured lint command passed. Four actual publisher crash probes plus corruption refusal passed. The changes are delivered in the working tree on `main` above the stated starting commit; no commit or push is implied by this report.

## Step 1 gate disposition

| Gate from the design's Phase A | Disposition |
|---|---|
| Preserve existing TS/Rust/React/Tauri/polyglot contracts | Passed local legacy suite; graph schema/IDs retained |
| Deterministic identity/fixture round trips and Unicode ranges | Passed; positional local identities explicitly limited |
| Independent provider claims, no last-writer overwrite | Passed storage coexistence/conflict tests |
| Minimal ownership, AND/OR supports and selector invalidation | Passed unit tests and supported TS call projection |
| Staging, atomic semantic publication and historical recovery | Passed fault injection and actual process crash probes |
| Bounded definition/reference/caller slice | Passed API/MCP/CLI checks, byte/candidate bounds and indexed plans |
| 1M synthetic occurrence/provenance/support measurement | Completed; raw results retained |
| Proposed <=1 s large publication/isolation target | **Unmet:** 4.635 s final / 12.801 s exploratory; worker isolation absent |
| Full Core 2.0 / Step 2 acceptance | **Not attempted:** explicitly outside this step |

Review the measured physical layout and publication costs before converting more producers. SQLite remains a reasonable foundation, but the current full snapshot/projection materialization, canonical identity duplication and synchronous writer are not qualified as the final monorepo architecture. Missing build discovery, SCIP, native language predicates, generalized passes, default activation, reachability GC and semantic incremental planning were left for Step 2; its accepted milestones must document actual implemented coverage separately.

## Closure review — 14 October 2026

The current uncommitted implementation was inspected and the full suite rerun. Two correctness fixes accompany closure: an explicit undefined expected parent now means “no snapshot existed when planning”, so a competing first publisher cannot silently rebase that plan; status pagination applies its cursor before the SQL limit, with a `(snapshot,run)` index. Sealing and cached digest writes are transactional, including a regression that injects a failing digest write. The suite now passes **71 tests** (54 legacy, 17 foundation), with build and configured lint/typecheck passing. Actual publisher crash/corruption probes were rerun and pass.

Publication instrumentation separates content hashing, membership, support eligibility, navigation, symbols, calls, and pointer/commit. The original implementation made ten passes over active claims. The reviewed implementation makes one navigation pass. Sealed partition roots cache sorted claim keys, selectors, inputs and coverage; snapshot identity `snapshot-v2` combines those roots. Existing uncached sealed runs are handled lazily; historical snapshot IDs and memberships remain readable. Sealing time is explicitly measured, not hidden as an apparent publication speedup. The additive `sc_run_digests` table is removed with unused run bookkeeping during maintenance.

SQLite's observed implicit setting was WAL `synchronous=NORMAL`. The store now explicitly requests **FULL** (`2`), preserving atomic transactions and strengthening durability. Cache size and WAL checkpoint threshold were not relaxed. Process-crash probes are not a power-loss hardware test. The legacy graph database retains its established behavior.

| Measured stage | Profiled original, 1M | Reviewed, 100k | Reviewed, 1M |
|---|---:|---:|---:|
| Writes | 215.153 s | 6.251 s | 234.328 s |
| Seal | Not separately instrumented | 0.055 s | 1.902 s |
| Publication, including commit | 5.971 s | 0.156 s | 5.850 s |
| Content hashing during publication | 1.172 s | 0.0001 s | 0.0001 s |
| Membership | 0.352 s | 0.023 s | 0.474 s |
| Navigation | 4.135 s | 0.103 s | 4.605 s |
| Pointer and commit | 0.227 s | 0.023 s | 0.293 s |
| SQLite synchronous | NORMAL | FULL | FULL |

Raw evidence is in [semantic-core-step1-review.json](benchmarks/semantic-core-step1-review.json); the September results above are retained. This is not a controlled statistical speedup claim: the new 1M run still misses the target, and seal plus publication is 7.752 s. The immutable-root cache avoids rehashing unchanged partitions on later snapshots, while the full materialization still copies over a million rows into several indexed structures. A separate same-corpus navigation insertion-order experiment rejected an explicit sort: unsorted took 6.198 s and sorted 8.842 s, each producing the same 1,022,002 rows. Neither is substituted for the full publication benchmark.

**Closure decision:** accept the tested foundation and TypeScript slice, with the proposed one-second scale gate explicitly outstanding. Do not promise sub-second 1M snapshot publication or concurrent API responsiveness during synchronous publication. Achieving that target requires measured projection reuse/deltas and worker isolation in the authorized Step 2, rather than weakening durability or reporting only pointer activation. The architecture remains unchanged. Legacy schema `1.2.0`, package `0.3.0` and existing contracts remain preserved at this milestone.
