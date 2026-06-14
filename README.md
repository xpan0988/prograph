# ProGraph

> **Status:** Stable self-use release. ProGraph is in maintenance mode. New development should be driven by real usage issues rather than feature parity.

ProGraph is a standalone, local-first repository visualization and code-intelligence tool. It analyzes a source repository into one evidence-backed graph that serves both the interactive human UI and compact machine-readable CLI or MCP queries.

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

ProGraph does not modify analyzed source files. Its default repository-local output is `.prograph/`, and it never adds that directory to `.gitignore`.

## Supported Analysis

ProGraph currently supports:

- TypeScript, TSX, JavaScript, and JSX through `ts-morph`;
- Rust syntax through Tree-sitter;
- statically identifiable React components, JSX renders, and callback props;
- statically identifiable Tauri commands, handler registrations, invokes, and named events.

TypeScript compiler-backed relationships are marked `resolved` when a unique symbol is available. Rust repository-local module paths, imports, aliases, re-exports, same-module calls, and safely inferred inherent methods may be `resolved`; name-only heuristics remain `probable` or `unresolved`.

ProGraph does not claim to replace rust-analyzer, Cargo, rustc, or the Rust compiler.

## Installation

ProGraph is currently maintained as a local self-use tool.

```bash
cd /Users/xiyuanpan/prograph
npm install
npm run build
npm link
```

Verify the executable:

```bash
prograph --help
prograph --version
```

Unlink the global development command:

```bash
npm unlink -g @xpan0988/prograph
```

## Daily Workflow

Inside an indexed repository:

```bash
cd /path/to/project
prograph status .
```

If the index is missing or stale:

```bash
prograph sync .
```

Open the visualization:

```bash
prograph open .
```

`prograph open .` starts the local UI but does not update the index. Run `prograph status .` or `prograph sync .` first when repository source files have changed.

Typical coding-agent queries:

```bash
prograph symbol <name> --format json --mode compact
prograph callers <symbol-id> --format json --mode compact
prograph callees <symbol-id> --format json --mode compact
prograph neighborhood <symbol-id> \
  --depth 2 \
  --max-nodes 30 \
  --format json \
  --mode compact
prograph affected <file-or-symbol> \
  --include-tests \
  --format json \
  --mode compact
```

For continuous local updates:

```bash
prograph watch .
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
prograph callers <symbol-id> \
  --repo /path/to/repository \
  --index ./tmp/external-index \
  --format json

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

Agent-oriented JSON queries default to `compact` output. Use `--mode standard` for additional semantic fields or `--mode full` for complete stored records. Bound repeated evidence with `--max-evidence`:

```bash
prograph neighborhood <symbol-id> \
  --depth 2 \
  --max-nodes 30 \
  --mode compact \
  --max-evidence 1 \
  --format json

prograph context "transfer planner tests" \
  --max-files 20 \
  --max-symbols 50 \
  --mode compact \
  --format json

prograph affected src/transfer.ts \
  --depth 3 \
  --include-tests \
  --mode compact \
  --format json
