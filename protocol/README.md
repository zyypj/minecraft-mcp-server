# @mcbuild/protocol

The **language-neutral contract** between the two halves of the Minecraft build
engine: the Node MCP server / build engine (TypeScript) and the Java Paper
plugin. It defines the JSON-RPC 2.0 wire protocol (envelope, job model, shared
edit options, and every method's param/result shape) plus the core domain types
that cross the boundary — `Region`, `BuildSite`, and the engine-owned inverse
patch `WorldDiff`.

See `BUILD_ENGINE_PLAN.md` §3.3 (RPC protocol), §7 (region / BuildSite /
WorldDiff), and §8 (repo layout).

## Source of truth

**`schema/` (JSON Schema, draft 2020-12) is the canonical, language-neutral
contract.** The two typed bindings are derived from — and must stay consistent
with — it:

| Path | What | Consumers |
|---|---|---|
| `schema/*.schema.json` | **Source of truth.** JSON Schema draft 2020-12. | codegen, contract tests |
| `ts/index.ts` | Hand-written TypeScript interfaces **and** matching `zod` schemas; types are `z.infer`red so runtime validation and static types can't drift. | `mcp`, `engine` (import in-process) |
| `java/` | Java records **code-generated** from `schema/` by `tools/codegen` (see §8). *Not built in this package.* | `plugin` |

`ts/` is hand-authored (not generated) so the Node side gets first-class zod
runtime validation; it is kept mutually consistent with `schema/` by review and
(later) contract tests. `java/` is generated and lives here only as an output
target — the generator is `tools/codegen` at the repo root, not part of this
package's build.

## Schema files

| File | Defines |
|---|---|
| `common.schema.json` | `Vec3`, `Dimensions`, `Bounds`, `Region`, `RegionMask`, `Facing`, `SelectionType`, `BlockState` |
| `rpc.schema.json` | JSON-RPC 2.0 envelope (`RpcRequest`, `RpcResponse`, `RpcError`), the `job.progress` notification, the shared `Options` object, and a `methods` map documenting param/result for every RPC method |
| `worlddiff.schema.json` | `WorldDiff` — the engine-owned inverse patch (§7.4), the single source of truth for build-level undo |
| `buildsite.schema.json` | `BuildSite` — a named, reserved region with anchor, footprint, terrain survey, and context (§7.2) |

Cross-file references use absolute `$id` URIs (`https://mcbuild.dev/protocol/…`)
with JSON-pointer fragments into `$defs`.

## TypeScript / zod usage

```ts
import {
  METHODS,
  methodSchemas,
  parseMethodParams,
  RpcRequestSchema,
  type MethodParams,
  type MethodResult,
  type Region,
  type WorldDiff,
  type BuildSite,
} from "@mcbuild/protocol";

// Validate an inbound request's params for a known method (defaults applied):
const params: MethodParams["fillRegion"] = parseMethodParams("fillRegion", raw);
```

Key exports:

- **Primitives & domain types:** `Vec3`, `Dimensions`, `Bounds`, `Region`,
  `RegionMask`, `Facing`, `SelectionType`, `BlockState`, `WorldDiff`,
  `BlockChange`, `BuildSite`, `TerrainProfile`, `Adjacency`, `RpcOptions`.
- **Envelope:** `RpcRequest`, `RpcNotification`, `RpcResponse`
  (`RpcSuccessResponse` | `RpcErrorResponse`), `RpcError`, `RPC_ERROR_CODES`,
  `isRpcErrorResponse`.
- **Jobs:** `JobState`, `JobProgressParams`, `JobProgressNotification`,
  `JOB_PROGRESS_METHOD`.
- **Method registry:** `methodSchemas` (name → `{ params, result }` zod schemas),
  `METHODS` (ordered names), `MethodName`, `MethodNameSchema`, the typed maps
  `MethodParams` / `MethodParamsInput` / `MethodResult`, and helpers
  `getMethodSchema`, `parseMethodParams`, `parseMethodResult`, `isMethodName`.

Every schema constant `XSchema` pairs with a `type X = z.infer<typeof XSchema>`.
Method params carry an `options` object with defaults (`physics:false`,
`updateLighting:true`, `notifyClients:true`, `spawnDrops:false`), so
`MethodParams` (output) has `options` fully populated while `MethodParamsInput`
lets callers omit it.

## Versioning

This package is semver'd (`PROTOCOL_VERSION` in `ts/index.ts`, currently
`0.1.0`). Intent:

- **Patch** — doc/comment fixes, non-breaking clarifications.
- **Minor** — additive, backward-compatible changes (new optional field, new
  method). Consumers on an older minor keep working.
- **Major** — breaking changes to an existing method's shape, a renamed/removed
  field, or an envelope change. The `authenticate` handshake also returns the
  plugin `serverVersion`/`dataVersion` so runtime version skew is detectable
  independently of this package's version.

Because `ts/` and `java/` are both bindings of `schema/`, a schema change is the
trigger for a version bump; regenerate `java/` and re-review `ts/` together.

## Build

No install runs in this environment; dependencies are only declared. To type-check
where a toolchain is available: `tsc --noEmit` (config in `tsconfig.json`,
targets ES2022, `moduleResolution: bundler`, `declaration: true`, `outDir: dist`).
