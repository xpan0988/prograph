# ProGraph

ProGraph is a standalone, local-first repository visualization and code-intelligence tool. It analyzes a source repository into one evidence-backed graph that serves both the interactive human UI and compact machine-readable CLI queries.

```text
Source repository
  -> language and framework adapters
  -> unified graph IR
  -> SQLite query store
     -> CLI queries
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

TypeScript compiler-backed relationships are marked `resolved` when a unique symbol is available. Rust method calls and other heuristic relationships are marked `probable` or `unresolved`; ProGraph does not claim to replace rust-analyzer, Cargo, or the Rust compiler.

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
└── exports/
    └── graph.json
```

Use an alternative output directory when repository-local output is undesirable:

```bash
prograph analyze /path/to/repository --output ./tmp/external-index
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
prograph serve [path] [--port number]
prograph open [path] [--port number]
prograph overview [path]
prograph files [path]
prograph file <file> [--repo path]
prograph symbol <query> [--repo path]
prograph callers <symbol-id> [--repo path]
prograph callees <symbol-id> [--repo path]
prograph neighborhood <symbol-id> [--repo path]
prograph cycles [path]
prograph diagnostics [path]
prograph adapters [path]
prograph framework tauri [path]
```

Most query commands support text and JSON output:

```bash
prograph symbol run --format json
prograph neighborhood typescript:function:0123456789abcdef \
  --depth 2 \
  --max-nodes 50 \
  --edge-kind calls invokes \
  --format json
```

Agent-oriented queries are bounded by default. They do not print the complete graph unless a caller explicitly requests and processes the JSON export.

## Local Visualization

Start the localhost-only server:

```bash
prograph serve .
```

The default binding is `127.0.0.1:43117`. ProGraph does not expose the server publicly by default.

The Evidence Workbench UI provides:

- a bounded deterministic layered graph;
- architecture, dependency, symbol, framework, impact, and diagnostic views;
- repository files, adapter status, and graph-scope summaries;
- search, depth limits, node limits, language filters, fit-to-view, and minimap controls;
- stable graph IDs, confidence, edge direction, and source evidence in the inspector;
- architecture lanes for entry points, TypeScript/React, framework bridges, Rust, and external packages.

The UI queries SQLite through the same query service used by the CLI. It does not maintain a second dependency model.

## Local Query API

The localhost server exposes shared query-service results:

```text
GET /api/overview
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
```

## Privacy And Isolation

- Analysis, SQLite storage, queries, and visualization run locally.
- No telemetry, cloud analysis, accounts, or source uploads are implemented.
- ProGraph does not edit source, manifests, lockfiles, build scripts, IDE settings, or `.gitignore`.
- Individual parser failures and uncertain relationships remain visible as structured diagnostics or low-confidence graph edges.

## Limitations

- TypeScript semantic quality depends on the target repository's compiler configuration and the compiler's ability to resolve a unique symbol.
- The Rust adapter performs syntax extraction and bounded name heuristics. It does not expand macros or reproduce Cargo/rustc/rust-analyzer semantics.
- React and Tauri adapters recognize static syntax with literal component, command, registration, and event names. Dynamic values are not inferred.
- Architecture lanes are derived from language, node kind, and framework evidence; they are not business-domain inference.
- Custom output directories are intended for analysis/export workflows. CLI and server queries currently discover the default repository-local `.prograph/graph.sqlite`.
- The current UI bundle prioritizes a working vertical slice over advanced code splitting.

## Adapter Development

Language adapters implement detection and analysis over a read-only repository snapshot, then emit graph nodes, graph edges, source evidence, and diagnostics. Framework adapters inspect that language-level graph and add or refine framework relationships without embedding framework logic in the graph core.

See [docs/architecture.md](docs/architecture.md) for contracts, identity rules, confidence semantics, persistence, and future MCP integration.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests use small local fixtures and do not copy external repositories.
