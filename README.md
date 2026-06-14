# ProGraph

ProGraph is a standalone, local-first repository visualization and code-intelligence tool. It analyzes a source repository into one evidence-backed graph that serves both the interactive human UI and compact machine-readable CLI queries.

```text
Source repository
  -> language and framework adapters
  -> unified graph IR
  -> SQLite query store
     -> CLI queries
     -> MCP stdio tools
     -> JSON export
     -> localhost visualization
```

ProGraph does not modify analyzed source repositories. Its default repository-local output is `.prograph/`, and it never adds that directory to `.gitignore`.

## Supported Analysis

The first milestone supports:

- TypeScript, TSX, JavaScript, and JSX through `ts-morph`;
- Rust syntax through Tree-sitter;
- statically identifiable React components, JSX renders, and callback props;
- statically identifiable Tauri commands, handler registrations, invokes, and named events.

TypeScript compiler-backed relationships are marked `resolved` when a unique symbol is available. Rust repository-local module paths, imports, and safely inferred inherent methods may be `resolved`; name-only heuristics remain `probable` or `unresolved`. ProGraph does not claim to replace rust-analyzer, Cargo, or the Rust compiler.

## Installation

Install the package globally:

```bash
npm install -g @xpan0988/prograph
cd /path/to/project
prograph analyze .
prograph open .
```

Local development:

```bash
cd prograph
npm install
npm run build
npm link

cd /path/to/test-project
prograph analyze .
prograph serve .
```

Verify the executable:

```bash
prograph --help
prograph --version
```

Uninstall the linked or global package:

```bash
npm unlink -g @xpan0988/prograph
```

## Analyze A Repository

No configuration or initialization is required:

```bash
cd /path/to/project
prograph analyze .
```

By default, ProGraph writes only:

```text
.prograph/
├── graph.sqlite
├── manifest.json
├── diagnostics.json
├── state.json
└── exports/
    └── graph.json
```

Use an alternative output directory when repository-local output is undesirable:

```bash
prograph analyze /path/to/repository --output ./tmp/external-index
```

Query or serve that custom index directly:

```bash
prograph callers <symbol-id> --repo /path/to/repository --index ./tmp/external-index --format json
prograph serve /path/to/repository --index ./tmp/external-index
prograph status /path/to/repository --index ./tmp/external-index
prograph sync /path/to/repository --index ./tmp/external-index
```

`graph.sqlite` is the canonical query store. The JSON export is a portable representation, not the canonical query source.

## Configuration

`prograph init [path]` creates an optional `prograph.config.json`. It does not modify `.gitignore`.

```json
{
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src-tauri/src/**/*.rs"
  ],
  "exclude": [
    "node_modules/**",
    "dist/**",
    "build/**",
    "target/**",
    ".git/**"
  ],
  "adapters": {
    "typescript": true,
    "rust": true,
    "react": true,
    "tauri": true
  }
}
```

Without a configuration file, ProGraph discovers supported source files throughout the repository. Default exclusions include dependency directories, build output, coverage output, `.git`, `.prograph`, vendor directories, and common generated-artifact paths.

## CLI

Repository paths default to the current working directory where sensible.

```text
prograph init [path]
prograph analyze [path] [--output path]
prograph status [path] [--index path]
prograph sync [path] [--index path]
prograph watch [path] [--index path]
prograph mcp [path] [--index path]
prograph serve [path] [--port number]
prograph open [path] [--port number]
prograph overview [path]
prograph files [path]
prograph file <file> [--repo path]
prograph symbol <query> [--repo path]
prograph callers <symbol-id> [--repo path]
prograph callees <symbol-id> [--repo path]
prograph neighborhood <symbol-id> [--repo path]
prograph context <task> [--repo path]
prograph affected <file-or-symbol> [--repo path]
prograph cycles [path]
prograph diagnostics [path]
prograph adapters [path]
prograph framework tauri [path]
```

Query and server commands accept `--index <directory-or-graph.sqlite>` while preserving default `.prograph/graph.sqlite` discovery.

Most query commands support text and JSON output:

```bash
prograph symbol run --format json
prograph neighborhood typescript:function:0123456789abcdef \
  --depth 2 \
  --max-nodes 50 \
  --edge-kind calls invokes \
  --format json
```

Agent-oriented JSON queries default to `compact` output. Use `--mode standard` for additional semantic fields or `--mode full` for complete stored records, and bound repeated evidence with `--max-evidence`:

```bash
prograph neighborhood <symbol-id> --depth 2 --max-nodes 30 --mode compact --max-evidence 1 --format json
prograph context "transfer planner tests" --max-files 20 --max-symbols 50 --mode compact --format json
prograph affected src/transfer.ts --depth 3 --include-tests --mode compact --format json
```

`context` uses deterministic lexical and graph ranking; it does not call an LLM. `affected` follows supported reverse dependencies and callers, and labels discovered test files as related candidate tests rather than guaranteed required tests.

Agent-oriented queries are bounded and trusted-only by default. `callers`, `callees`, `neighborhood`, file relationships, cycles, API graph responses, framework views, affected views, and UI graph views return only `exact` and `resolved` relationships unless explicitly expanded:

