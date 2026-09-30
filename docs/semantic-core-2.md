# ProGraph Semantic Core 2.0

**Status:** Proposed engineering design; no Semantic Core 2.0 implementation is claimed.

**Review date:** 1 October 2026.

**Repository baseline:** HEAD `7417ba0be1f7e5e46df51e48d406d79db1921c59`; graph schema `1.2.0`; package `0.3.0`.

**Authority:** Current source is authoritative for implemented behavior. This document owns the proposed architecture; [architecture.md](architecture.md) continues to describe the current implementation.

The baseline was inspected directly, with ProGraph used selectively for navigation. Existing tests were read as contracts, not treated as newly executed evidence. External references below are primary project documentation/specifications consulted on the review date. Indexer integrations, storage estimates, and performance targets in this document are untested proposals. No compiler, external indexer, large-repository benchmark, or experimental prototype was run for this design.

## 1. Executive architecture

ProGraph should become a local semantic fact system with a compact graph projection. Keep the existing evidence-first query experience, while separating identity, source occurrences, language semantics, extraction context, and derived conclusions.

```text
Repository inventory + immutable input digests
                 |
       Project/build discovery
                 |
   Indexing plan: units, variants, providers
                 |
     +-----------+-----------------+
     |           |                 |
 syntax facts  semantic facts    artifact facts
 Tree-sitter   compiler / SCIP   schemas / docs / config
               selected LSP
     +-----------+-----------------+
                 |
   Validated immutable fact batches + ownership
   common predicates AND language-native predicates
                 |
   Versioned passes with recorded read dependencies
                 |
   Snapshot publication: facts + derived projections
                 |
   Indexed query facade + bounded result formatter
                 |
         CLI / MCP / API / UI
```

This modifies the suggested linear pipeline in three ways. Discovery and providers share an explicit planning stage; compiler metadata can refine a plan without silently changing an active run. Native and common facts coexist rather than requiring a destructive conversion. Queries may read occurrences/native facts directly, or use materialized graph summaries; every query does not traverse a universal graph.

### Decisions

| Decision | Reason and consequence |
|---|---|
| First-class symbols and occurrences; dedicated occurrence tables | Precise navigation and call-site evidence without millions of visual graph nodes |
| Typed native predicates plus a small common semantic vocabulary | Preserve traits, specializations, package semantics, and other language distinctions |
| Build/project context is part of semantic identity and invalidation | One source file can mean different things in different targets |
| Generic SCIP ingestion, separate indexer runners, optional enrichment | Reuse mature semantic extraction while retaining facts SCIP cannot express |
| Base assertions are immutable; passes produce separate derived assertions | A framework or impact pass cannot overwrite compiler evidence |
| SQLite remains the initial canonical store | Existing local deployment remains useful; normalize hot paths and measure before changing engines |
| Current `GraphNode`/`GraphEdge` becomes a versioned compatibility projection | Preserve CLI/MCP/UI behavior while removing provider dependence on graph-shaped output |
| Ownership and publication are foundation requirements | Reliable delta indexing cannot be retrofitted from file locations on edges |
| Bounded SQL work and bounded output are separate requirements | Trimming a full graph in memory does not make a query scalable |

The design does not promise whole-program runtime behavior. A statically resolved method is not necessarily the sole runtime dispatch target. Missing build inputs and incomplete provider coverage are visible in every result.

## 2. Current architecture assessment

### Inspected implementation

Repository-relative paths in this table identify the owning implementation, not future filenames.

| Component | Current behavior | Design implication |
|---|---|---|
| `src/core/graph/schema.ts` | `GraphData` contains node/edge arrays; symbol ranges live on nodes; evidence arrays live on edges; schema is `1.2.0` | Navigation locations, observations, and summary relationships are coupled |
| `src/core/graph/identity.ts`, `repository/repository.ts` | Repository identity hashes the absolute root; node IDs hash repository/language/file/kind/qualified name/discriminator, using a 16-hex digest; edge IDs include source evidence positions | Deterministic within the current checkout convention, not portable cross-repository semantic identity; retain legacy aliases |
| `src/core/adapters/contracts.ts` | Snapshot retains all source text; adapters return whole node/edge arrays | Replace authoritative extraction contract with unit-scoped fact streaming |
| `src/core/adapters/providers.ts` | Syntax extraction plus optional semantic `probe`/`resolve`; additive graph contributions; capability levels `unsupported/syntax/heuristic/semantic` | Preserve fallback principle and levels; add context, coverage, cancellation, batches, native schemas, and run outcomes |
| `src/core/analysis/analyze.ts`, `graph/builder.ts` | Sequential language, framework, artifact, linker runs; consumers receive accumulated arrays; map insertion replaces equal IDs; whole graph and JSON export built in memory | No explicit pass dependencies or support tracking; graph builder is insufficient as a fact reconciler |
| `src/adapters/language/typescript/index.ts` | ts-morph/compiler API; root tsconfig/jsconfig, scanner-selected sources; default semantic provider; calls/types/imports | Preserve proven extraction, then add project references and occurrences; do not replace it solely to obtain SCIP |
| `src/adapters/language/rust/index.ts` | Tree-sitter plus conservative module/import/receiver resolver; some `resolved` relationships have inference basis | Preserve accepted resolver behavior and confidence; do not relabel it compiler-backed |
| `src/adapters/language/polyglot/index.ts` | Six shared Tree-sitter frontends; probable same-file bare-name call candidates, unresolved imports/types/inheritance; coarse target text and overload ordinals | Useful base observations, not precise navigation. Trusted-only queries omit most new-language relationships by construction |
| Same polyglot file | `.h` routes to C; compilation database entries are attached to file metadata, never supplied to a compiler | Select header language per compilation context; promote build inputs into indexing units |
| `src/core/graph/boundaries.ts`, `adapters/artifact/architecture/index.ts` | Protocol/namespace/operation identity; schema paths distinguish OpenAPI/Protobuf/GraphQL namespaces; no general client/handler binding | Retain explicit namespaces; separate operation identity, declaration, invocation, and implementation facts |
| `src/adapters/framework/{react,tauri}/index.ts` | Graph consumers; React refines graph-node kind; Tauri retains command/event nodes and namespace `tauri` metadata | Framework facets should decorate symbols without changing symbol identity; isolate multiple Tauri apps |
| `src/core/storage/sqlite.ts` | WAL, prepared inserts, transaction; deletes/replaces graph tables each persistence; JSON metadata/evidence; source/target/name/file indexes; retains analysis-run history | Good base deployment; needs normalized occurrences, ownership, snapshot and support tables |
| `src/core/query/query-service.ts` | Shared confidence/scope filtering; several targeted SQL queries; callers/callees load all nodes for scope, neighborhood/affected/context/architecture load substantial global data | Keep facade, move filters and traversal into indexed storage; context also has degree-based preselection and repeated degree queries |
| `src/core/query/output-mode.ts` | Compact/standard/full and evidence limits; compact typically one evidence pointer | Preserve formatter purpose; bound query work before formatting and report evidence totals |
| `src/core/analysis/{state,sync,watch}.ts` | Hashes source/config/provider versions; isolated TS/Rust incremental path with stringent safety gates, otherwise rebuild; sync reads full graph export; status rereads source; watch debounces events | Replace file-removal ownership with unit/claim dependencies; keep explicit conservative fallback |
| `src/core/config/config.ts` | Optional includes/excludes/adapter switches; generated/build/vendor trees normally excluded | Semantic input inventory must distinguish user-visible sources from required generated/dependency inputs |
| `src/{cli,mcp,server}`, `src/ui` | One query service; custom index roots; local server and stdio MCP; bounded visual views | Keep delivery surfaces; add snapshot, variant, coverage, and navigation endpoints |

`tests/core.test.ts`, `tests/polyglot.test.ts`, mixed/Rust/polyglot fixtures cover useful contracts: confidence filtering, IDs, provider failure, syntax recovery, boundaries, custom indexes, and sync. The polyglot scale fixture creates 150 small Python files and 250 schema operations; it is not evidence for 100k, 1M, or 10M LOC performance.

The working tree already deletes `docs/graphrag-design.md`. Its HEAD content identifies the SOFT3888 research assistant, Supabase, and GraphRAG retrieval. This is unrelated repository cleanup, excluded from architectural evidence. Preserve that existing deletion independently of this document.

### Keep the strengths, address the semantic ceiling

Keep deterministic local graph identity, conservative confidence, direct evidence, fallback extraction, scopes, framework boundaries, and one query facade. The ceiling is not the list of supported languages. It is that providers must compress observations into display-oriented edges before context, ownership, and derivation are represented. Adding semantic indexers alone would increase precision but leave contradictory observations, target variants, stale facts, and global materialization unresolved.

## 3. Lessons from mature systems

The following summarizes external mechanisms. All subsequent choices are ProGraph proposals, rather than claims that these systems have identical behavior.

### SCIP and Sourcegraph

