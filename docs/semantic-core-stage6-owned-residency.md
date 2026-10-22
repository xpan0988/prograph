# Stage 6.4 — owned analysis residency

Status: **candidate rejected; accepted extraction retained**. Local and CI
qualification of the retained diagnostics/oracles is pending. This milestone
has not established a lower production peak or qualified either scale gate.

The bounded experiment is finished. No further performance run is planned, and
no other optimization candidate is implemented. The rejected implementation is
preserved as a compact [patch](benchmarks/semantic-core-stage6-owned-residency-rejected.patch),
with measurements in the [receipt](benchmarks/semantic-core-stage6-owned-residency.json).
Raw profiles and temporary indexes remain outside Git at
`/private/tmp/prograph-stage6-4-20261022`.

## Baseline and decision

The initial `main` worktree was clean at
`97bcab797c4c5f838f87bfcfd5e298bbaa6cef0b`, recording accepted runtime
`1790cf4c2a9ec017d92023bfa75ecfd672ac993a`. Its actual Node 20/22/24
[CI run 39730009001](https://github.com/xpan0988/prograph/actions/runs/39730009001)
completed successfully before changes. The accepted sources were archived and
compiled with the same locked dependencies for an independent oracle.

Stage 6.3's 58.864 s / 1,330,896 KiB sample is historical context. The new
same-harness pair and the one permitted confirmatory control give:

| Complete fresh production run | Total s | Owned analysis s | Dependency projection s | Process peak KiB | High-water KiB by owned-analysis return |
|---|---:|---:|---:|---:|---:|
| Accepted + numeric diagnostics, first control | 59.411 | 26.087 | 1.381 | 1,041,104 | 1,041,104 |
| Candidate, subsequently rejected | 58.533 | 25.206 | 1.105 | 1,358,448 | 1,177,504 |
| Accepted + same diagnostics, confirmatory control | 59.191 | 26.466 | 1.889 | 1,173,856 | 1,173,856 |
| Candidate allocation profile; separate overhead | 61.450 | 26.121 | 1.487 | 1,084,816 | 1,084,816 |

The candidate is about 0.88 s faster than the first control, but its overall
peak is higher than **both** ordinary controls. Its owned-analysis high-water
is also not lower than either control. The variation is too large to attribute
small timing or RSS differences confidently. Smaller final heaps, reduced
allocation traffic and reclaimed objects do **not** satisfy the requested peak
criterion. Therefore the candidate is reverted, rather than accepted on a
favorable end-of-phase sample or on its profiled run's lower RSS.

The confirmatory run investigated a specific inconsistency: different initial
heaps and RSS trajectories before the modified code's useful release points.
No second candidate or additional confirmatory loop was attempted.

## Confirmed ownership and lifetime mechanisms

[`deriveOwnedAnalysis`](../src/core/semantic/analysis-passes.ts) retains the
caller's original syntax `AdapterResult` while `writeSyntaxBase` creates a
JSON-normalized copy. In this corpus the normalized base contains 38,489 nodes,
72,656 edges and 46,897 diagnostics. The outer analysis GraphBuilder still needs
the original objects for its final direct-library return. Removing that required
residency would change the API contract and is outside this milestone.

`writeSyntaxBase` partitions normalized payloads by source file, fingerprints,
writes, seals and reads each sealed projection back. The complete normalized
base is returned; the temporary per-file readbacks are not the returned source
of its payloads. Their allocations may remain uncollected, but their local
references are not a long-lived complete readback cache. The base claim maps
remain live with the base view. Normalization creates independent JSON payloads;
a Map or array copy elsewhere usually copies **references**, not those payloads.

Each of twelve passes constructs a fresh input GraphBuilder, copies the base
node/edge claim maps, finds transitive ancestors and merges their projections in
execution order. `GraphBuilder.merge` retains the supplied node/edge objects;
`result()` materializes node, edge and diagnostic arrays. Duplicate graph IDs
preserve the Map's original position and take the last payload. Changing this
order or winner behavior would change accepted output.

`completed` retains each sealed, rehydrated pass projection and claim maps.
`final` separately accumulates references to its node/edge/diagnostic payloads.
At the final dependency pass, the cache holds eleven projections: 2,216 node
entries, 5,764 edge entries and 7,980 claim-map entries. The final graph has
2,216 nodes and 5,740 edges because 24 edge entries overlap by ID; none may be
silently discarded before winner selection. At return the original cache still
has twelve projections, including the empty dependency projection.

All preceding production passes are transitive ancestors of the last dependency
pass. Thus dropping projections only after each whole pass's final consumer
finishes frees almost nothing before that last pass. After input assembly,
cache containers can be dropped, but most payloads are still referenced by that
input or the required final graph. This is a narrower opportunity than the
`completed` map's size alone suggests.

`partitionProjection` JSON-normalizes each adapter result, builds output and
combined input/output node maps, groups by file, builds proof/fingerprint plans,
writes all nodes before cross-shard edges, seals and rehydrates every child.
Its children retain normalized output arrays and writers while the sealed
payloads are rehydrated. The output is much smaller than the full syntax base
here. Eliminating sealed readback would require a separate correctness argument;
it was neither attempted nor accepted.

The dependency pass copies the input node Map and materializes all 78,396 input
edges. It collects 6,541 fact recipes across 202 files, charged at 3,279,788
canonical bytes. That charge is exact for its current bound, **not** the heap
size of the recipes. It sorts files and facts, fingerprints and writes per-file
runs. The full plan and input graph remain reachable through completion.
The existing million-row / 128-MiB work bounds are unchanged.

Writers also reference `RepositorySnapshot`, including the complete source map.
This is shared ownership, not a separate source-text copy per writer. The frozen
selected source text is 7,452,350 bytes. Node/edge payloads are ordinary JSON
observations, not retained compiler ASTs. Compiler/Tree-sitter allocations may
survive elsewhere or await collection; this investigation does not infer their
reachability from RSS.

## Rejected implementation

The patch made only related input/cache lifetime changes:

1. Precomputed the same ordered transitive ancestor sets and final consumers;
   dropped a completed projection after copying it into its last input. Kept
   run numbers separately for ownership queries.
2. Cleared the normalized base arrays/maps after the final input was assembled;
   cleared per-pass input containers and claim maps after their last use.
   Final payloads and the caller's original syntax graph were retained.
3. Replaced `partitionProjection`'s full combined node-map construction with
   output-first then input lookup for edge ownership. Its array-based library
   entry remained available. This removed input-array, tuple-array and Map
   materialization proportional to all input nodes for each adapter pass.
4. Reused dependency input nodes instead of copying the Map; released graph
   references after all dependency recipes were collected; sorted only file
   keys and removed processed file plans rather than retaining every recipe
   array through the end.

Input assembly still required O(base + ancestor output) work. File-owner lookup
changed from an additional O(all input nodes + output nodes) temporary map to
O(output nodes) indexing with expected constant-time fallback to the existing
input Map. The dependency algorithm still collected O(all dependency facts),
with the same fingerprints, sorting, batch boundaries, bounds and write order.
This was not a bounded fact-stream redesign.

No pass declaration, dependency, execution order, version, selector admission,
claim/support rule, snapshot transaction, JSON exporter or Rust traversal was
changed. The complete sealed outputs remained authoritative. Nevertheless the
performance criterion was not demonstrated, so **none of these changes is
active in the committed runtime**. The patch is an experiment, not an accepted
implementation plan or permission to reapply it automatically.

## Memory timeline and interpretation

Instantaneous boundary samples below are MiB; high-water values in the receipt
are cumulative kernel `getrusage` KiB. V8 committed heap is not resident memory.

| Boundary | Control RSS / heap used MiB | Candidate RSS / heap used MiB | Confirmatory RSS / heap used MiB |
|---|---:|---:|---:|
| Owned fingerprint end | 1,016.4 / 539.4 | 1,049.1 / 706.9 | 1,144.9 / 481.8 |
| Syntax staging end | 452.6 / 427.5 | 1,032.8 / 840.6 | 939.8 / 538.1 |
| Boundary binding end | 626.5 / 617.6 | 1,006.8 / 362.4 | 1,054.1 / 740.6 |
| Dependency projection end | 646.3 / 652.0 | 1,019.5 / 390.5 | 1,001.3 / 775.4 |

The first control's final process high-water was first observed at syntax staging
end, after fingerprinting had already reached 1,040,784 KiB. The confirmatory
control reached its final high-water at fingerprinting. The candidate reached
its owned high-water during staging and its overall high-water later, during
bundled TypeScript extraction. These are interval attributions from phase
boundaries; instantaneous peaks between boundaries are not separately sampled.
JSON export did not establish a new high-water in these runs.

V8's cumulative allocation counter rose by 14,419,730,560 bytes during owned
analysis in the first control, 14,244,977,656 in the candidate and 14,350,535,960
in the confirmatory control. The candidate allocated about 167 MiB less than the
first control and about 101 MiB less than the second. These process-wide allocator
counters include transient garbage, JIT/runtime effects and unrelated work in
this phase; they are not retained-size or peak-RSS measurements.

The one allocation profile sampled surviving JS allocations at 32-KiB intervals,
without `global.gc`, `--expose-gc` or a requested collection. In the candidate,
the category attributed by allocation stacks to owned projection code fell from
122,315,120 estimated bytes at final input assembly to 24,079,856 at dependency
planning completion, then 11,562,992 at owned-analysis return. Logical counters
confirmed that its base/cache/input containers were cleared. This supports
shorter residency and natural reclamation of the normalized base, but gives
neither a dominator proof nor a controlled before/after **peak** improvement.
Samples can include objects awaiting collection; stack categories are not
additive subsystem RSS. No raw heap dump is committed.

Desktop browsers and other applications remained active. The same machine had
substantial memory pressure; observed macOS compression/residency behavior and
initial V8 heaps differed. Caches were not flushed. No other benchmark or full
suite was run concurrently with the four production measurements. The sampler's
61.450-s duration differs from the ordinary candidate by 2.917 s, but this is not
an isolated overhead estimate. Numeric checkpoints include their own resource
sampling; inspector checkpoint costs are recorded separately in the receipt.

## Equivalence, failure and recovery evidence

The candidate's focused oracle compared complete ordered pass results and
complete sealed SQL rows against the archived pre-change extractor, including
branching/shared ancestors, repeated IDs with payload overrides, optional JSON
fields, diagnostics, cached shards and a removed dependency. An additional
100 seeded DAGs matched the old recursive visibility algorithm and never
released a projection before its transitive final consumer. The candidate's
focused pass suite also exercised alternative support and removal. All passed
before the candidate was reverted.

The retained oracle tests still compare the accepted implementation independently:
complete sealed facts/claims/provenance, occurrence/source data, groups/supports,
inputs, selectors/gates, projection ordinals, runs, snapshots, partitions and
visibility; complete real mixed-fixture graph/diagnostic bytes; independent
incremental rebuild; old snapshot reads; pass failure; and SIGKILL after final
input assembly followed by successful restart. The source graph is asserted
unchanged. The rejected lifetime scheduler and its scheduler-only test are not
shipped as active code.

For the full frozen corpus, all graph and diagnostics bytes match:

| Output | Bytes | SHA-256 |
|---|---:|---|
| `exports/graph.json` | 102,548,074 | `0183e8f4f580a5d567f21160b8285568de60307a536c415fe6c0ced30001d28a` |
| `diagnostics.json` | 15,529,775 | `631fa69e6fdd6f49b339303a9b454228e05a9f79fb362d9a5a7e6b86bf6503ce` |

The complete 14-table ownership witness matches, including 234,946 facts/claims,
57,693 support atoms, 1,193 sealed runs and their digests. The additional complete
SQL witness checks 76 semantic SQLite tables and 29 legacy SQLite tables,
including FTS data and all projection ordinals. Both schemas, integrity and
foreign keys agree. Only documented clock columns and report content derived
from those clocks are excluded; original report hashes and snapshot bindings
are independently authenticated before comparing their remaining complete data.

**Complete SQL byte equality is not claimed.** The legacy `q_meta.generation`
row is produced by `randomUUID()` on every materialization, including unchanged
accepted-runtime runs. This is not clock-derived. Both raw UUIDs and whole-table
hashes are preserved as an explicit unequal observation. All other rows in that
table and all other tables agree under the stated clock exclusions. No graph
bytes, fact/claim IDs, supports, ordering, confidence or source anchors are
normalized. This known non-clock volatile row prevents a literal all-SQL-values
identity claim under the requested exclusion rule; it is not used to excuse a
semantic mismatch or accept the rejected optimization.

Source freshness is `fresh`, with 4,644 observed semantic inputs checked and no
changed inputs. The existing complete compatibility and semantic witnesses are
retained. Full local regression, recovery, typecheck/build and exact-commit CI
results will be recorded here after execution. No assertion or acceptance gate
has been disabled or relaxed.

## Retained diagnostics and reproducibility

`measureAnalysisCollections` evaluates collection counts only when an observer
is installed. It emits numbers, never measured objects; observer/count failures
cannot participate in publication. The normal extraction algorithm is unchanged.
The memory runner adds three allocation checkpoints inside the owned pipeline.
The CI baseline helper pins `97bcab7`, and its oracle is required to execute.

The corpus is the same dirty frozen Pastey capture, original repository commit
`8714e1ee57e00b70fdf1e03d6c182a8ef984ded0`, not reconstructible from that commit
alone. All 421 raw file hashes and recorded dependency hashes matched. The
selected inventory is 315 files / 7,452,350 bytes; code inventory is 261 files /
6,535,832 bytes / 173,142 physical lines. Raw inventory SHA-256 is
`046e71411c366bd85acffc12a83cfc80590016e0223629aac9ac11f454ab6e6b`;
selected inventory is
`729c1eb199f09ccd9739634699bdc004388402544fcc8806c674ba471b6365b8`.
The source `node_modules` still resolves to `/Users/xiyuanpan/Pastey/node_modules`.
All recorded SDK tree fingerprints were verified before measurements, including
actual managed-provider dependencies later used for qualification.

Host: Apple M5 / Mac17,3, 16 GiB, macOS 26.5.2 / Darwin 25.5.0 arm64,
Node 25.9.0 with `--max-old-space-size=2048`. Compiler, grammar, SQLite and SDK
hashes are in this receipt and the referenced Stage 6.1 complete pin record.
The accepted Rust source SHA-256 remains
`2e80243e80bc424a53be87c5757037465f8cdc43e0628b9e9b3379d2bf47196d`.

Reproduction requires the frozen content and authenticated dependencies:

```sh
npm run build:node
node scripts/prepare-semantic-baseline.mjs /private/tmp/prograph-baselines owned
# Set PROGRAPH_TEST_OWNED_BASELINE_RUNTIME to the returned directory.
npx vitest run tests/owned-residency.test.ts tests/analysis-diagnostics.test.ts
node --max-old-space-size=2048 scripts/semantic-profile.mjs phases SOURCE FRESH_INDEX REPORT.json
node scripts/semantic-profile-verify.mjs SOURCE FRESH_INDEX VERIFY.json
node scripts/semantic-export-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SOURCE OWNERSHIP.json
node scripts/semantic-owned-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SQL.json
```

The first/confirmatory controls use accepted source plus the retained numeric
checkpoints. The rejected patch applies on top of those checkpoints, as checked
with `git apply --check`; compile before the single candidate measurement.
Its same corpus and fresh-output command used `phases`; the separate allocation
run used `memory`. Use independent output directories, serial processes and the
same heap flag. Do not use an existing index as a fresh baseline. The recorded
four-run sequence is complete; these instructions do not authorize another
exploratory benchmark loop.

## Remaining work and limits

The normalized base and original source graph, sealed-output rehydration,
complete final GraphBuilder, source inventory/fileContents and compiler/AST
lifetimes remain as accepted. The candidate shows that late container release
can make large objects collectible while leaving an earlier high-water intact.
It does not justify removing sealed facts/readback, changing ownership or
streaming arbitrary facts under a different fingerprint/order contract.

The next independently authorized optimization should investigate the already
profiled canonical fingerprint materialization: both ordinary controls reach
their high-water near fingerprinting/staging, before the rejected late releases.
The candidate's later TypeScript peak also requires separate lifetime evidence;
no compiler strategy change is recommended as proven by this experiment.
Do not sum possible savings from these overlapping allocations. Expected peak
savings from reapplying the rejected patch remain **unestablished**.

Shared in-process Core/compiler/Tree-sitter/SQLite memory is not partitioned.
External/native semantic providers are not executed by this frozen production
corpus; their qualification tests are separate evidence. No Core-only RSS is
computed by subtraction. Neither the 60-second qualification nor the Core-only
1-GiB gate, million-line scale, native resource quotas or broader environment
support is accepted. Stage 6.4 ends with this rejection and evidence; further
optimization requires separate authorization.
