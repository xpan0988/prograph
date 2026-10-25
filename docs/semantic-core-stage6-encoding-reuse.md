# Stage 6.6 — operation-scoped canonical encoding reuse

Status: one adjacent-provenance reuse candidate is retained for its measured
allocation benefit, pending complete local and exact-commit CI qualification.
No other candidate was implemented. Neither scale gate is qualified.

## Baseline and measurement boundary

The initial checkout was clean `main` at `0e668fb08f9d8046d5c730848b2c2fc7d7cdaf05`,
the accepted Stage 6.5 closure. All actual Node 20/22/24 jobs in
[run 40179220961](https://github.com/xpan0988/prograph/actions/runs/40179220961)
passed. Production extraction includes Stage 6.5's final capacity guard. The
Stage 6.4 lifetime patch remains inactive. Rust, JSON export, canonical encoding,
identity/schema versions, pass contracts and durability are unchanged.

All 421 frozen source hashes, dependency hashes, the source node_modules realpath
and nine tool trees authenticate against Stage 6.5/6.1. This is the original
173,142-line capture at the same path. Commands use the repository CWD, Node
25.9.0 and `--max-old-space-size=2048`, serially without competing heavy work.
Raw reports/indexes remain outside Git in `/private/tmp/prograph-stage6-6-20261025`.

The opt-in `semantic-encoding-audit.mjs` rewrites **an external compiled build
copy**, leaving recursive `canonical` unchanged. Prefix edits preserve argument
evaluation. It maintains fixed call-site/kind counters, and at most three strings
within the current synchronous `addFact`; it retains no payload objects or
cross-operation encodings. The ordinary phase harness supplies process metrics.
Its smoke comparison preserves complete graph/diagnostic bytes and stable data
in all 76 semantic / 29 legacy tables, using existing clock/UUID rules.

The one audited accepted-runtime analysis measured **77.030725 s**, process
high-water **1,180,704 KiB**, with 40,641 nodes / 78,396 edges / 46,940 diagnostics.
This is an instrumented observation, not a clean production timing or a scale
qualification. Stage 6.5's 65.000-s pre-guard observation is not a control here.

## Phase A audit and decision gate

The build audit identifies 113 direct call sites in 28 modules. The run executes
**3,260,773 direct canonical calls**, producing **1,115,935,038 UTF-8 bytes**.
Recursive visits and the bounded `canonicalDigest` path are distinct; they are
not counted as additional direct calls. Summed synchronous encoding wall is
3,986.116 ms, including native/GC residence, not an exact CPU clock.

The relevant consumers separate as follows:

- `SemanticStore.addEntity` produces SQL text and compares it for collisions;
  this encoding is required. Fact values produce SQL text and are embedded as
  **strings** in fact identities; these are different encodings, not a duplicate
  that can be removed by substituting raw JSON.
- `validateFact` encodes provenance/value for the existing 4-KiB / 64-KiB limits.
  `addFact` encodes them again later. All limits and validation order must remain.
- `addFact` immediately encodes provenance for persistence and again inside
  `semanticKey("provenance", ...)`. These two observations are adjacent.
- Source/pass/shard fingerprints and node proofs bind different wrappers and
  inputs. Readback byte charging validates the sealed source of truth. Their
  required work must not be conflated with repeated traversal of nested payloads.
- Support and dependency sorts use canonical text for deterministic ordering.
  Projection normalization is a separate compatibility contract. Store sealing,
  reports and snapshot digests bind persisted observations and remain required.
- Stage 6.5's full-graph hash uses `canonicalDigest`; all string-producing and
  quota/collision consumers retain `canonical`.

**Ranking recorded before prototype implementation:**

| Rank / candidate | Measured repeated work | Immutability and proposed lifetime | Expected benefit and risks |
|---|---|---|---|
| 1. `store.ts:addFact`, adjacent provenance JSON/key (line 206) | 234,946 exact equal-string pairs; 72,341,290 repeated bytes; second encoding 217.550 ms wall | Reuse the already-required JSON only between these adjacent expressions, when the fact's provenance property and its flat string record are descriptor-proven data without callbacks. Retain the original path for getters/proxies/exotic values or changed encoding intrinsics. | At most this encoding wall is removable; raw output traffic ceiling 72.34 MB. Actual allocation benefit and guard cost remain unproven. No new strings need survive beyond existing persistence. Getter evaluation, mutation observation and error order are blocking risks without a conservative fallback. Selected for **one** targeted prototype profile, not yet for integration. |
| 2. `model.ts:validateFact` / `store.ts:addFact` value (134 / 201) | 234,946 equal pairs; 76,667,372 repeated bytes; persistence encoding 353.565 ms wall | Caller data crosses validation, endpoint reads and other fact-property accesses. Equality in this run does not prove a reusable API boundary. | Larger raw ceiling but requires a broader purity/proof mechanism or new internal API. Risks quota bypass, changed callbacks/errors and stale payloads. Deferred; not combined with candidate 1. |
| 3. `analysis-passes.ts:dependency-projection` sort (173) | 67,396 comparator encodings, 33,607,534 bytes / 101.493 ms; 6,541 planned recipes | Recipes are internally constructed from normalized/sealed data. Per-file decorated keys could replace comparator encoding. | Smaller CPU ceiling; extra retained key strings during sorting can raise peak residency. Comparator count alone is not sufficient benefit. Not selected. |
| 4. `projection-shards.ts:partitionProjection` content (47 / 49) | 357 content charges, 5,907,154 bytes / 24.179 ms, then a distinct fingerprint wrapper of 6,307,993 bytes / 24.326 ms | Content is privately normalized, but prefix contracts and externally supplied endpoint evidence need separate proof. | Small measured ceiling; manual canonical splicing would add identity-construction complexity. Not selected. |

Provenance validation/persistence also matches in all 234,946 operations, totaling
72,341,290 bytes, but that longer interval is **not** the selected reuse. All
comparisons use actual complete returned strings rather than object identity.

The initial allocation sampler (one root call in 512) is **not usable as canonical
allocation attribution**. A calibration of 128 empty `getHeapStatistics` pairs
reports 856–261,760 bytes of counter movement per pair (mean 144,159). Observer
allocation and V8 accounting dominate these small encodings. The raw samples are
retained and marked inconclusive, not extrapolated or silently subtracted. The
targeted profile uses only aggregate boundary counters and independent CPU and
allocation sampling. Encoded bytes are not heap allocation or retained size.

## Selected implementation and lifetime proof

`SemanticStore.addFact` replaces only its adjacent provenance JSON/key expressions
with `encodeFactProvenance`. Validation, endpoint reads, the fact insert/select,
provenance insert/select, support work and claim/owner writes retain their order.
`validateFact` still performs both original encodings and byte-limit checks.
Fact values, entity collision checks, support normalization, sorting and all
other encodings are unchanged. `canonical()` and `canonicalDigest()` are unchanged.

The new small result contains the already-required encoded string, the same
SHA-256 provenance key and a diagnostic branch flag. The helper retains neither
encodings nor caller objects after the operation. Module-level references describe fixed
host intrinsics, not semantic payloads or object-identity cache entries.

Reuse requires an own data property on a non-proxy fact, containing a plain or
null-prototype record whose enumerable own fields are string data properties.
The guard reads descriptors, without invoking input getters. It conservatively
checks encoding intrinsics, array species/iteration and iterator-close hooks;
changed hooks retain the original path. Descriptor fields themselves must be
own fields, avoiding inherited descriptor getters. No caller object is frozen.

Within this interval there is no await, SQL, user callback or other fact-property
read between the first encoding and hashing. Primitive strings cannot mutate.
Therefore the second encoding would have identical bytes. Getters, proxies,
exotic/nested values, sparse arrays and unsupported data retain both original
observations and rejection behavior. In particular, the implementation preserves
the legacy case where a getter returns *different* provenance on the two reads;
it does not silently repair or normalize that behavior.

The old work is three provenance encodings per ordinary fact (validation, SQL,
identity). The new path does two plus O(k) descriptor checks for k fields and a
fixed host guard. Output buffering is the existing persistence string, at the
existing quota/observation boundary. There is no cross-fact/run/snapshot reuse.

## Bounded experiment and results

Exactly three complete analyses ran: the Phase A audited baseline, the one
permitted confirmatory ordinary control, and the ordinary final candidate. One
targeted encoding-region profile pair ran in separate serial processes. No
performance run remains planned. The confirmatory control resolved a specific
measurement problem: per-call allocation observation adds counter traffic, so
the audited run cannot be the ordinary production allocation control.

The targeted input is 1,266 actual persisted provenance groups, weighted to the
234,946 observed `addFact` operations. Preparation verifies every complete JSON
string and key against the accepted SQL before profiling. The loop compares both
complete outputs on every operation. Their common key-sequence SHA-256 is
`cded600dfcf561d2817843d9ac84017c49a79b006ef1f48baae6b4039e0f09bc`.

| Targeted encoding-region profile | Reference | Prototype |
|---|---:|---:|
| Wall | 541.301 ms | 429.077 ms |
| Process CPU | 562.361 ms | 461.287 ms |
| V8 allocation traffic | 1,645,572,360 B | 1,362,321,400 B |
| Process high-water through region | 68,048 KiB | 68,416 KiB |
| Avoided duplicate encodings | 0 | 234,946 / 72,341,290 UTF-8 bytes |

This profile demonstrates the mechanism: canonical self samples fall from
266.781 to 131.881 ms, while the guard takes 96.799 ms self samples. These are
1-ms samples, not exact function CPU clocks. The 101.074-ms CPU and 283,250,960-B
allocation differences are **prototype region** observations, not a claimed
whole-analysis speedup. Assertions, counters, result objects and key-witness
hashing are common timed overhead; SQL, quota validation and input loading are
outside the region. The reference wrapper returns a result object whereas the
old store used local variables. No forced GC is requested.

The profile precedes the final own-descriptor-field hardening. That hardening
adds guard checks, changes no encoding/materialization logic, and is included in
the ordinary final candidate run and all final tests. Its exact isolated CPU and
allocation result was **not reprofiled**. The frozen diagnostic prototype and
source-body hashes preserve this distinction; its timings are not promoted to
exact final-helper results.

| Same ordinary phase harness | Final Stage 6.5 control | Final candidate |
|---|---:|---:|
| Complete analysis/export | 85.366 s | 58.196 s |
| Process CPU | 73.997 s | 49.570 s |
| Process high-water RSS | 1,343,088 KiB | 1,151,568 KiB |
| V8 allocation traffic, whole analysis | 29,378,343,984 B | 29,087,693,896 B |
| Syntax staging wall | 25.206 s | 19.490 s |
| Syntax staging allocation traffic | 9,980,946,832 B | 9,771,325,328 B |
| Owned analysis wall (includes syntax staging) | 32.164 s | 25.460 s |
| Owned analysis allocation traffic | 14,617,241,240 B | 14,386,649,968 B |
| Full-graph fingerprint wall (unchanged implementation) | 850.169 ms | 629.157 ms |

The final run records **290,650,088 B less whole-analysis allocation traffic**;
the affected syntax/owned staging regions also allocate less. This is consistent
with eliminating the duplicate encoding, with guard/result overhead included.
It is not an exact attribution of every allocated byte to canonical strings.
The first observed final process high-water is in semantic TypeScript indexing
in both ordinary runs. Peak RSS does not regress in this pair, but that does not
establish a portable RSS reduction or a Core-only memory number.

The 27.169-s wall difference and 24.427-s process CPU difference are far beyond
the measured encoding opportunity. Even unchanged fingerprint, publication,
legacy SQLite and JSON phases vary substantially. A process-name-only snapshot
after the control/before the candidate found macOS StorageManagementService
(80.8% CPU), ApplicationsStorageExtension (43.9%), Storage and metadata services
active. This is a nearby environmental observation, not continuous attribution
of their effect. We launched no competing heavy benchmark/test processes.
There was no cache flush, affinity or thermal control. Input heaps/RSS differ;
the candidate ends with higher instantaneous RSS despite its lower high-water.
**No whole-analysis CPU/time win or general peak reduction is attributed to this
optimization.** The 58.196-s sample does not qualify the 60-second gate.

Counters are process-wide: phase memory is instantaneous, max RSS cumulative,
CPU covers process threads, and V8 `total_allocated_bytes` is cumulative traffic,
including background/observer effects. External/ArrayBuffer counters overlap and
exclude some native memory. Neither encoded byte counts nor sampled surviving
allocations are retained-object sizes. No compiler/V8 subtraction estimates Core.

## Complete equivalence and current qualification

Ten focused tests pass. The pinned Stage 6.5 oracle compares complete stable SQL
tables and callback/error ordering for direct writes, including getters/proxies,
unsupported data, mutation by SQL before encoding, failure after encoding and
retry. Only the existing `sc_runs.created_at` clock field is omitted in that
direct store fixture. Exact Unicode/string bytes, sparse/shared/nested values,
independent equal objects, changed objects, duplicate facts/claims, repeated
provenance, 4-KiB/64-KiB quota boundaries and changed host hooks are covered.

The complete runtime oracle compares graph objects and raw files, complete stable
semantic/legacy tables, incremental history and an independent rebuild against
`0e668fb`. Real-source evidence preserves all 14 ownership/identity tables, all
76 semantic / 29 legacy tables under the **existing** Stage 6.4 clock rules,
and the original eight witnesses. The independently generated legacy
`q_meta.generation` UUID remains explicitly unequal. No new field is excluded,
and complete SQL file byte equality is not claimed.

The real graph is 102,548,074 bytes, SHA-256
`0183e8f4f580a5d567f21160b8285568de60307a536c415fe6c0ced30001d28a`.
Diagnostics are 15,529,775 bytes, SHA-256
`631fa69e6fdd6f49b339303a9b454228e05a9f79fb362d9a5a7e6b86bf6503ce`.
All 234,946 facts/claims, 41,438 occurrences, 57,693 support atoms and 1,193
sealed run identities match. Source freshness is fresh. Full local regression,
Node/UI checks/build, recovery and exact implementation CI are pending.

The candidate is provisionally retained for the measured allocation benefit and
unchanged outputs, not for its noisy whole-run timing. Other reuse candidates
are deferred. A next independent milestone should separate staging/transaction
CPU from waits using the now-dominant phase evidence before proposing changes.
No transaction, compatibility bootstrap or resource-limit work was begun.

## Reproduction

Use the authenticated capture/dependencies and the same repository CWD for both
runtimes. `prepare-semantic-baseline.mjs encoding-reuse` compiles pinned `0e668fb`;
copy the unchanged `scripts/semantic-profile.mjs` into its `scripts/` directory,
or use a full Git archive as this experiment did. Each index/report must be new.

```sh
npm run build:node
node scripts/prepare-semantic-baseline.mjs ROOT encoding-reuse
node scripts/semantic-encoding-audit.mjs prepare ACCEPTED_RUNTIME AUDITED_COPY
node --max-old-space-size=2048 scripts/semantic-encoding-audit.mjs run AUDITED_COPY SOURCE AUDIT_INDEX AUDIT.json
node --max-old-space-size=2048 scripts/semantic-encoding-profile.mjs prepare AUDIT_INDEX INPUT.json
node --max-old-space-size=2048 scripts/semantic-encoding-profile.mjs reference INPUT.json REF.json
node --max-old-space-size=2048 scripts/semantic-encoding-profile.mjs candidate INPUT.json PROTOTYPE.json
node --max-old-space-size=2048 ACCEPTED_RUNTIME/scripts/semantic-profile.mjs phases SOURCE CONTROL_INDEX CONTROL.json
node --max-old-space-size=2048 scripts/semantic-profile.mjs phases SOURCE CANDIDATE_INDEX CANDIDATE.json
node scripts/semantic-export-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SOURCE OWNERSHIP.json
node scripts/semantic-owned-witness.mjs CONTROL_INDEX CANDIDATE_INDEX SQL.json
node scripts/semantic-profile-verify.mjs SOURCE CANDIDATE_INDEX WITNESSES.json
```

The profile command intentionally uses the frozen diagnostic prototype, preserving
the recorded pre-hardening region experiment. The ordinary candidate uses the
final production helper. Set `PROGRAPH_TEST_ENCODING_REUSE_BASELINE_RUNTIME` to
the pinned compiled runtime for the two mandatory accepted-runtime tests. The
existing workflow supplies all other baselines, real-provider toolchains and
strict recovery/evidence checks. Missing baseline/producer evidence fails, rather
than skipping assertions. These instructions do not authorize another benchmark
loop in this milestone.