SCIP provides an interchange format centered on documents, symbol information, and source occurrences. Package-qualified symbol strings include a scheme, package manager/name/version, and descriptors; document-local symbols require separate scoping. Occurrence roles and symbol relationships support navigation, but there is no general call-target field or call role. Function highlighting is insufficient call evidence. The importer must also account for source-position encoding and current typed ranges as well as historical packed ranges. [SCIP protocol](https://github.com/scip-code/scip/blob/main/scip.proto).

Sourcegraph distinguishes compile-time precise navigation from search/syntax heuristics. Adopt that separation in query coverage and confidence; broad fallback availability must not imply semantic resolution. [Code navigation](https://sourcegraph.com/docs/code-navigation).

**Adopt:** Common interchange, external semantic identities, occurrence navigation, independent language indexers. **Do not adopt:** SCIP as the entire internal schema, automatic cross-repository joins based solely on a symbol string, or references interpreted as calls. ProGraph also needs build variants, native facts, derivation dependencies, and knowledge artifacts.

### Glean

Glean stores unique typed facts under predicates, with keys and optionally values. Its language schemas need not flatten all detail into a common vocabulary; a query layer can present useful uniform operations. [Basic concepts](https://glean.software/docs/schema/basic/), [introduction](https://glean.software/docs/introduction/), [named schemas](https://glean.software/docs/schema/syntax/). Stored derived predicates can provide additional query access paths. [Derived predicates](https://glean.software/docs/derived/).

Glean's incremental design assigns unit ownership, propagates ownership through fact references, and represents derived visibility using conjunctions of supporting inputs, with alternative ownership giving disjunctions. Stacked databases hide replaced units while exposing a combined view. [Incremental indexing](https://glean.software/blog/incremental/).

**Adopt:** Native typed predicates, deduplication, explicit owners, support expressions, immutable publication, separate user symbol APIs. **Adapt:** ProGraph must distinguish retaining a symbol identity from retaining an obsolete semantic assertion. **Do not adopt initially:** Angle, Thrift deployment, distributed database service, or arbitrary deep database stacks. SQL plus validated predicate schemas is the smaller migration.

### Kythe

Kythe separates source anchors from semantic nodes. Its schema distinguishes definition bindings, references, call references, imports, and implicit/expansion relations. A call anchor can belong to a caller while referring to the callee. Corpus/root/path/signature/language naming supports identities beyond a single source coordinate. [Schema](https://kythe.io/docs/schema/), [overview](https://kythe.io/docs/kythe-overview.html).

**Adopt:** Anchors, multiple locations per symbol, conservative relation meaning, explicit implicit/generated evidence. **Do not adopt wholesale:** Every occurrence as an ordinary UI node or the complete Kythe edge vocabulary. Specialized tables and selected projections better serve ProGraph's bounded agent queries.

### CodeQL

CodeQL extraction treats language and build mode as explicit database-creation inputs. Manual and automatic builds can capture generated sources; supported no-build modes have different completeness. Language-specific extraction yields databases for subsequent relational analysis. [Preparing code](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/prepare-code-for-analysis), [build modes](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-for-compiled-languages).

**Adopt:** Compilation contexts, dependency/toolchain inputs, generated-code inventory, language-specific extraction and derived analyses. **Do not adopt:** Mandatory successful builds, automatic execution of discovered commands, or CodeQL as a runtime/storage dependency. A discovery-only run remains useful, with explicit semantic gaps. Build-aware does not mean every language requires compilation.

### Joern / Code Property Graph

Joern combines program representations behind language-independent traversals and overlays. The CPG specification separates AST, call graph, CFG, dominators, and program dependence: control and data dependence require their own inputs and algorithms. [CPG overview](https://docs.joern.io/code-property-graph/), [CPG layers](https://cpg.joern.io/).

**Adopt:** Base facts first, versioned graph passes later, optional deeper analysis, explicit prerequisites. **Do not adopt:** Persisting every AST token by default, treating an architectural dependency as dataflow, or requiring a CPG database/Scala query stack. Language-native IR is necessary where a common AST would erase execution semantics.

### Compiler and language-server ecosystems

Use compiler project boundaries and semantic APIs when available. LSP has negotiated capabilities and source-position conventions, but a request protocol is not a guaranteed complete offline index. Its navigation/call-hierarchy results should be recorded as observations tied to a synchronized source state. [Official protocol types](https://github.com/microsoft/vscode-languageserver-node/blob/main/protocol/src/common/protocol.ts), [Pyright navigation handlers](https://github.com/microsoft/pyright/blob/main/packages/pyright-internal/src/languageServerBase.ts).

**Choice across systems:** SCIP minimizes interchange cost, Glean preserves native semantics and ownership, Kythe makes evidence addressable, CodeQL supplies build context, and CPG layering disciplines derivation. None alone defines ProGraph's storage or public API.

## 4. Proposed semantic fact model

### Entities, assertions, observations, and projections

An **entity** is an addressable identity: symbol, source anchor, package, build target, boundary operation, or knowledge artifact. An entity row is not proof that it currently exists or has a definition. A **fact** is an immutable typed proposition about entities in a semantic context. A **claim** associates that proposition with an extraction or derivation, provenance, confidence, and support. Multiple providers can claim the same fact without overwriting each other. A **projection** selects visible supported claims for a snapshot and produces a query summary.

```text
Entity(Symbol B)
Fact(common.Reference, occurrence O, target B, context V)
Claim(Fact, provider run R, provenance P, confidence resolved)
Partition R owns Claim
Snapshot S selects R
```

Do not use one mutable `confidence` field on a fact shared by all providers. Do not use `GraphBuilder.addNode` replacement as reconciliation. The canonical layer accepts contradictions; a projection reports a conflict or chooses a documented compatible interpretation, retaining other observations.

### Predicate contract

Each predicate registers namespace/name, schema version, key fields, typed payload, referenced entities/facts, context sensitivity, legal confidence/basis, indexes, projection rules, and retention policy. Runtime validation rejects invalid batches. Core examples:

| Predicate | Meaning |
|---|---|
| `common.SymbolDeclaration` | A provider observes a declared symbol, kind, signature, and context |
| `common.Defines` | Definition occurrence binds to a symbol; declaration/forward/body distinctions retained |
| `common.Reference` | Occurrence targets a symbol; reference purpose may be unknown |
| `common.CallSite` | An invocation is observed; expression anchor, enclosing execution scope, dispatch kind |
| `common.CallTarget` | A call site has a static/possible target, with receiver/dispatch qualifications |
| `common.Import` | Import site, imported module/package/symbol, alias and resolution environment |
| `common.TypeUse` | Type-position occurrence uses a type entity; syntax observation can be unresolved |
| `common.SymbolRelation` | Extends, implements, overrides, alias, or provider-specific navigation relation |
| `common.Encloses` | Occurrence belongs to a lexical/execution scope, which must be distinguished |
| `build.UnitInput` | Unit reads an input resource/digest under a specified dependency kind |
| `boundary.Participation` | A symbol or invocation participates in a namespaced protocol operation |
| `knowledge.Link` | Artifact links to code/config/test entities, preserving current graph domain/scope |

Unresolved observations use a scoped **resolution request**, with spelling, lexical scope, occurrence, expected category, and context. They are not assertions of a globally existing symbol named by arbitrary source text. Candidate facts connect that request to zero or more symbols. The compatibility view can still synthesize existing `unresolved_symbol` nodes and edges.

Predicates also declare cardinality: a set-valued candidate/overload relation permits several values, while a unique binding predicate has one logical key per occurrence/context. Store both a logical key (predicate + natural key + context) and a content key (logical key + value). Different values under a unique logical key form a conflict group; they are not rejected as duplicate IDs or confused with legitimate set-valued outputs.

### Identities

Use versioned canonical serialization, explicit discriminators, and SHA-256 content keys for new identities; use integer surrogate keys internally. Keep full canonical keys available to detect a digest collision. Never use insertion order, timestamps, SQLite row IDs, or execution-run IDs in public semantic identities.

| Identity | Proposed key |
|---|---|
| Checkout | Existing repository identity; retained for legacy graph IDs |
| Semantic repository | Explicit configured corpus identity or validated canonical remote identity; otherwise checkout-local |
| Package | Ecosystem/manager + namespace/name + exact version or workspace identity + origin |
| Symbol | Identity scheme + package/repository scope + semantic descriptor + language + required variant discriminator |
| Syntax-local symbol | Source document + lexical identity/discriminator; coordinate fallback is explicitly unstable across edits |
| Occurrence | Source revision + anchor + interpretation context + discriminator for multiple occurrences at the same anchor |
| Fact | Predicate/version + canonical key and value + semantic context |
| Claim | Fact key + producer configuration fingerprint + stable provenance/support key |
| Derived summary | Projection version + endpoints + relation + variant + domain; evidence membership stored separately |

Provider-specific external identities live in `symbol_keys`; a validated equivalence fact can map them to a canonical symbol. No fuzzy name merge. Local IDs from unrelated SCIP documents never coincide. Semantic symbol stability across a rename is not promised. Legacy IDs remain addressable through aliases where correspondence is unique.

Provenance identity includes the unit/input/configuration fingerprint and extraction rule, but excludes attempt IDs and timestamps. Partition membership records the actual producer attempt, so identical re-extraction can reuse a claim without losing its run history. Occurrence identity is source-revision-specific: an edit may replace all occurrences in that document even when a symbol ID survives. Fine-grained coordinate tracking across edits is an optional later optimization.

Published package symbols can resolve across repositories only with compatible package origin/version/scheme and an explicit index registry. Workspace package version `0.0.0`, a missing version, or identical private package names are not sufficient. Repository revision belongs to a snapshot/source identity; do not attach the whole repository commit to every otherwise unchanged symbol. Variant differences remain in declarations/claims, and in symbol identities when the entity itself differs.

## 5. Symbol and occurrence model

### Representation decision

Introduce one `Symbol` identity and one `Occurrence` record family, rather than six independent node hierarchies. Definition, reference, call, import, and type are roles/predicates over an occurrence. One token may be both a type reference and import binding, or define one entity and refer to another. Read/write, forward declaration, generated, test, implicit, and macro-related roles are retained. A call expression can have an expression anchor distinct from its callee token anchor.

Use specialized relational storage for anchors/occurrences and their claims. They are first-class addressable facts with dedicated APIs; they become graph nodes only in an explicitly requested evidence/detail view. This avoids allocating name/qualifiedName/metadata JSON and ordinary graph adjacency for every reference.

```text
Symbol A
  <- common.Encloses(execution-scope) - CallOccurrence O
O -- common.CallTarget(static) --> Symbol B

call-graph pass:
Symbol A -- calls [support O + target + scope] --> Symbol B
```

The call projection requires supported call-site classification, caller scope, and target resolution in the same compatible variant. Function values passed as arguments or assigned to variables remain references. An occurrence inside a lambda belongs to that lambda's execution scope, not automatically to its enclosing method. Module initializers can be explicit execution-scope symbols. Decorator execution is retained as native information until a pass has an appropriate evaluation model.

### Source coordinates

Canonical anchors use `(source_revision, start_byte, end_byte)` with half-open UTF-8 byte offsets. Store line/column conversion tables per document in a compact blob/cache, rather than duplicate tables per occurrence. Public source locations use one-based lines and columns with an explicit column encoding; the legacy graph projection preserves the previous provider's location convention until its adapter is converted.

Providers must declare coordinate encoding. Validate against the source bytes/digest; convert UTF-16/UTF-32 coordinates using the document's line map, preserving CRLF and original bytes. Never infer byte offsets from JavaScript string indices. Ranges must be ordered, in bounds, and land on valid encoding boundaries. Zero-width implicit anchors are legal and labeled.

Retain selection/token range separately from enclosing declaration/expression range. Generated, macro expansion, and spelling locations are separate linked anchors, not an invented contiguous range. Discontinuous source maps are multiple mapping segments. Definitions with multiple declarations/bodies have multiple occurrences. Missing source allows an unverified provider-coordinate location, not a fabricated byte anchor; trusted current-source navigation requires source verification.

### Volume and querying

Occurrence counts will likely dominate symbol counts; measure actual ratios by language. Integer entity keys, short role bitsets, separate large documentation blobs, and normalized provenance keep rows small. Estimate only after importing representative indexes. Reference APIs paginate by source path/start/end/stable key, group counts by file, and fetch source excerpts on demand. Callers return distinct caller symbols, site counts, and a bounded sample, not every invocation. Hot occurrence lookups use source and symbol indexes; compact queries never traverse the entire occurrence table.

## 6. Project/build/indexing-unit model

### First-class context entities

| Concept | Definition | Storage/projection choice |
|---|---|---|
| Repository | Source corpus and current checkout binding | Entity; preserve existing repository node |
| Workspace | Group of projects/repositories under a build/package convention | Entity; membership facts, no assumption of one global workspace |
| Project | Compiler or analysis configuration boundary | Entity; tsconfig, Gradle module, Python analysis root, etc. |
| Package | Distribution/module identity and dependency boundary | Entity; separate from directories and language namespaces |
| BuildTarget | A named output/variant: binary/library/test, framework or target platform | Entity; opt-in build/dependency graph view |
| CompilationUnit | Source plus normalized compiler invocation and dependency environment | Persistent context entity; normally hidden from symbol graph |
| IndexingUnit | Smallest replaceable output partition for a provider | Persistent control-plane record/entity, not a default visible code node |
| DependencyEnvironment | Ordered module/include/classpath resolution, lockfiles and toolchain identities | Interned immutable context record; summarized on demand |

These concepts do not form a mandatory tree. A source belongs to multiple units; a project may publish several packages/targets; a workspace can span repositories. Compilation units and indexing units are distinct: a provider may index a whole TypeScript project or Rust crate while emitting facts for many files. File-level output ownership does not imply file-level semantic reindexability.

### Discovery and semantic inputs

Discovery parses manifests/configuration without executing arbitrary build commands. It produces a plan with completeness (`observed`, `configured`, `incomplete`), source roots, variants, input digests, expected generated files, selected providers, and reasons. Tool-backed discovery is an explicit provider operation with recorded argv, working directory, environment allowlist and effects. Running Maven/Gradle, build scripts, proc macros, or dependency installation must be separately configured; scan/status do not start them implicitly.

| Language | Unit/variant and actual semantic inputs | Missing-context policy |
|---|---|---|
| C/C++ | Translation unit + working directory + ordered argv/include paths/defines/forced includes + language/standard + compiler/resource/sysroot + target; include dependency closure | Syntax fallback, no guessed overload/include resolution |
| Java | Module/source sets + classpath/module path order + JDK + language level + annotation processors/generated roots | Mark missing artifacts and unresolved types; do not claim build completeness |
| C# | Project/solution target framework + references + SDK + preprocessor constants + nullable/language settings + generators | Retain each target framework; no merge by type name |
| Python | Analysis project/package root + import search order + interpreter identity/version + environment/stubs + pyproject/Pyright config | Interpreter executing dynamic imports is not required; dynamic targets stay unresolved |
| Go | Module/workspace + package + GOOS/GOARCH + build tags + compiler/module graph/vendor mode + cgo context | Excluded files/variants reported; cgo remains a boundary unless supplied precise facts |
| Rust | Workspace/crate target + edition + feature set + cfg/target triple + toolchain + dependency graph + build-script outputs/proc-macro configuration | Keep current conservative resolver; no assumed trait/macro completeness |
| TypeScript | Each tsconfig/jsconfig + extends/references + package boundaries + compiler options + lock/module resolution environment | Root project behavior remains a compatibility mode; nested projects become explicit |

Clang's compilation database permits multiple commands for the same source and distinguishes working directory, arguments/command, and output. Preserve variants and prefer argument arrays; do not tokenize a shell command using whitespace or execute it as discovered input. [Compilation database specification](https://clang.llvm.org/docs/JSONCompilationDatabase.html).

Unit identity includes stable project/target/provider partition keys; its **input fingerprint** includes semantic options and digests, separately from identity. Normalize checkout-local paths through root mappings, but retain argument order and flags that affect semantics. External SDK/environment paths are paired with toolchain/resource fingerprints; path text alone does not prove identical inputs.

`.h` selection is per unit: explicit `-x`, consuming translation-unit context, then project configuration. A header included from C and C++ produces separate semantic interpretations of the same anchors. Without context retain current C fallback, emit an ambiguity diagnostic, and allow explicit language overrides. Do not run two parsers and choose whichever invents fewer errors as semantic truth.

### Generated and excluded inputs

Keep separate inventories for display sources, semantic inputs, dependency sources, and generated artifacts. A generated header under an excluded build directory may be read when a configured unit requires it, without indexing every build output. Store generator/schema/command/output digest links when known. Missing outputs are coverage gaps. An OpenAPI schema and generated client only share an operation through explicit generation metadata or a validated binding pass, not file naming resemblance.

## 7. Provider architecture

### Existing interfaces are useful but insufficient

`SyntaxProvider` and `SemanticProvider` preserve a valuable distinction. Their current repository-wide graph arrays and `resolve(snapshot, syntax)` coupling should be replaced behind a legacy adapter bridge. Semantics need not depend on running syntax first, and multiple semantic producers may coexist. Retain `probe`, descriptor identity/version, fallback isolation, and capability levels as concepts.

Proposed conceptual contract (not an implemented TypeScript interface):

```typescript
interface FactProvider {
  descriptor: ProviderDescriptorV2;
  probe(plan: IndexingPlan): Promise<Availability>;
  plan(context: DiscoveryView): Promise<UnitPlan[]>;
  index(unit: UnitPlan, input: SourceReader, sink: FactSink,
        signal: AbortSignal): Promise<UnitOutcome>;
}

interface UnitOutcome {
  status: "complete" | "partial" | "unavailable" | "failed" | "cancelled";
  inputFingerprint: string;
  coverage: CapabilityCoverage[];
  dependencies: InputDependency[];
  diagnostics: DiagnosticPointer[];
}
```

The descriptor adds transport (`in-process`, `process`, `index-import`, `lsp`), semantic basis, language set, emitted predicate/schema versions, supported input modes, smallest safe replacement/reindex unit, resource requirements, and deterministic configuration fingerprint. `FactSink` writes validated bounded batches under one unpublished partition run. It supports backpressure, input-file registration, diagnostic limits, and declared source hashes. Run completion is a separate seal; a process's partial bytes are never automatically a complete unit.

Capabilities become per unit/variant: feature, level, coverage (`complete`, `partial`, `none`, `unknown`), limitations, source count, and run status. A successful probe shows availability, not successful extraction. Missing references in a partial index are not evidence of no references. Existing adapter-level capability objects remain summaries of these records.

### Integration policy

1. Keep bundled TypeScript compiler extraction as the default; adapt its output to facts incrementally.
2. Keep Rust's conservative resolver and all syntax frontends usable with no external installations.
3. Add pre-generated index ingestion as an independent operation. It must not require a local compiler or a source build.
4. Add configured indexer runners with pinned executable/version, argv arrays, controlled working directory, timeout/memory/output limits, and captured input manifest.
5. Add LSP only where offline/indexer/compiler APIs leave a material gap. Synchronize a source snapshot, negotiate position encoding/capabilities, wait for readiness, and record that references can be request-scoped rather than exhaustive. No always-on daemon requirement.
6. Allow native analyzer imports and schema/artifact producers that do not use SCIP.

Provider errors keep syntax observations and diagnostics. A failed semantic replacement does not present the previous semantic run as current. Resource scheduling happens by unit/provider, respecting compiler process memory; asynchronous JavaScript calls alone do not parallelize synchronous Tree-sitter or SQLite work.

## 8. SCIP ingestion strategy

### Separate decoding from invoking indexers

Implement `GenericScipProvider` as a transport-neutral importer. Separate runners for specific indexers handle invocation, environment, supported project modes, and emitted input manifests. Language enrichment reads native/syntax facts plus imported observations; it does not duplicate protobuf parsing. SCIP is supported interchange, not the core persistence schema and not mandatory for native providers.

Pin a protocol revision and decoder mapping version at implementation. Preserve original symbol strings and unknown enum/role values. Current protocol review includes typed ranges; legacy packed range support remains necessary. A saved index is paired with a ProGraph sidecar manifest containing source digests, project/unit/variant mapping, producer version/configuration, and build/dependency fingerprints. Bare SCIP metadata alone is not proof that it matches the working tree.

### Mapping policy

| Input | Proposed treatment |
|---|---|
| Index metadata and producer info | Intern provider run/artifact provenance; validate root mapping and declared encoding |
| Documents | Source records, independently verified digests, occurrence batches |
| Global symbols | Preserve complete parsed key; scope ambiguous workspace package origins |
| Local symbols | Scope to index artifact/document and semantic unit; retain canonical correspondence only when verified |
| Definition/import/read/write roles | Store observation roles; definition/body/forward distinctions remain separately queryable |
| Other symbol-bearing occurrences | Reference observations; purpose unknown until supported enrichment |
| Symbol information/documentation | Typed symbol declarations and separately interned bounded documentation blobs |
| Symbol relationships | Preserve flags as navigation facts; translate only relationships with a defined common meaning |
| Function syntax classification | Highlight/classification observation, never enough to create `CallTarget` |
| Enclosing range | Location hint; does not alone establish execution owner or a call |
| Diagnostics/external symbols | Run-scoped diagnostics and identity shells; external declarations can lack local definitions |

### Import sequence and failures

Read a bounded header, validate producer/root mappings, then decode documents into staging batches using a protobuf wire reader that skips unknown length-delimited fields without building the whole `Index` object. A standard whole-message decoder may be used only in an explicitly size-limited initial implementation. Set maximum document/field size; spill large single documents to disk or reject them with a diagnostic rather than unbounded allocation. Reuse the repository's `protobufjs` dependency only after confirming it supports the required wire decoding strategy; no dependency change is assumed here.

Require relative paths to resolve through declared source roots; reject traversal, unconfigured absolute roots, duplicate contradictory documents, invalid ranges, and broken symbol syntax. External source roots may be configured explicitly. Embedded index text, if provided, still needs a digest and must not overwrite repository files.

Source-verified documents may be published; an import whose manifest cannot establish current unit context is historical/unverified, excluded from current trusted projections. Document-level rejection produces `partial` coverage; malformed/truncated framing fails the entire import partition. The minimal supported replacement unit is the entire imported artifact unless its producer supplies a trustworthy independent-unit manifest. Do not infer incremental safety just because SCIP contains per-document records.

Persist all import mappings and source verification decisions so repeat import is idempotent. Retain checksum/protocol revision/producer fingerprint; raw index retention is optional and quota-controlled. Exporting SCIP can be considered later; it cannot round-trip arbitrary native facts or derived Knowledge Overlay meaning.

### Candidate indexers and validation order

The linked upstream projects were inspected for their stated purpose. Availability here means an upstream implementation exists, not that it was installed or qualified in ProGraph.

| Candidate | Proposed first use / qualification concern |
|---|---|
| [scip-typescript](https://github.com/sourcegraph/scip-typescript) | Differential navigation fixtures against existing ts-morph; nested projects and workspaces; retain current backend default |
| [scip-python](https://github.com/sourcegraph/scip-python) | Pyright-based Python navigation; environment/stubs/package-root/rebinding fixtures |
| [scip-clang](https://github.com/sourcegraph/scip-clang) | Build-aware C/C++; compilation database, header variants, overloads, templates and macro provenance |
| [scip-java](https://github.com/scip-code/scip-java) | Module/classpath/generics/overload fixtures; build tooling and generated inputs |
| [scip-go](https://github.com/scip-code/scip-go) | Module/package identities, build tags, interfaces, test packages |
| [rust-analyzer SCIP / scip-rust](https://github.com/scip-code/scip-rust) | Rust navigation with features/targets; qualify multi-target/shared-file and macro behavior before replacing any fallback |
| [scip-dotnet](https://github.com/sourcegraph/scip-dotnet) | Roslyn-based C# navigation; target frameworks, overloads, source generators |

Start with fixtures and imported artifacts for TypeScript and Python, then a small build-aware C/C++ corpus. Integrate the remaining runners independently. Do not promise identical capabilities or maintenance status across indexers. Calls, dispatch, generics, and macros are qualified separately from definition/reference navigation.

## 9. Language-native fact strategy

Use versioned predicate families such as `rust.*`, `cxx.*`, `python.*`, `jvm.*`, `dotnet.*`, `go.*`, and `typescript.*`. Their schemas are owned by language packages, with typed references and indexed fields. Unknown native predicates may be retained as validated opaque payloads for archival purposes, but are not advertised as queryable semantics until registered. No universal `metadata` JSON is the sole location for hot semantic relations.

| Language family | Native facts to preserve | Common projection / deliberate limitation |
|---|---|---|
| Rust | Trait declarations; impl blocks and self type; associated items/types; trait obligations; cfg/features; macro invocation/expansion/hygiene mappings; relevant lifetime/binder relations | Implements/type/call projection only for supported bindings; lifetime/borrow checking is not inferred from syntax |
| C++ | Template pattern/parameters/arguments; instantiation/specialization; overload membership and selection; using/namespace lookup; macro spelling/expansion; virtual member/static target/possible dispatch; translation-unit variant | Templates and overloads remain separate entities/facts; unresolved dependent calls stay unresolved |
| Python | Modules/package search order/namespace packages; import binding/re-export/dynamic import expressions; decorator order; protocol/conformance evidence; descriptors; scoped assignment/rebinding | Type-checked target is a static conclusion under its environment; monkey patching and arbitrary runtime imports are not resolved by name |
| JVM | Projects/classpath/module boundaries; annotations; generic declarations/substitution; method overload signature; erasure/bridge/generated items; overrides | Distinguish JVM identity from display signature; annotation syntax alone does not establish framework binding |
| .NET | Assemblies/project target frameworks; attributes; overloads; generic instantiation; partial declarations; explicit interface members; generated sources | Multiple partial definitions share identity when compiler-proven; reflection and P/Invoke require separate facts |
| Go | Package identity versus module; receiver/method sets; interface satisfaction; embedding; build constraints; cgo links | Implicit interface satisfaction only from qualified semantic facts |
| TypeScript | Modules/re-exports; aliases; value/type namespaces; merged declarations; signatures/overloads; type references; JSX/callback context | Retain compiler facts and React facets without changing semantic ID |

Do not attempt a complete type universe before navigation works. Preserve essential native facts supplied by providers, add predicates as queries demand them, and distinguish not extracted from semantically absent. Advanced IR/AST facts are opt-in per unit. Fact schemas must not require native providers to reconstruct semantics from a common graph projection.

## 10. Common semantic projection

The common vocabulary is a query contract, not a lossless language schema. Materialize symbols, representative definitions, imports, calls, inheritance, boundaries, package/file dependencies, and Knowledge Overlay facets. Preserve native detail by pointer and expose it through language-specific detail APIs when useful.

Rules are predicate-specific and versioned:

- `calls(A,B)` requires visible call-site, execution-owner, and compatible target claims. Keep static target versus possible dispatch distinct; multiple candidates never become a unique resolved call by choosing the first.
- `imports(P,Q)` retains import occurrence, imported namespace/package meaning, and environment. Project dependency does not imply every file imports every dependency.
- `implements` from Rust trait impl, C# interface implementation, or Go interface satisfaction carries a `relationSemantics` discriminator; common queries can group them, but cannot equate their proof requirements.
- React component is a facet on a stable function symbol. The compatibility view may still expose `react_component`. Facet changes do not rename the canonical symbol.
- Tauri command/event exposure and registration retain their existing visible node kinds and legacy IDs through aliases; underlying function identity is separate.
- Schema boundaries can be exact declarations even when no implementation is linked. Documentation/test links keep graph domain and source category independent of code semantics.

For aggregate relations, deduplicate endpoint/relation/variant/domain, store total site counts and counts by confidence, and keep a separate support membership table. A single exact observation can support an existential aggregate edge; it does not make all contributing sites exact. Contradictory target claims at the same occurrence require a conflict marker and deterministic reconciliation policy, not maximum-confidence selection alone.

Default reconciliation for a unique binding first restricts to verified, current, compatible-context claims. One trusted target can be selected while preserving probable syntax alternatives. Multiple different trusted targets produce an unresolved conflict and no unique trusted call target. A configured provider-authority rule may choose one with an explicit conflict explanation; it is versioned and invalidates the projection. Multiple definitions or virtual-dispatch candidates governed by set-valued predicates are not automatically conflicts. Deterministic ordering selects display samples, never semantic truth.

Provide two projections: a legacy per-evidence edge view matching current behavior, and a canonical aggregated relation view for new queries. Use a stable graph ID for a canonical relation independent of the current sample evidence. Never apply current `edgeId` to millions of evidence pointers just to summarize them.

## 11. Graph pass / overlay system

### Pass contract

Replace the hard-coded adapter order with a dependency DAG of versioned passes. A pass declares:

```text
id + version + configuration fingerprint
reads: predicates / projections / native IR and required capabilities
writes: derived predicates and projection versions
partition: occurrence / symbol / unit / package / project / boundary namespace
dependencies: other pass versions
invalidation: input claims AND selector/environment dependencies
resources: concurrency / memory / deadline / maximum expansion
fallback: skip, partial output, or conservative broader recomputation
```

Passes consume immutable read views through `FactReader`/`ProjectionReader`, backed by indexed SQLite iterators. They produce batches to `FactSink`; they cannot modify base facts. SQL handles joins/counts/selectors, workers handle bounded algorithms, and native analyzer workers handle language IR. No mandatory full in-memory graph. A bounded in-memory graph is appropriate for one function's CFG or a selected impact frontier. Direct SQL is allowed inside storage-owned implementations, not scattered across provider packages.

Each output has a producer partition, supporting claim set or interned support group, and a derivation explanation. Selector dependencies record the query keys used to choose inputs, including negative lookups. Reading "the only candidate named x in scope S" depends on the candidate set, not only on the candidate that happened to win.

### Initial and optional passes

| Pass | Inputs | Output / invalidation scope |
|---|---|---|
| Semantic reconciliation | Occurrences, identities, native bindings, source verification | Correspondence/selected navigation claims; unit or semantic scope; no fuzzy name unification |
| Call graph | Call-site, enclosing scope, static/dispatch target facts | Relations and site membership; caller plus target-set selectors |
| Inheritance | Native extends/impl/override relations | Common inheritance/implementation queries; type and affected native scopes |
| Framework bindings | Symbols/occurrences/config/attributes/JSX | React/Tauri/framework facets and registration facts; app/project/config scope |
| Boundary binding | Participation, namespaces, operation declarations, generation/config mappings | Supported cross-language paths; boundary namespace and participants |
| Dependency/architecture | Imports, calls, project/package facts, boundary paths | File/package summaries and counts; changed endpoints/shards |
| Documentation/knowledge | Markdown/config artifacts + explicit code references | Existing knowledge relations; artifact and lookup-selector dependencies |
| Test relevance | Test declarations/runner config + dependencies and optional coverage | Evidence-ranked test links; test/package/changed relation partitions |
| Impact | Reverse relations and boundary participation | Bounded query-time paths; optional cached summaries keyed to snapshot |
| CFG | Language execution IR + exceptional-flow model | Per-function basic blocks/control-flow facts; opt-in |
| Dataflow / control dependence | CFG + native def/use + call summaries/alias assumptions | Reaching definitions, dominators, dependence and bounded slices; opt-in |

Architecture summaries are durable projections when they avoid repeated global grouping. Impact and context ranking usually remain bounded query algorithms; do not store every transitive path. Cycles/SCCs can be an offline package-graph pass or a bounded selected-subgraph operation. A pass cycle is rejected at registration unless a future explicit fixed-point contract defines convergence and resource limits.

Knowledge Overlay becomes a pass family, not a second semantic authority. Its current scopes and evidence survive. CPG-style overlays and Knowledge Overlay share scheduling/support mechanics but retain distinct meaning and capability requirements.

### Failure behavior

A pass partition is sealed only after validation. Required projection-pass failure excludes the affected new projection partition and marks coverage degraded; stale previous output is historical, not mixed into a current result. Optional pass failure does not invalidate navigation. Publish a coherent snapshot with explicit unavailable partitions, or leave the old snapshot selected when the caller requires all-or-nothing readiness. Queries state which policy was used.

## 12. Boundary model

Keep `protocol / namespace / operation` as the core identity and the current protocol vocabulary: Tauri commands/events, HTTP, GraphQL, gRPC, FFI, JNI, P/Invoke, subprocess, IPC, WebSocket, messaging, and databases. Existence of a protocol type remains distinct from having a qualified extractor.

Introduce a **BoundaryNamespace** entity with authority, logical service/app identity, contract revision when incompatible, deployment/project scope, and aliases supported by configuration/generation facts. Default artifact namespace remains repository + schema path. It joins nothing outside that scope unless a configured mapping proves equivalence. Never infer equality from matching operation names, hostnames stripped of service context, or package names alone.

| Protocol | Operation identity within a namespace |
|---|---|
| HTTP | Uppercase method + declared path template; optional incompatible API version belongs to namespace/contract |
| GraphQL | Schema-qualified type.field; a document operation maps to selected fields through validated schema facts |
| gRPC | Fully qualified service/method plus contract identity |
| Tauri | Command/event name scoped to the actual app/project; retain legacy `tauri` alias only inside its original app |
| FFI/JNI/P/Invoke | Library/assembly/linkage domain + ABI/signature/entry point with calling convention where relevant |
| Messaging/IPC/WebSocket | Broker/channel/topic/endpoint schema and operation; direction/dispatch qualifiers retained |
| Database | Connection/schema/catalog identity + operation category; table name alone never proves a shared database |
| Subprocess | Configured executable/package identity + command/protocol entry; arbitrary shell text remains unresolved |

```text
TS CallOccurrence -- invokes --> HTTP Operation
                                  ^
Python handler Symbol -- implements+
```

Invocation attaches to an occurrence; implementation/exposure attaches to a symbol with a registration/declaration occurrence as evidence. Emit/listen facts retain subscriber or publication sites. The boundary-path pass can derive symbol-to-operation and caller-to-handler summaries with support from both sides and namespace equivalence. An HTTP request is a boundary invocation, not a same-process function call. Boundary path queries return the intermediate operation, every supporting leg, weakest path confidence, and unbound participants.

Two services both declaring `GET /items` remain distinct. An unknown URL base yields a scoped unresolved namespace. Dynamic routing, load balancing, runtime listeners, or multiple handlers can produce candidate paths; no unique handler claim without sufficient registration/build/config evidence. Route-template normalization is protocol-specific and versioned; do not merge templates solely by deleting parameter names.

## 13. Provenance/confidence model

Retain `exact`, `resolved`, `probable`, and `unresolved` and trusted defaults `exact/resolved`. Confidence is about a particular proposition, not general provider quality.

| Confidence | Use |
|---|---|
| exact | Direct observation or explicit declaration/configuration establishes the stated relation; exact call syntax does not make its target exact |
| resolved | Supported binding establishes a target under a recorded semantic environment; compiler, LSP, or the existing accepted Rust resolver may supply it |
| probable | Candidate inferred from lexical/structural/framework evidence; assumptions are stated |
| unresolved | Observation exists but target/namespace/binding cannot be established |

Preserve existing Rust inference-based `resolved` facts when bridging current behavior. Expose `basis=inference` and the resolver version; callers may additionally require compiler basis. Do not demote accepted behavior during a storage refactor or silently upgrade a probable syntax candidate on import.

Normalize the explanation into shared records:

```text
ProviderDefinition(id, version, executable/protocol fingerprint)
ProducerRun(unit, input/environment digest, outcome, coverage)
Provenance(provider/configuration + unit/input fingerprint, basis, method, rule, assumptions)
Evidence(anchor or artifact pointer, optional expansion/spelling mapping)
Claim(fact, provenance, confidence, support group)
```

`basis` remains compatible with current syntax/compiler/lsp/inference/unresolved values; add structured inference method such as `lexical-inference` rather than multiplying confidence levels. The selected partition membership supplies the actual producer run in an explanation, without putting its attempt ID into immutable provenance identity. A sample explanation can render `provider=scip-clang`, `basis=compiler`, `indexingUnit=native/core`, `sourceOccurrence=O`, `buildTarget=linux-debug`. Shared JSON configuration belongs on the run/environment, not every edge. Matched syntax and documentation text are bounded pointers or interned blobs.

Derived confidence is computed per support alternative. A conjunction cannot be stronger than its weakest required semantic leg, and a probabilistic rule remains probable even with exact inputs. A disjunction can establish an existential relation through its strongest compatible supported alternative; expose confidence counts and competing conclusions. Confidence aggregation never erases conflict, staleness, partial coverage, or variant differences.

Freshness and completeness are orthogonal. A precise old claim is stale, not probable. A complete syntax provider is still syntax. Store run coverage and snapshot state independently; compact output includes important gaps rather than presenting an empty result as proof of absence.

## 14. Storage schema

### Keep SQLite; change its responsibility

Use one local SQLite database per configured index root, WAL, foreign keys, prepared batched writes, and one writer process. Readers pin a published snapshot in a short read transaction. Worker processes send bounded fact batches to the writer; they do not contend as independent writers. Retain `better-sqlite3`, but run ingestion/heavy queries off the server's interactive event loop. This is an architectural requirement, not an assertion that the current synchronous API scales.

Choose a hybrid: normalized typed tables for symbols/anchors/occurrences/common relations; a generic immutable fact catalog with validated native payloads; typed native tables when a predicate needs indexed joins; materialized common/compatibility projections. A generic entity-attribute-value triple store would make hot navigation expensive; one table per every possible native predicate would make early schema growth unnecessarily costly.

The following is a logical schema. Column encodings and physical clustering require Phase A measurements. All integer references use 64-bit keys. `entity` is the shared identity registry; typed payload tables reference its key. Facts and claims use stable content keys in addition to surrogate IDs. Typed tables carry `fact_id` for proposition payloads; identity tables do not imply active semantic claims.

| Table family | Principal columns / constraints |
|---|---|
| `schema_registry` | storage format, common fact schema, native predicate versions, projection versions, identity version, required reader features |
| `entities` | `eid PK`, `stable_key UNIQUE`, `kind`, canonical key; hash collision checked against canonical key |
| `repositories`, `workspaces`, `projects`, `packages`, `build_targets` | Typed identity rows keyed by `eid`; mutable properties represented by facts |
| `environments` | `environment_id PK`, canonical ordered resolution config, toolchain/lock/input digest; fingerprint unique |
| `units` | `unit_id PK`, stable unit key, project/target/provider partition, replacement granularity |
| `unit_contexts` | Immutable unit + environment + variant + configuration fingerprints |
| `input_resources` | Logical file/artifact/SDK/query-discovery key; location/root binding |
| `source_revisions` | Source entity + raw-byte digest + size + encoding + optional source-cache blob; unique source/digest |
| `anchors` | Entity key + source revision + nullable canonical byte range + verification state; provider ranges separate when conversion unavailable |
| `symbols`, `symbol_keys`, `legacy_aliases` | Symbol identities; unique scoped external keys; legacy ID to canonical/projection identity with ambiguity marker |
| `occurrences` | Entity key + anchor + semantic context + discriminator; classification/target assertions are facts |
| `facts` | `fact_id PK`, content key unique, logical key indexed for conflict/cardinality checks, predicate/version, context, payload hash, typed-table/payload pointer |
| `fact_refs` | Fact to referenced entity/fact and reference kind; structural integrity, not derivation support |
| `symbol_declarations`, `definitions`, `references`, `call_sites`, `call_targets`, `imports`, `type_uses`, `symbol_relations` | Typed common fact payloads; `fact_id PK/FK`, endpoints, roles/dispatch/qualifiers |
| `native_facts`, e.g. `rust_impls`, `cxx_specializations` | Registered versioned native payloads plus typed fields; required references available without JSON scanning |
| `providers`, `provenance`, `evidence`, `claim_evidence` | Interned provider/configuration/rule/source pointers; many-to-many evidence links |
| `claims` | `claim_id PK`, stable claim key unique, `fact_id`, provenance, confidence, optional support group |
| `partitions`, `partition_runs` | Base partition is unit/provider; derived partition is pass/version/shard; run input fingerprint/status/seal/coverage |
| `partition_claims` | `(run_id, claim_id) PK`; ownership of base or derived observations |
| `unit_inputs` | Run to input resource/digest, positive/negative dependency kind; reverse index for planning |
| `support_alternatives`, `support_inputs` | Derived claim to alternative conjunction; required input claim IDs or interned group members |
| `selector_dependencies` | Pass/unit partition to lookup scope/predicate/key + candidate-set digest; includes negative and configuration reads |
| `snapshots`, `snapshot_partitions` | Published snapshot metadata and exactly one selected sealed run/state per partition; parent snapshot/delta log for changes |
| `active_claims` | Transactionally maintained current-snapshot claim membership with supported/eligible state; previous snapshots use their partition manifests |
| `boundary_namespaces`, `boundary_operations`, `boundary_participation` | Identity rows and fact payloads; namespace equivalence is an asserted fact |
| `projection_nodes`, `projection_relations`, `relation_sites`, `projection_stats` | Snapshot/projection-version/variant/domain keys, endpoints, counts, effective confidence, support pointers |
| `diagnostics`, `coverage` | Snapshot/run/unit/provider scope and bounded text/blob pointers; no overwritten global diagnostic list |

Basic invariants require foreign keys and validation: `definitions` endpoints must be occurrence/symbol; call targets point to call sites and symbol/request entities; claims refer to validated facts; selected runs are sealed and schema-compatible. Cross-row semantic constraints are validated before publication, beyond what SQLite foreign keys enforce.

An unavailable partition has a selected state and no eligible run; it is not represented by an old successful run with a new timestamp. `active_claims` accelerates only the current snapshot. Historical queries resolve their pinned partition manifest and support eligibility, or a snapshot-specific materialization, never consult the current active map. Intern identical support conjunctions and batch provenance groups, but measure this compression separately from correctness.

### Indexes and query access paths

| Operation | Required index / materialization |
|---|---|
| Exact symbol/external key | `entities(stable_key)`, `symbol_keys(scheme,scope,key)` unique |
| Symbol name/prefix search | Materialized visible symbol names `(snapshot,variant,domain,name,stable_key)`; qualified name/package index; optional measured FTS5 token index |
| Definitions | `definitions(symbol_eid,occurrence_eid,fact_id)` joined to eligible active claims |
| References | `references(target_eid,occurrence_eid,fact_id)` plus occurrence-to-source path sort; materialized per-file counts for very large result sets |
| Occurrences at source position | `anchors(source_revision,start_byte,end_byte)` and `occurrences(anchor_eid,context)`; interval query strategy measured for overlapping macro ranges |
| Calls/sites | `call_targets(target_eid,call_site_eid,fact_id)`, `call_sites(owner_eid,occurrence_eid,fact_id)`; derived incoming/outgoing relation indexes |
| Callers/callees/affected | `projection_relations(snapshot,variant,domain,target,kind,confidence,source)` and symmetric source-first index |
| File/package dependencies | Materialized relation summary keyed by granularity/source/target/kind/variant; count statistics maintained by affected shard |
| Boundary query | `(protocol,namespace_eid,operation_key)` unique; participation indexes by operation/participant/direction; equivalent-namespace lookup |
| Ownership replacement | `partition_claims(run_id,claim_id)` and reverse `(claim_id,run_id)`; `snapshot_partitions(snapshot_id,partition_id)` |
| Input/pass invalidation | `unit_inputs(resource_id,run_id)`, `support_inputs(input_claim_id,derived_claim_id)`, `selector_dependencies(scope,predicate,key,partition_id)` |
| Current visibility | `active_claims(claim_id)` and per-fact eligible membership; store effective relation evidence counts, not repeated full evidence JSON |

Avoid leading-wildcard `LIKE` as the only name-search mechanism. Exact/prefix search is predictable; token search uses a bounded candidate index. Existing substring search can remain an explicit budgeted fallback. `EXPLAIN QUERY PLAN` and row-visit instrumentation are acceptance evidence; adding indexes without measuring their write amplification is insufficient.

Anchors within a small document can be scanned after an indexed source restriction; a giant generated document may require bucketing/R-tree experimentation. Do not make SQLite R-tree mandatory before overlap measurements. Use text/blob storage outside hot rows for source excerpts, signatures, or raw imports. Hash/intern large values; set quotas and define garbage collection.

### Compatibility and exports

Expose current `nodes`/`edges` shapes through storage views/repository methods or a materialized legacy projection, preserving current row converters during transition. Generate evidence JSON only for selected legacy query rows or a streamed export; it is no longer canonical edge storage. Small fixtures may still use an in-memory `GraphData`, but large analysis returns a manifest and graph handle/counts.

`exports/graph.json`, `manifest.json`, `diagnostics.json`, and `state.json` remain supported compatibility artifacts. Export graph JSON by streaming from a pinned snapshot. At monorepo scale allow explicit partitioned/NDJSON export and a manifest indicating whether the legacy whole export exists; sync must not read a graph export as its database. Filesystem exports are caches bearing a snapshot ID, never the publication authority.

### Layering choice

Start with immutable partition runs and a manifest of active runs, plus materialized current projections. This gives logical deltas without a recursive SQL stack of shadow tables. Snapshot manifests can initially copy partition membership; benchmark that cost before implementing persistent maps. Retain a bounded number of historical snapshots, then compact unreachable fact/claim/source rows in a separate maintenance transaction. Never garbage-collect while a retained snapshot needs a row.

If later measurements justify independent immutable database shards, shard by project/indexing unit with a registry for external symbol keys and cross-shard relations. That is a new storage phase with routing/transaction costs, not an assumed solution for 10M LOC.

## 15. Ownership and incrementality

### Ownership is observation lifetime, not source position

Base partition `(unit, provider, output-channel)` owns claims. A pass partition `(pass version/config, shard)` owns derived claims. Shared facts can have claims from several partitions. Replacing one unit removes its active claim membership; it does not delete another unit's observation of the same fact.

Entity references retain identity shells needed by visible facts. They **do not** retain old declaration/type/call assertions. This adapts Glean's ownership idea while preventing an incoming reference to a deleted function from resurrecting its obsolete definition. The remaining reference can point to an undefined/external identity with a coverage diagnostic. If the referencing provider's semantic inputs changed, its unit is invalidated too.

Derived support is **OR of alternatives, each an AND of required input claims and selector conditions**. For example a boundary path requires invocation, namespace mapping, and implementation; two independent registered handlers are separate alternatives. Dropping any required leg removes that alternative. The derived assertion is visible if another valid alternative exists. Identical fact content does not license substituting an incompatible-context claim.

Separate three dependency mechanisms:

1. **Structural references** keep entity/fact references well formed; no automatic semantic validity.
2. **Unit input dependencies** determine which providers must reindex after source/environment changes. Imports/includes/generated inputs can force broader units.
3. **Derivation and selector dependencies** determine which pass outputs must be hidden/recomputed. New symbols, candidates, or registrations can invalidate outputs even when previously read facts survive.

### Incremental algorithm

1. Inventory changed, added, removed input resources; periodically verify watcher hints with digest scans. Include lockfiles, inherited configs, toolchains, generated files, index artifacts, namespace maps, and discovery directories. Directory/package membership is an input so added files are not missed by positive-dependency tracking.
2. Compare discovery-plan fingerprints. Determine unit additions/removals and changed environments. Expand affected units through reverse input dependencies and provider-declared minimum reindex scope. If a provider cannot enumerate dependencies, invalidate its project or artifact partition conservatively.
3. Select the previous snapshot as the base. Stage replacement unit runs outside the publication transaction; do not remove current rows yet. Revalidate input fingerprints after extraction to detect edits during analysis. Cancel/replan changed inputs; do not seal facts from inconsistent source versions.
4. Compute changed claim eligibility, semantic selector-set hashes, and affected pass shards. Invalidate all dependent outputs including negative reads. A provider reports exported/API fingerprints only as an optimization when its correctness is qualified; until then use full unit dependency closure.
5. Run passes against the planned new snapshot, in DAG order, recording actual supports and selectors. Algorithms with unclear invalidation widen to package/project/global pass scope; never silently reuse unsupported results.
6. In one writer transaction validate selected runs/support closure and publish the new snapshot manifest, coverage, active membership, graph projections/statistics, and active-snapshot pointer. Check the expected parent to avoid competing publisher lost updates.
7. Commit, then regenerate requested exports through temporary files and atomic replacement. Every export carries snapshot ID. An export failure does not roll back a committed semantic snapshot; status reports stale/missing export caches and can regenerate them.

Input extraction may complete in chunks, but all externally visible facts of a replacement partition switch together. Readers holding a previous snapshot finish against it. A query must not combine new source facts with old derived relationships just because both rows exist physically.

### Dependency examples

- Change a C++ header: use reverse include/unit-input mapping to reindex consuming compilation units in the relevant variants. Syntax header ownership alone cannot determine this.
- Change a TypeScript exported overload or tsconfig resolution option: reindex its project and known dependents as needed; changes within a safe compiler incremental program may be handled by that provider, with outputs verified against full runs.
- Change a Rust feature/toolchain/build-script output: invalidate the associated crate/target context, often workspace dependents; existing syntax fallback remains separate.
- Add a Python module or stub: invalidate relevant import-search/discovery selectors, even if no previous positive import referred to the new file.
- Add a second API handler: invalidate unique-handler boundary conclusions via namespace/registration-set selectors.
- Remove a documentation section: remove its artifact-owned links; no code semantic reindex is required unless an explicitly configured mapping used that artifact as input.

### Versioning and failure semantics

Independent versions: storage format, identity algorithm, common/native predicate schema, provider mapping/implementation, pass rules/configuration, projection contract, and public API. Changing a grammar/compiler/decoder invalidates that provider's units and dependent passes. A projection-only rule change replays facts. An incompatible native predicate change invalidates its producers/readers; it does not automatically require parsing every language. Storage migration may require rewriting data without semantic reindex; unknown versions are refused rather than guessed.

| Situation | Publication/recovery policy |
|---|---|
| Unchanged inputs | Reuse selected partition runs; no export/full graph read |
| Provider unavailable for changed unit | Publish fresh syntax if available, mark semantic partition unavailable; old precise run remains historical |
| Provider partially succeeds | Publish only validated independent subunits when its ownership contract permits; otherwise one partial unit with explicit missing coverage |
| Provider crashes/cancelled/truncated output | No complete replacement run; retain previous snapshot as history or publish degraded current snapshot with unavailable semantic partition |
| Required pass fails | Hide its new affected outputs; degraded coverage or caller-required all-or-nothing abort |
| Crash before publication | Active pointer unchanged; clean abandoned staging/sealed unreferenced runs on recovery |
| Crash during publication | SQLite transaction rollback or complete commit; recover from database pointer |
| Crash after publication, before exports | Query committed snapshot; regenerate caches whose snapshot IDs disagree |
| Corrupt/incompatible database | Fail closed on writes; preserve old index, rebuild to staged database under the same chosen index root |
| Missing dependency closure | Explicit broader rebuild reason; no incremental claim |

Track source freshness separately from analysis completion. `status` retains `fresh/stale/missing` for compatibility and adds `coverageState=complete/partial/unavailable`, unit/variant reasons, pending passes, failed runs, and export state. A fresh syntax snapshot may have unavailable precise semantics. Queries expose the same distinction.

### Why not claim O(changed files)?

Correct work scales with changed units plus affected dependencies and pass selectors. A widely included header or compiler setting may require most of a repository. Fact ownership makes replacement possible; it does not shrink semantic dependency closure by itself. No global proportionality claim until benchmarked against realistic edit scenarios.

## 16. Query architecture

Retain `QueryService` as the single public facade; introduce storage-owned repositories for identity, navigation, relations, build context, boundaries, and knowledge. Public handlers do not write SQL or reconstruct graph semantics. Queries pin snapshot/projection/variant, apply scope and confidence in SQL before limits, and expose coverage.

| Query | Execution strategy | Compact result |
|---|---|---|
| Find symbol | Exact/key/prefix first; bounded token candidates ranked by name/project/definition evidence | Candidate identities, representative definitions, match reasons, ambiguity |
| Definition | Target binding + definition index; optional navigation relationships | Primary location plus alternatives, forward/body distinctions, source verification |
| References | Symbol target index + compatible navigation-expansion policy; keyset pagination | File-group counts and capped sample; explicit direct vs expanded references |
| Callers/callees | Indexed canonical relation view, distinct endpoint grouping | Symbols, site counts, bounded evidence sample, dispatch qualifiers |
| Neighborhood | Iterative indexed adjacency frontier; join visible nodes and filter domain before each expansion | Current bounded graph shape plus traversal budget/gaps |
| Affected | Reverse dependency traversal with visited set, depth/frontier/row/time budgets | Direct/transitive items, path explanations, tests, truncation; potential impact |
| Architecture | Preaggregated file/package/project/boundary shards | Bounded summaries, aggregate counts; no full symbol graph |
| Cross-language path | Bounded directed participation/namespace traversal | Symbols/occurrences and explicit boundary hops; no invented intra-process call |
| Relevant tests | Test facts/runner config and reverse dependency paths; optional measured coverage | Ranked tests, reasons, assumptions; no assertion that omitted tests cannot fail |
| Context for task | Token index retrieves candidates, then bounded semantic expansion and file ranking | Files/symbols/relationships/tests under a total byte budget |
| Native detail | Registered predicate-specific query with paging/capability check | Selected trait/template/overload/module details, no raw database dump |

Use SQL batches or temporary frontier tables for traversal; index both directions. Enforce work budgets during traversal, not after collecting all neighbors. At a hub, query bounded edges with deterministic ordering and signal omitted adjacency. Node cap, edge cap, depth cap, row-visit cap, deadline, and byte cap are separate. Exact total counts may be too expensive; return `hasMore` or estimated/unknown totals with labels. No expensive count solely to display a precise truncation number.

Query-time graph walks use a snapshot-scoped bounded cache only for repeated adjacency; they never hydrate `allNodes()`/`allEdges()`. Limit source excerpts/signatures and evidence expansion independently. Use a worker with cancellation/progress support for long SQLite operations so a deadline actually stops work. Offline full SCC computation or exports can be explicit jobs, not default interactive operations.

### Variant selection

Default to a configured target or the only complete target. If several incompatible variants exist, return ambiguity/variant summaries; do not take a silent union. An explicit union query labels per-variant support and cannot claim a path formed by incompatible edges. Every path must have a satisfiable context/variant intersection. Syntax fallback can supplement gaps as separate probable/unresolved observations, not conceal them.

### Query envelope

Proposed new semantic APIs return:

```json
{
  "snapshot": "s:...",
  "projectionVersion": "2",
  "variant": "linux-debug",
  "scope": "code",
  "coverage": {"references": "partial", "missingUnits": 2},
  "items": [],
  "truncated": true,
  "truncationReasons": ["byte-budget"],
  "nextCursor": "opaque snapshot-bound cursor",
  "limits": {"maxItems": 50, "maxEvidence": 1, "maxBytes": 32768}
}
```

Existing endpoints preserve their current root shapes during a compatibility window; add optional snapshot/coverage/truncation fields where safe and introduce versioned envelopes for new endpoints. Cursors bind snapshot, filter hash, variant, ordering, and projection version. An expired snapshot/cursor gives a restart-required response, never silently skips between revisions.

## 17. Agent-facing API implications

Keep current CLI commands and MCP tool names, scopes, probable/unresolved switches, `--index`, and compact/standard/full modes. CLI/API/MCP share query limits. Add navigation tools/endpoints for definition, references, occurrence detail, build contexts, cross-language path, relevant tests, and bounded evidence explanation. New names can be `get_definition`, `get_references`, `get_occurrence`, `get_cross_language_path`, `get_relevant_tests`, and `explain_fact`; final naming is an API review, not current functionality.

Preserve the broader accepted meanings of current `callers`/`callees` (which include some framework/type relations) in legacy mode. New precise call APIs distinguish actual call relations from rendering, invocation, type use, and boundary participants. Document this before changing defaults; do not silently narrow an existing agent workflow during schema migration.

Proposed default budgets:

| Operation | Default / hard interactive cap |
|---|---|
| Symbol/reference result page | 50 items / 200; grouped reference results by default |
| Graph neighborhood | Existing 50 nodes and depth 2; cap 500 nodes, 2,000 edges and depth 8 |
| Boundary summary | Preserve 200 identities/1,000 edges; paginate rather than increase automatically |
| Task context | Preserve 20 files/50 symbols; total 32 KiB compact payload target |
| Evidence | Preserve 1 compact/3 standard pointers; full remains capped, with explicit continuation |
| Adjacency work | Initial 10,000 visited rows and 2-second deadline; tune with benchmarks |

These are proposed tunable budgets. A full output mode increases detail, not unlimited work. Preserve evidence pointer IDs, provider/basis, occurrence/file/range, and explain how to request more. Report the number of omitted evidence sites and whether trusted semantics are unavailable. MCP responses must cap both structured data and rendered text representations; UI requests use the same budgets.

The UI initially renders symbol/file/package/operation summaries; selecting an edge opens sampled occurrences and paginated details. New build/coverage badges distinguish current syntax fallback from precise targets. Do not send full native predicates or all occurrences to React Flow/ELK. Layout time and browser memory are benchmarked independently of database query speed.

## 18. Migration from schema 1.2.0

### Separate internal format from public graph version

Introduce storage format 2 and common fact schema 2.0, independently versioned from the legacy graph projection 1.2 and package version. This document does not change any version constants. A later API break can version graph export separately; package `0.3.0` is not evidence of storage compatibility.

### Migration procedure

1. Ship a reader capable of recognizing format 1.2 and format 2. Old indexes remain queryable through a legacy reader with coverage labeled legacy. Do not call a legacy edge an occurrence-backed fact if evidence does not support that transformation.
2. On explicit analyze/sync upgrade, create a staged v2 database beside `graph.sqlite` inside the resolved index directory. Preserve the old database and all user configuration/custom-root behavior. Verify available disk space for database + WAL + export/migration overhead.
3. Ingest a conservative legacy bridge: nodes become legacy symbol/artifact identities and declaration claims; edges become `legacy.Relation` claims with original confidence/evidence/IDs. Only trustworthy ranges can become legacy evidence anchors. Whole-function node ranges do not reveal definition-token ranges; repeated/incomplete evidence cannot reconstruct complete references. Mark bridge capabilities accordingly.
4. Run converted producers into v2 partitions as they become available; the legacy bridge remains a full-analysis partition until accurate unit ownership exists. Do not infer safe ownership from `node.file` or evidence locations. Prevent duplicate public relationships by selecting one producer generation per migrated domain, while retaining originals for comparison/history.
5. Build the legacy projection and compare with baseline fixtures. Preserve original node/edge IDs in alias/legacy projection tables. If several symbols map to a legacy ID or one old node maps to several new variants, return explicit alternatives rather than choosing arbitrarily.
6. Validate integrity, coverage, projections, export counts/IDs, and snapshot publication, then close/checkpoint writers and switch the active database using a platform-tested atomic replacement/reopen protocol. Existing readers can finish their pinned old database handle; new requests reopen through the index resolver. Preserve a rollback copy.
7. Write snapshot-tagged cache exports after activation. Recovery consults the active database and migration marker, never trusts a partially written `state.json` as canonical. Remove backups only through explicit retention/maintenance policy.

Tests must cover Windows open-file behavior as well as POSIX replacement. If atomic replacement of an open database is unavailable, stop/reopen server/query handles through a controlled maintenance state or use a versioned database filename plus atomic catalog pointer. Do not delete the old index first.

### Legacy evidence limitations

Old `SourceEvidence` positions can lack end coordinates or a declared column encoding. Preserve them as provider-coordinate pointers; do not promise lossless byte conversion. Old node IDs can change if React changes kind, syntax overload order changes, or the checkout moves. Aliases preserve established IDs in that index, while new semantic IDs use explicit schemes. Unknown external/package scope remains checkout-local until mapping is validated.

During transition, sync for any unconverted legacy partition remains a full rebuild with an explicit reason. Full migration is not complete until all default TS/Rust/React/Tauri/artifact/knowledge outputs pass compatibility checks. Advanced providers are optional additions, not prerequisites for reading existing repositories.

## 19. Backward compatibility

| Contract | Preservation plan |
|---|---|
| TypeScript compiler-backed behavior | Default backend and focused fixtures retained; occurrences augment it; multi-project support is an explicit improvement |
| Rust conservative resolver | Preserve accepted resolutions/confidence and inference basis; precise provider is additive/optional |
| React | Component/callback/render relationships and visible kinds preserved via facets/legacy projection |
| Tauri | Registration/invoke/listen/emit behavior, command/event kinds/IDs retained; new app namespaces have explicit aliases |
| Six Tree-sitter frontends | Bundled syntax mode remains useful without compiler/indexer installation; existing candidates/unresolved evidence available |
| CLI/MCP/API/UI | Existing commands/tools/routes remain through facade; new APIs versioned/additive |
| Deterministic IDs | Preserve legacy projection IDs where inputs permit; explicit aliases and ambiguity for new canonical identities |
| Confidence/scopes | Same four values, trusted defaults, code and knowledge scopes |
| Custom output/index paths | All database, migration staging, caches, source/import retention stay under resolved index root; exclude it consistently |
| Status/sync/watch | Existing entry points/fallback reporting; new unit coverage/freshness; debounce reused; custom index event filtering improved |
| Knowledge Overlay | Artifact/linker logic bridged then migrated to versioned passes; no promotion of probable links to semantic proof |
| Generic boundaries | Protocol/namespace/operation retained; conservative explicit equivalence and occurrence participation |
| Standalone non-Git repositories | Checkout-local semantic identities and source digest snapshots supported |

Current code classes that survive conceptually: query facade, confidence filters, domain/scope model, bounded formatter, diagnostic vocabulary, index path resolution, watch debounce, boundary identity contract, and existing extractors as baselines. Runtime implementations may need targeted changes; the redesign does not claim those files can all stay unchanged.

Replace as authoritative contracts: whole-repository `RepositorySnapshot` text maps, graph-only `AdapterResult`, optional `resolve(snapshot,syntax)` as the only semantic route, mutable merge-by-ID reconciliation, fixed framework/artifact ordering, delete-and-repopulate persistence, full-graph query materialization, and evidence-file-based incremental ownership. Keep bridges until replacement behavior is verified.

## 20. Performance/scalability plan

### Workloads and bottlenecks

LOC is only a corpus label. Record files, symbols, occurrences, claims, targets/variants, generated-code share, includes, dependencies, and graph degree distributions. Benchmark at 100k, 1M, and 10M+ LOC with both controlled synthetic shapes and pinned real polyglot repositories. No current evidence qualifies these sizes.

| Stage | Expected bottleneck | Measurement / response |
|---|---|---|
| Inventory/parsing | Full text retention, synchronous parser CPU, repeated metadata reads | Bytes read, RSS/heap, parse throughput by language; lazy source reader, bounded worker queue/cache |
| Semantic providers | Project/typechecker RSS, compiler setup, build dependencies, macros/generation | Per-process time/RSS/input completeness; unit scheduling and provider-specific partitions |
| SCIP ingestion | Whole protobuf decode, giant documents, coordinate maps, repeated symbol strings | Peak RSS per batch/document, occurrences/sec; streaming/spill, integer interning |
| SQLite writes | Index amplification, JSON parsing, huge transactions/WAL, single writer | Rows/sec, transaction/commit/checkpoint times, WAL size; batch staging and measured index set |
| Occurrence volume | Reference multiplicity, templates/macros/variant duplication | Bytes per occurrence/claim, support/provenance ratio; separate anchors, contexts, blobs and counts |
| Derived graphs | All-site support storage, hubs, repeated aggregate rebuilds | Pass time/output growth/dependencies; per-shard summaries, bounded algorithms |
| Invalidation | Include/import fanout, negative dependencies, environment changes | Invalidated units/pass shards, false reuse, time vs full rebuild; conservative scope then qualified narrowing |
| Snapshot bookkeeping | Copying membership, support validation and retained history | Publication cost vs changed partitions and total partitions; active maps, compact manifests when justified |
| Queries | Full materialization, nonindexed name search, adjacency hubs, expensive totals | Rows visited, allocations, p50/p95/p99; indexed frontier/cursors/stats and actual deadlines |
| UI | Large layouts and occurrence expansion | Query/download/layout/render/RSS separately; summaries and progressive details |
| Watch/status | Full source reread per event, custom index self-events | Idle/no-op/one-edit cost; resource digest cache + periodic verification; resolved-root ignore rules |

### Initial experiment gates

These are engineering targets to accept or revise after baseline measurements, not performance promises. Reference setup: local SSD, 8 CPU cores and 32 GiB RAM; record OS/SQLite/Node/provider versions and cold/warm state. Report ProGraph memory separately from all child providers.

| Gate | Proposed threshold |
|---|---|
| 100k LOC basic local use | Syntax inventory/extraction/projection completes within 60 s and 1 GiB ProGraph RSS; external semantics timed separately |
| 1M LOC importer/projection | ProGraph peak RSS below 2 GiB with bounded document exceptions reported; published index fits declared disk budget; no full graph arrays on interactive path |
| 10M+ LOC | Complete offline streaming run under a configured memory budget (initially 4 GiB ProGraph); report total hours/provider limits; no fixed completion-time claim before evidence |
| SCIP import steady state | Measure baseline then target at least 50k occurrences/s on representative fixture; decoding, coordinate validation and writes included, external indexer time excluded |
| Hot navigation | Warm p95 <=250 ms for bounded symbol/definition/caller page; cold p95 <=1 s; includes formatting |
| Bounded traversal/context | p95 <=1 s for default budgets; 2 s hard work deadline with honest partial/truncated response |
| No-op sync | Aim <=1 s with validated digest cache at 1M LOC; separately measure cold full verification and report any unmet target |
| Small edit | Correct affected closure; publish overhead <=1 s for <=100 replaced partitions; provider time reported separately |
| Ingest/publication isolation | Small concurrent queries continue; publication p95 <=1 s for <=100 partitions; larger closures explicit background jobs |
| UI | Default <=100 visible summaries and progressive cap <=500 nodes; target <=1 s layout on reference browser and bounded memory |

Storage gates begin with measured bytes per symbol/anchor/occurrence/claim and normalized provenance/support overhead. Sweep 0.1M, 1M, 10M, and 50M synthetic occurrences with realistic duplicates and variants. Require near-linear base growth; investigate superlinear support memberships, indexes, snapshot manifests, or aggregate evidence. A 2x row-count increase should not create >2.5x base database growth on fixed-shape fixtures, excluding retained history; this is a regression alarm, not a universal compression ratio.

When 1M gates fail, fix global materialization/indexing/batch behavior before enabling more providers. If a single-writer database cannot meet measured read/write goals at 10M with bounded queries, prototype project sharding or another local engine with exactly the same query/invalidation workloads. Do not replace SQLite because a repository has a large LOC count.

### Benchmark protocol

Pin corpus revisions and dependency/toolchain inputs. Separate discovery, syntax, external indexing, import, passes, publication, exports, warm/cold queries, and UI timing. Measure both first-run and no-op/small-edit/header-edit/config-change/target-change/deletion/failed-provider scenarios. Repeated runs provide distributions and confidence intervals; compare against full-rebuild oracle for correctness. Track source verification/semantic coverage and false-positive relationships alongside speed. Publish hardware/raw metrics and reproducible commands in a future benchmark artifact; do not cite external systems' timings as ProGraph evidence.

## 21. Testing strategy

### Foundation and storage

Property tests: deterministic canonical IDs, fact deduplication independent of ingestion order, provider-claim separation, role combinations, hash collision detection, and snapshot visibility. Unicode/CRLF fixtures cover UTF-8/16/32 conversion, zero-width/multiline/typed/packed ranges, missing source, and invalid offsets. Storage tests cover foreign keys, schema rejection, repeated import, prepared batches, bounds, and normalized evidence reconstruction.

### Semantic conformance

Maintain a capability matrix with tests per provider/version/project mode. Navigation correctness uses explicitly annotated symbol/occurrence fixtures, not counts alone. Differential tests compare compiler/indexer facts where meaningful; disagreements become retained evidence and investigation, not a majority vote.

Required negative cases include function reference versus call, overload sets, shadowing/rebinding, namespace collisions, C/C++ shared `.h`, include/define variants, macro generated/spelled locations, Rust traits/associated items/cfg, Java/.NET target boundaries, Python namespace packages/dynamic imports, Go build tags, TS project references/re-exports, and generated client/handler bindings. A missing provider must preserve fallback evidence and reduce coverage rather than invent targets.

### Passes and incremental oracle

Verify every derived relation's full support and selector dependencies. Test a new candidate invalidating a previous unique binding, deleted definitions retaining only referenced identity shells, alternate supports surviving removal of one owner, and incompatible variants never forming a path. Random sequences of add/edit/delete/config/provider/pass-version changes compare visible incremental facts/projections with a clean full rebuild. Comparison ignores run timestamps/history but includes claims, confidence, coverage, and evidence. This is the gate for enabling narrower invalidation.

### Recovery, compatibility, and scale

Inject crashes before/during/after staging/seal/publication/export; test concurrent readers, competing publishers, cancellation, provider stderr/output limits, failed optional passes, disk exhaustion, corrupt import/database, and schema upgrades. Verify DB snapshot and cache exports disagree visibly after interrupted export. Migration/rollback/custom-directory tests run on macOS/Linux/Windows, including open-file replacement.

Run existing core/polyglot/Rust/React/Tauri suites at each relevant migration step; focused fixture snapshots compare legacy IDs/kinds/confidence/scopes. CLI/MCP/API/UI response tests enforce item/evidence/byte caps, pagination stability, stale cursors, coverage labels, and distinction between no results and incomplete semantics. Large synthetic tests include one giant file, high-degree hubs, many variants/shared headers, overlapping expansion anchors, and support explosion. Use query plans and memory metrics, not just a returned node cap.

Optional advanced analysis needs hand-reviewed CFG/def-use/exception-flow fixtures and known dataflow paths; passing navigation tests does not qualify CFG, PDG, taint, or security analyses.

## 22. Risks and rejected alternatives

| Risk | Mitigation / open empirical question |
|---|---|
| False identity unification across providers/repos/variants | Preserve external keys, explicit equivalence, ambiguous aliases; prototype dev-package and macro/template identities |
| SCIP supplies navigation but insufficient call/native data | Qualify facts per category; enrichment with source/native APIs; retain unknown references |
| Incorrect build-context discovery | Ordered hashed inputs and missing-context coverage; compiler manifests are preferred over guessed settings |
| Incrementality misses negative dependencies or semantic imports | Record selectors/discovery keys; full-rebuild oracle; widen invalidation until qualified |
| Ownership propagation keeps obsolete semantics | Separate identity retention from active assertion support; conjunction/disjunction test cases |
| Occurrences/support tables dominate size | Normalize, intern support groups, aggregate summaries; measure before compression/sharding |
| Contradictory/malformed providers contaminate trusted results | Per-run staging/validation, independent claims, conflict policy; quarantine invalid units |
| Snapshot copy/publication becomes O(repository) | Measure membership/projection update costs; copy-on-write manifests only if necessary |
| SQLite event-loop stalls or writer saturation | Worker/writer architecture, bounded reads, WAL metrics; alternative engine only after matched workload evidence |
| Migration breaks useful IDs/query meanings | Legacy projection/aliases, dual reader, focused compatibility tests, rollback |
| Generated/proc-macro/build execution has unexpected effects | Discovery-only default, configured runners/effects, no implicit command execution |
| Advanced IR erases language-specific control flow | Native lowering contracts; opt-in function-level analysis and explicit unsupported constructs |

Rejected alternatives:

- **Emit only more `GraphNode`/`GraphEdge` data:** cannot represent multi-provider observations, occurrence roles, or reliable invalidation without another hidden model.
- **Make SCIP the complete internal representation:** loses build/ownership/native/knowledge/advanced analysis semantics and encourages call inference from references.
- **One compiler-specific importer per language:** duplicates transport and identity handling; generic SCIP plus runners/enrichment is smaller. Native APIs remain allowed.
- **Use LSP for every repository-wide index:** capability/coverage/source synchronization and request volume vary; use selectively rather than assume complete extraction.
- **Persist a universal AST/CFG/PDG for every file immediately:** unnecessary storage/provider complexity before precise navigation; not all syntax frontends can supply sound execution semantics.
- **Flat JSON metadata as native fact storage:** difficult validation, relation indexing, ownership references, and migrations. JSON remains useful for cold extensions with schemas.
- **Generic triples only or a new graph server immediately:** local deployment regresses and indexed navigation is not automatically improved.
- **Maximum-confidence merge with last-writer wins:** erases contradictions and can join incompatible variants; independent claims and explicit projection rules replace it.
- **File ownership inferred from edge evidence:** includes/imports/framework/global lookup invalidation cannot be derived safely from source ranges.
- **Port Glean's full stacked/distributed engine:** unnecessary operational scope; logical immutable runs and snapshot maps provide the initial mechanism.
- **Apply commits to every semantic ID:** destroys stable navigation on unrelated edits; source revisions and run contexts track change separately.
- **Promise complete impact/test selection:** dynamic dispatch, reflection, runtime routing, external code, and incomplete coverage prevent such a claim.

Decisions sufficiently firm for implementation: layered facts/projections, first-class occurrences, explicit contexts, normalized provenance, generic SCIP import, ownership from inception, conservative boundaries, SQLite first, and bounded queries. Open choices requiring prototypes: physical fact/support layout, importer streaming implementation and limits, cross-provider symbol equivalence, target-variant representation costs, provider-qualified call enrichment, incremental closure compression, and the publication/migration protocol on all platforms.

## 23. Phased implementation plan

Do not follow A–F as independent sequential silos. Introduce minimal units/ownership/query paths in A; complete build discovery before precise ingestion; introduce pass support tracking before ownership-based optimization. A small vertical slice must prove the architecture before converting all producers.

The components named below are likely ownership locations; new directory/file names are proposals. Each phase is independently reviewable and keeps default extraction behavior through bridges.

### Phase A — Fact foundation with a TypeScript vertical slice

**Objective:** Prove symbol/occurrence/fact/claim storage and a bounded definition/reference/call-summary path while preserving existing graph outputs.

**Changes:** Add versioned predicates/identities, anchors/coordinate conversion, interned provenance, minimal repository/project unit contexts, base partition ownership, staged runs and atomic snapshot publication. Bridge existing graph adapters conservatively. Convert selected TypeScript declarations/call sites/references without replacing ts-morph. Add minimal derived relation support and SQL navigation; maintain legacy projection. Full rebuild remains the sync default for migrated partitions.

**Likely components:** New `src/core/semantic/{facts,identity,coordinates,validation}` and storage repositories; `graph/schema.ts`, `graph/identity.ts`, `storage/sqlite.ts`, `analysis/analyze.ts`, `adapters/contracts.ts`, `query/query-service.ts`; TS adapter and focused fixtures.

**Migration risks:** Incorrect range conversion or identity aliases; duplicate legacy/canonical output; ambiguous ownership fabricated from legacy evidence. Use one full legacy partition and explicit migrated-domain selection.

**Validation/gate:** Existing TS/Rust/React/Tauri/polyglot contracts pass; deterministic fixture round trips; Unicode/range tests; independent provider claims; crash-safe publication; bounded SQL query plans. Measure 1M synthetic occurrences and provenance/support storage. Review results before committing physical schema details to every language.

**Possible afterward:** Evidence-addressable navigation and explainable call summaries for the converted TS slice, with fresh snapshot metadata and legacy graph compatibility.

**Unsupported:** Complete multi-project discovery, external indexer runners, fine-grained incremental sync, arbitrary native type models, CFG/dataflow, 1M LOC performance qualification.

### Phase B — Project/build planning and provider contract

**Objective:** Make project/target/environment inputs real semantic contexts instead of file metadata.

**Changes:** Discovery inventory, source reader, units/environments/input dependencies and negative discovery keys; provider streaming/planning/outcome contracts; nested TS projects, Rust crates/features, C/C++ compilation units/header selection, and discovery-only models for JVM/.NET/Python/Go. Separate generated/dependency inputs from display sources. Version capabilities per unit. Configure optional tool-backed discovery explicitly.

**Likely components:** New `src/core/projects`, `src/core/indexing`; `repository/repository.ts`, `config/config.ts`, `adapters/providers.ts`, `analysis/{analyze,state}.ts`; TypeScript/Rust/polyglot adapters; manifest artifacts.

**Migration risks:** Changed source selection/resolution, added generated inputs, ambiguous target defaults, incorrectly normalized command arguments. Retain root-project compatibility mode and record differences.

**Validation/gate:** Ordered contexts/flags/classpaths hashed correctly; multiple commands per source; shared C/C++ `.h`; TS extends/references; Rust cfg/features; missing dependencies and generated files; no implicit builds. Provider availability versus run coverage tests. Environment changes invalidate correct units conservatively.

**Possible afterward:** Reproducible multi-project plans and explicit target/coverage explanations; compilation context feeds configured semantic providers.

**Unsupported:** Claiming all build systems are completely discovered, automatic dependency installation, executing build scripts by scanning, narrow semantic invalidation without provider dependency evidence.

### Phase C — Precise semantic interchange and language enrichment

**Objective:** Add precise navigation across selected polyglot projects without multiplying importer implementations.

**Changes:** Generic SCIP decoder/import manifest/root mapping/range/symbol validator; artifact-owned unit runs; optional pinned runners; initial TypeScript/Python then C/C++ qualification; native predicate registration and minimal enrichment. Add reference/definition APIs across converted providers. Retain in-process TS and all fallback frontends. JVM/Go/Rust/.NET adoption follows separate capability gates.

**Likely components:** New `src/providers/scip/{decoder,importer,mapping}`, provider runner packages and language native schemas; `adapters/providers.ts`, `storage`, `projects`, `query`; optional config/API/CLI import commands and fixtures.

**Migration risks:** Index/source mismatch, workspace package collisions, local-symbol scoping, large protobuf decoding, provider-specific incomplete output. External artifact replacement remains coarse unless declared independently safe.

**Validation/gate:** Protocol golden fixtures including historical/current ranges and unknown fields; corrupt/path/mismatch tests; differential compiler navigation; actual native multi-target fixtures; partial provider coverage; import/memory/write metrics at 0.1M/1M/10M occurrences. A reference-only import must not create a call.

**Possible afterward:** Precise definitions/references from qualified providers, external symbol identities and scoped cross-repository navigation; optional semantic gains for syntax-heavy languages.

**Unsupported:** Universal identical indexer capabilities, complete dynamic calls, full native semantics from SCIP alone, all-language precise extraction by default.

### Phase D — Generalized passes and compact projections

**Objective:** Move derived framework, boundary, architecture, impact, test, and knowledge relationships into explicit supported passes.

**Changes:** Pass DAG/shards/read views, support groups and selector tracking, call/inheritance summaries, namespace-aware participant linking, React/Tauri facets, knowledge/test passes, incremental projection shards, bounded SQL traversals/context/architecture. Add occurrence/evidence and cross-language path UI/API/MCP features. Complete legacy-adapter conversion where needed.

**Likely components:** New `src/core/passes` and `src/core/projections`; `adapters/framework`, `adapters/artifact`, `adapters/overlay/semantic-linker`; `query/{query-service,output-mode}.ts`; CLI/MCP/server/UI.

**Migration risks:** Different caller/callee aggregation and query meanings, lost knowledge scopes, false route/namespace joins, support explosion. Preserve legacy per-evidence view and new precise endpoints separately.

**Validation/gate:** Full-support explanations, negative-selector conflicts, namespace collision and variant-path tests, existing framework/knowledge fixtures, distinct caller/site counts, SQL work/output caps, 100k/1M corpus query benchmarks and UI budgets.

**Possible afterward:** Explainable common graph above richer native facts, practical bounded agent context and cross-language paths, failure-isolated pass outputs.

**Unsupported:** Guaranteed whole-program impact/test relevance, runtime boundary discovery, full graph visualizations at monorepo scale, CFG/PDG claims.

### Phase E — Ownership-based incremental execution

**Objective:** Replace conservative full rebuilds where input closure and pass invalidation can be proven.

**Changes:** Unit change planner, reverse input closure, selector invalidation, support-eligibility recomputation, snapshot deltas, garbage collection/retention, incremental status/watch/source caching. Begin package/project/artifact replacement, then narrow only qualified provider units. Use provider API/export fingerprints only after oracle evidence.

**Likely components:** `analysis/{state,sync,watch}.ts`, indexing scheduler, ownership/support/storage repositories, pass scheduler, server status/sync and UI coverage; custom-root resolver integration.

**Migration risks:** False reuse after additions, toolchain changes, header dependencies or partial failures; historical precise outputs mistaken for current facts; snapshot maintenance cost.

**Validation/gate:** Random-edit and adversarial full-rebuild equivalence; crash/disk/concurrent reader cases; provider/pass/schema-version changes; negative lookup additions; alternate supports; stale export recovery; real header/config/API edit benchmarks. Enable each narrow invalidation rule only after this gate.

**Possible afterward:** Correct replacement by affected units/pass shards, predictable failure recovery, lower cost for qualified local edits.

**Unsupported:** O(changed files) guarantees, file-granular rebuilds for project-only providers, zero broad invalidation for global build changes, distributed indexing/storage.

### Phase F — Optional deeper program analysis

**Objective:** Add execution/data semantics where an actual user query and a qualified language IR justify the cost.

**Changes:** Native function-level AST/IR lowering, CFG/exception modeling, dominators/post-dominators, def/use and reaching definitions, control/data dependence, bounded dataflow slices; explicit library summaries and alias/dispatch assumptions. Choose one language/project mode first; store advanced facts under optional analysis partitions.

**Likely components:** New language IR provider/enrichment packages and `passes/{cfg,dominators,dataflow,dependence}`; predicate/storage schemas; bounded slice APIs/UI; native fixtures.

**Migration risks:** Unsound language lowering, support/storage explosion, expensive fixed points, implication that navigation qualifies security/dataflow analyses. Keep separate capability and assumption reporting.

**Validation/gate:** Hand-reviewed control/exception/def-use fixtures, differential compiler IR where feasible, known positive/negative paths, function memory/time limits, dependency invalidation tests, proof that optional analysis leaves basic navigation latency intact.

**Possible afterward:** Qualified intra-procedural analyses and selected interprocedural summaries/slices for supported language modes.

**Unsupported:** Universal sound polyglot taint/security analysis, complete heap/alias analysis, arbitrary runtime reflection or foreign ABI dataflow, default persistence of every AST/PDG.

### Recommended first engineering task and lock-in gates

Begin Phase A with one fixture containing TS definitions, imports, function-valued references, direct calls, overloaded/ambiguous bindings, Unicode locations, and a React facet. Store symbols/occurrences/claims under one explicit project unit, publish a snapshot, and serve a bounded definition/reference/caller query beside unchanged legacy graph output. Include deletion and crash-before-publication cases. This tests the architectural seam without a broad rewrite.

Before locking the physical schema, measure three isolated designs: occurrence/provenance/support row layout; streamed SCIP decoding with a giant-document limit; and snapshot publication/support invalidation under alternate and negative dependencies. These are future prototypes, not files created by this design task. Before enabling a provider, qualify its actual project/variant and call-enrichment behavior. Before promising large-repository use, publish the staged benchmark evidence. No additional implementation is required to accept this design document.
