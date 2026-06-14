# ProGraph Architecture

## Goals And Boundaries

ProGraph is an independent installable developer tool. Its graph is the shared data model for human visualization, CLI queries, JSON export, the local API, and MCP stdio tools.

The first milestone is local-only and static-analysis-only. It does not implement runtime tracing, cloud analysis, source modification, complete control-flow or data-flow analysis, or a full Rust semantic engine.

## Analysis Pipeline

```text
repository path
  -> root resolution
  -> optional configuration
  -> read-only repository scan
  -> language adapters
  -> framework adapters
  -> identity validation and diagnostics
  -> SQLite canonical store
  -> JSON, manifest, diagnostics, and index-state exports
  -> CLI, localhost API/UI, and MCP stdio queries
```

### Repository Scanner

The scanner resolves an arbitrary input path to the nearest repository marker and reads supported source files without following symlinks. It also reads relevant repository metadata such as `package.json`, `Cargo.toml`, TypeScript configuration, and Tauri configuration for detection and compiler setup. Metadata files are not counted or parsed as source files.

Default exclusions prevent analysis of installed packages, Cargo build output, VCS metadata, ProGraph output, vendor directories, and common generated artifacts.

Repository analysis is read-only. The default output boundary is `<repository>/.prograph/`; `--output` moves all ProGraph output to an explicit alternative directory.

### Configuration

`prograph.config.json` may override source inclusion, add exclusions, or disable adapters. No configuration is required. Invalid configuration becomes a structured diagnostic and analysis continues with defaults.

## Adapter Contracts

Language and framework contracts live under `src/core/adapters/`.

A language adapter:

- detects whether it applies to the repository snapshot;
- parses supported source files;
- emits graph nodes, graph edges, source evidence, and diagnostics;
- reports file/parser failures without terminating the full analysis.

A framework adapter:

- detects whether it applies from manifests, configuration, imports, and framework syntax;
- inspects the current language-level graph and read-only source snapshot;
- adds or refines framework nodes and edges;
- preserves confidence, evidence, and framework diagnostics.

Framework logic does not live in the generic graph core.

## TypeScript Adapter

The TypeScript adapter uses `ts-morph`, which exposes the TypeScript compiler API. It loads the repository's root `tsconfig.json` or `jsconfig.json` when present, while explicitly adding only source files selected by the repository scanner.

The adapter extracts:

- files, imports, and re-exports;
- functions, nested function declarations, arrow functions, methods, classes, interfaces, and type aliases;
- direct calls and constructor calls;
- type references;
- unresolved imports and calls;
- exact source ranges.

Unique compiler-symbol targets are `resolved`. Calls that cannot be uniquely resolved produce `unresolved` edges. ProGraph avoids flooding diagnostics for every unresolved chained library method, but preserves those relationships as low-confidence graph data.

## Rust Adapter

The Rust adapter uses Tree-sitter with the Rust grammar. It extracts:

- files, modules, functions, methods, structs, enums, and traits;
- direct call syntax and method-call syntax;
- attributes owned by the exact AST item they decorate;
- repository-local module paths and `use` bindings;
- conservative receiver types from parameters, local annotations, constructors, current `impl` blocks, and `Self`;
- macro invocation metadata;
- source ranges and parser recovery diagnostics.

Fully qualified local paths, nested and test modules, imported aliases, repository-local re-exports, wildcard parent imports, same-module functions, and uniquely identified inherent associated functions or methods may be `resolved`. Repository-wide unique-name fallback is `probable` because it is still name-based. Ambiguous trait dispatch, external calls, macro-expanded targets, and missing targets remain `unresolved`.

The adapter intentionally does not reproduce macro expansion, Cargo's full build graph, rustc type resolution, trait dispatch, or rust-analyzer.

## React Adapter

The React adapter is separate from TypeScript extraction. It identifies function-like nodes that have component-like names or JSX evidence, refines those nodes to `react_component`, and emits:

- `renders` edges for statically named JSX components;
- `passes_callback` edges when a callback prop resolves to one extracted function;
- diagnostics for callback props that cannot be uniquely resolved.

Name-only component and callback matches are `probable`; they are not trusted by default. The adapter does not infer runtime render behavior.

## Tauri Adapter

The Tauri adapter activates from Tauri package/Cargo/config evidence or direct Tauri imports and builder syntax. It matches:

- frontend `invoke("literal_command")` calls;
- Rust functions whose structured item metadata owns `#[tauri::command]`;
- each individual handler token inside `tauri::generate_handler![...]`;
- literal frontend events and Rust event names resolved from literals or simple repository-local string constants.

Framework command and event nodes provide the stable cross-language identity. `invokes`, `registers`, `emits`, and `listens` edges retain their source evidence. Diagnostics identify unmatched invokes, duplicate command names, unregistered commands, missing registered definitions, unused commands, and unmatched event producers or consumers.

Dynamic command and event names are preserved as unresolved expressions and do not produce false unmatched producer/consumer diagnostics.

## Unified Graph IR

The graph schema lives in `src/core/graph/schema.ts`.

Nodes include a stable ID, kind, display and qualified names, language, source location, producing adapter, and metadata. Supported first-milestone kinds include repository, directory, file, module, symbols, React components, Rust types, framework commands/events, external packages, and unresolved symbols.

Edges include a stable ID, source, target, kind, confidence, source evidence, and metadata. The same IDs, kinds, confidence values, and evidence appear in SQLite queries, CLI JSON, API responses, exports, and the UI.

### Deterministic Identities

Primary IDs use a truncated SHA-256 digest over stable source identity:

- repository identity;
- language;
- normalized repository-relative file path;
- node or edge kind;
- qualified symbol name;
- source offset or evidence where needed to disambiguate overloads and duplicate names.