```

`context` uses deterministic lexical and graph ranking; it does not call an LLM.

`affected` follows supported reverse dependencies and callers. It labels discovered test files as related candidate tests rather than guaranteed required tests.

Agent-oriented queries are bounded and trusted-only by default. `callers`, `callees`, `neighborhood`, file relationships, cycles, API graph responses, framework views, affected views, and UI graph views return only `exact` and `resolved` relationships unless explicitly expanded:

```bash
prograph neighborhood <symbol-id> --include-probable --format json
prograph neighborhood <symbol-id> --include-unresolved --format json
```

`--include-unresolved` also includes probable relationships. Low-confidence edges remain stored in SQLite, JSON exports, and diagnostics; default filtering does not remove them from the index.

Default symbol search prioritizes concrete symbols and hides unresolved symbols. Use `--include-unresolved` to inspect unresolved targets explicitly.

## Agent Usage Guidance

Use ProGraph before broad repository exploration.

- Run `prograph status .` before querying.
- Run `prograph sync .` when the index is stale.
- Prefer `compact` mode and bounded neighborhoods for agent queries.
- Treat `exact` and `resolved` relationships as trusted navigation evidence.
- Verify `probable` and `unresolved` relationships against source.
- Use framework views for Tauri cross-language relationships.
- Use `affected` as candidate impact guidance, not as a proof that every returned test must run.
- Source code, the TypeScript compiler, Cargo, rustc, and rust-analyzer remain authoritative.

Recommended agent workflow:

```text
1. Check ProGraph status.
2. Sync if stale.
3. Query symbols, callers, callees, framework bindings, context, or affected files.
4. Inspect source before editing.
5. Sync after edits.
6. Re-check affected symbols and candidate tests.
```

## Status, Sync, And Watch

`prograph status` compares SHA-256 content hashes, configuration, graph schema, adapter versions, and Git metadata where available. It reports a fresh, stale, or missing index plus added, modified, and deleted supported files.

`prograph sync` is deliberately conservative. Unchanged indexes return quickly. Isolated, framework-neutral files without cross-file graph relationships can be reparsed incrementally. Dependency-bearing, framework-relevant, unresolved, configuration, schema, or adapter-version changes fall back to full analysis with an explicit reason.

`prograph watch` observes the local repository, ignores configured build, dependency, and output paths, debounces events, and invokes the same sync engine. It stops on `SIGINT` or `SIGTERM`.

## MCP Stdio

Start the local stdio MCP server:

```bash
prograph mcp /path/to/repository --index /custom/index
```

MCP handlers are thin wrappers over the shared query and status services. They return bounded compact results by default.

Available MCP capabilities include:

- repository overview and status;
- symbol search and details;
- callers and callees;
- file dependencies and reverse dependencies;
- bounded neighborhoods;
- cycles;
- framework bindings;
- deterministic context ranking;
- affected impact;
- diagnostics.

ProGraph does not implement public HTTP MCP transport.

## Local Visualization

Start the localhost-only server:

```bash
prograph serve .
```

Open it automatically in the browser:

```bash
prograph open .
```

The default binding is `127.0.0.1:43117`. ProGraph does not expose the server publicly by default.

The bilingual Evidence Workbench provides:

- architecture, dependency, symbol, framework, context, affected, and diagnostic views;
- deterministic layered graphs with architecture lanes and selected-neighborhood focus;
- grouped search, graph-scope, confidence, evidence, and sync controls;
- a collapsible repository file list;
- adapter, freshness, diagnostics, graph-scope, and analysis-duration status chips;
- a bounded evidence inspector with identity, relationships, source location, evidence, and advanced metadata;
- compact, standard, and full evidence modes;
- Trusted only, Include probable, and Include unresolved confidence levels;
- fit-to-view, minimap, selection highlighting, and responsive inspector behavior;
- English and Simplified Chinese interfaces with local preference persistence.

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

- Analysis, SQLite storage, queries, MCP, and visualization run locally.
- No telemetry, cloud analysis, accounts, or source uploads are implemented.
- ProGraph does not edit source, manifests, lockfiles, build scripts, IDE settings, or `.gitignore`.
- Individual parser failures and uncertain relationships remain visible as structured diagnostics or low-confidence graph edges.

## Limitations

- TypeScript semantic quality depends on the target repository's compiler configuration and the compiler's ability to resolve a unique symbol.
- The Rust adapter resolves repository-local module-qualified paths, same-module calls, nested test modules, imported functions, aliases, re-exports, and a conservative subset of inherent methods. It does not expand macros or reproduce Cargo, rustc, or rust-analyzer semantics.
- Rust trait dispatch and complex receiver inference still require source or compiler verification.
- React name-only component and callback matches are `probable`, not trusted by default.
- Tauri recognizes structured Rust command attributes, individual handler tokens, literal event names, and simple repository-local string constants. Arbitrary constant evaluation and dynamic event names remain unresolved.
- Architecture lanes are derived from language, node kind, and framework evidence; they are not business-domain inference.
- Large architecture graphs may still become visually dense even when bounded.
- Incremental sync reparses only changes considered safe for local incremental invalidation. Common dependency and framework edits may intentionally trigger a full rebuild.
- Context and affected ranking are deterministic graph and lexical heuristics, not complete semantic task or test-impact analysis.
- ProGraph is not an authoritative compiler-grade semantic source.

## Unresolved Relationship Policy

ProGraph preserves unresolved call-site evidence and diagnostics without creating one unresolved node per occurrence.

Unresolved targets are scoped to their source owner. Common low-value method names such as `new`, `get`, `send`, `clone`, `insert`, and `update` are aggregated within that owner. Unrelated owners are never connected through a global bare-name unresolved node.

Exact call-site names remain available in edge evidence.

## Maintenance Mode

ProGraph is considered complete for its current self-use scope:

```text
TypeScript
TSX
JavaScript
JSX
React
Rust
Tauri
CLI
MCP
local visualization
incremental status and sync
context and affected guidance
```

Future development should be limited to:

- confirmed correctness defects;
- regressions found through real repository use;
- targeted Rust resolution improvements;
- practical UI or performance issues;
- dependency-aware incremental invalidation when needed.

Avoid feature-parity work, speculative language support, public-product infrastructure, or broad redesigns unless the usage scope changes.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm link
```

Tests use small local fixtures and do not copy external repositories.

See [docs/architecture.md](docs/architecture.md) for graph contracts, identity rules, confidence semantics, persistence, incremental analysis, query architecture, and MCP integration.