```bash
prograph neighborhood <symbol-id> --include-probable --format json
prograph neighborhood <symbol-id> --include-unresolved --format json
```

`--include-unresolved` also includes probable relationships. Low-confidence edges remain stored in SQLite, JSON exports, and diagnostics; default filtering does not remove them from the index.

Default symbol search prioritizes concrete symbols and hides unresolved symbols. Use `--include-unresolved` to inspect unresolved targets explicitly.

## Status, Sync, And Watch

`prograph status` compares SHA-256 content hashes, configuration, graph schema, adapter versions, and Git metadata where available. It reports a fresh, stale, or missing index plus added, modified, and deleted supported files.

`prograph sync` is deliberately conservative. Unchanged indexes return quickly. Isolated, framework-neutral files without cross-file graph relationships can be reparsed incrementally; dependency-bearing, framework-relevant, unresolved, configuration, schema, or adapter-version changes fall back to a full analysis with an explicit reason.

`prograph watch` observes the local repository, ignores configured build/dependency/output paths, debounces events, and invokes the same sync engine. It stops on `SIGINT` or `SIGTERM`.

## MCP Stdio

Start the local stdio MCP server:

```bash
prograph mcp /path/to/repository --index /custom/index
```

MCP handlers are thin wrappers over the shared query and status services. They return bounded compact results by default and expose repository overview/status, symbol search/details, callers, callees, file dependencies, reverse dependencies, neighborhood, cycles, framework bindings, context, affected impact, and diagnostics. ProGraph does not implement public HTTP MCP transport.

## Local Visualization

Start the localhost-only server:

```bash
prograph serve .
```

The default binding is `127.0.0.1:43117`. ProGraph does not expose the server publicly by default.

The Evidence Workbench UI provides:

- a bounded deterministic layered graph with architecture lanes and focused neighborhood highlighting;
- architecture, dependency, symbol, framework, context, affected, and diagnostic views;
- grouped search, graph-scope, confidence, evidence, and sync controls;
- a collapsible repository file list, adapter status, graph-scope summaries, fit-to-view, and minimap controls;
- a bounded evidence inspector with stable graph IDs, source locations, confidence, and relationship direction;
- index freshness, stale-index warning, and a Sync action;
- compact, standard, and full evidence modes;
- a confidence control with Trusted only, Include probable, and Include unresolved levels;
- architecture lanes for entry points, TypeScript/React, framework bridges, Rust, and external packages;
- English and Simplified Chinese interface languages, selected from the sidebar and persisted locally.

The UI queries SQLite through the same query service used by the CLI. It does not maintain a second dependency model.

## Local Query API

The localhost server exposes shared query-service results:

```text
GET /api/overview
GET /api/status
POST /api/sync
GET /api/architecture
GET /api/files
GET /api/files/:path
GET /api/symbols/search?q=query
GET /api/symbols/:id
GET /api/symbols/:id/callers
GET /api/symbols/:id/callees
GET /api/symbols/:id/neighborhood
GET /api/cycles
GET /api/frameworks
GET /api/frameworks/tauri
GET /api/diagnostics
GET /api/context
GET /api/affected
```

## Privacy And Isolation

- Analysis, SQLite storage, queries, and visualization run locally.
- No telemetry, cloud analysis, accounts, or source uploads are implemented.
- ProGraph does not edit source, manifests, lockfiles, build scripts, IDE settings, or `.gitignore`.
- Individual parser failures and uncertain relationships remain visible as structured diagnostics or low-confidence graph edges.

## Limitations

- TypeScript semantic quality depends on the target repository's compiler configuration and the compiler's ability to resolve a unique symbol.
- The Rust adapter resolves repository-local module-qualified paths, imported functions, and a conservative subset of inherent methods using explicit types or constructor assignments. It does not expand macros or reproduce Cargo/rustc/rust-analyzer semantics.
- React name-only component and callback matches are `probable`, not trusted by default.
- Tauri recognizes structured Rust command attributes, individual handler tokens, literal event names, and simple repository-local string constants. Arbitrary constant evaluation and dynamic event names remain unresolved.
- Architecture lanes are derived from language, node kind, and framework evidence; they are not business-domain inference.
- Incremental sync only reparses graph-isolated, framework-neutral files. Common dependency and framework edits intentionally trigger a full rebuild until dependency-aware invalidation is broader.
- Context and affected ranking are deterministic graph/lexical heuristics, not complete semantic task or test-impact analysis.

## Unresolved Relationship Policy

ProGraph preserves unresolved call-site evidence and diagnostics without creating one unresolved node per occurrence. Unresolved targets are scoped to their source owner. Common low-value method names such as `new`, `get`, `send`, `clone`, `insert`, and `update` are aggregated within that owner; unrelated owners are never connected through a global bare-name unresolved node. Exact call-site names remain available in edge evidence.

## Adapter Development

Language adapters implement detection and analysis over a read-only repository snapshot, then emit graph nodes, graph edges, source evidence, and diagnostics. Framework adapters inspect that language-level graph and add or refine framework relationships without embedding framework logic in the graph core.

See [docs/architecture.md](docs/architecture.md) for contracts, identity rules, confidence semantics, persistence, incremental analysis, and MCP integration.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use small local fixtures and do not copy external repositories.