Random UUIDs are not used. Duplicate generated identities become structured diagnostics.

### Confidence Model

- `exact`: direct syntax or framework identity establishes the relationship with no ambiguity, such as file containment, an owned `#[tauri::command]`, or a literal Tauri registration.
- `resolved`: a parser/compiler symbol or a unique supported resolution establishes the target.
- `probable`: one strong heuristic candidate remains, but supported analysis does not establish full semantic proof.
- `unresolved`: source evidence exists, but no unique target can be established.

Name similarity alone is never labeled `exact` or `resolved`.

### Evidence Model

Evidence may include file, line, column, end range, producing adapter, matched syntax, binding name, and resolution method. Uncertain evidence is retained rather than silently discarded. Unresolved targets are scoped to their source owner. Common low-value method names are aggregated within that scope, while exact call-site expressions remain on edge evidence.

## Diagnostics

Diagnostics are structured records with code, severity, message, optional source location, adapter, and metadata. Analysis continues after individual parse failures and invalid configuration.

Current diagnostics cover parser recovery/failure, unreadable files, unresolved imports and calls, duplicate IDs, duplicate framework command names, unmatched framework bindings, and invalid configuration. `state.json` supports separate repository freshness reporting through content hashes, configuration hashes, adapter versions, schema versions, and Git metadata.

## SQLite Storage

`graph.sqlite` is the canonical persistent query store. It records:

- schema and tool metadata;
- repository metadata and analysis runs;
- files, nodes, edges, and diagnostics;
- adapter runs.

Indexes cover node ID/name/qualified name/file/kind, edge source/target/kind, and diagnostic severity. Analysis replaces the current graph tables transactionally while retaining the analysis-run history row.

## JSON Export And Manifest

`.prograph/exports/graph.json` contains the portable graph IR. `manifest.json` separately records schema and tool versions, repository identity, optional Git commit, enabled adapters, counts, generation time, and analysis duration. `diagnostics.json` provides direct access to structured diagnostics. `state.json` records indexed file hashes, configuration hash, adapter versions, schema version, and Git metadata used by status and sync.

The JSON export is not the canonical local query store.

## Query Services

`QueryService` owns repository overview, architecture summaries, files, file relationships, symbol search/details, callers, callees, bounded neighborhoods, cycles, framework bindings, deterministic task context, bounded affected-change traversal, and diagnostics.

The CLI and local API call this service directly. UI-specific graph logic is limited to visual filtering and deterministic layout; the UI does not duplicate dependency extraction or repository query semantics.

Bounded graph queries cap depth, node count, and selected edges to keep agent output and visual expansion manageable. Graph relationships default to the trusted `exact` and `resolved` confidence levels. Probable and unresolved data require explicit opt-in and remain available in storage, exports, and diagnostics. Default symbol search excludes unresolved symbols.

The shared output formatter supports `compact`, `standard`, and `full` representations plus evidence limits. Agent-oriented CLI JSON and MCP results default to compact output; the SQLite graph remains unchanged.

## CLI

The Commander-based CLI resolves repository paths independently of the ProGraph install directory. JSON mode writes requested machine-readable results to stdout. Errors use stderr and a nonzero exit code.

Queries and local servers accept `--index <directory-or-graph.sqlite>` for first-class custom output discovery. Without `--index`, ProGraph remains backward compatible with `<repository>/.prograph/graph.sqlite`.

`status` reports index freshness. `sync` reuses unchanged indexes, incrementally reparses isolated framework-neutral files when graph ownership makes that safe, and otherwise performs a full rebuild with an explicit fallback reason. `watch` debounces local filesystem events and invokes the same sync engine.

The package `bin` entry exposes `prograph` from `dist/cli/index.js`.

## Local Server

The Express server binds to `127.0.0.1` by default, serves the built UI, and maps API routes directly to `QueryService`, status, and sync. It does not expose a public network listener by default.

## UI

The React UI uses React Flow for interaction and ELK.js for deterministic layered layout. The Evidence Workbench visual direction prioritizes:

- bounded progressive graph views;
- a token-based dark technical workspace with the graph as the primary surface;
- source evidence and confidence;
- trusted-only graph views with explicit probable and unresolved confidence controls;
- selected-neighborhood emphasis with incoming and outgoing relationship styling;
- stable graph IDs;
- repository hierarchy and adapter status;
- architecture lanes derived from supported evidence;
- file, symbol, framework, context, affected, and diagnostic views;
- index freshness, stale warnings, and explicit sync;
- compact, standard, and full evidence controls;
- a bounded evidence-first inspector that keeps raw metadata collapsed by default;
- an internal English and Simplified Chinese localization layer that leaves source identities unchanged.

The default page does not render the complete symbol graph.

## MCP Stdio Integration

`prograph mcp [path]` uses the official MCP TypeScript SDK and stdio transport. It binds no network port. Handlers are thin wrappers around `QueryService` and repository status, and compact bounded responses are the default. Exposed tools include:

- `get_repository_overview`;
- `get_status`;
- `find_symbol`;
- `get_symbol`;
- `get_callers`;
- `get_callees`;
- `get_file_dependencies`;
- `get_reverse_dependencies`;
- `get_neighborhood`;
- `get_cycles`;
- `get_framework_bindings`;
- `get_context`;
- `get_affected`;
- `get_diagnostics`;

MCP accepts explicit repository or custom-index context and does not maintain a separate graph model.

## Future Adapter Expansion

New language adapters should preserve the graph IR, deterministic identity rules, confidence semantics, and source-evidence requirements. New framework adapters should consume existing language-level graph data and add framework-specific bindings without changing the graph core.

Near-term priorities are dependency-aware partial invalidation for connected files, broader source verification of conservative Rust resolution, and refinement of bounded context and affected-test ranking.
