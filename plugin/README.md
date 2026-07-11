# BuildEngine — Paper plugin (the "Committer")

The Java half of the Minecraft artistic build engine. It is the **Committer** role (§3.1(a) of
`../BUILD_ENGINE_PLAN.md`): it writes `BlockData` directly into the world in bulk on behalf of the Node
MCP process. It **never** renders images and **never** makes taste decisions — it edits the world, locks
regions, and extracts region data for the Node renderer.

It exposes a **localhost JSON-RPC 2.0** server (HTTP + WebSocket) that the Node MCP calls. Bulk edits go
through a `WorldEditor` interface with two backends whose threading models are deliberately different
(§3.4):

- **`FaweWorldEditor` (default):** FastAsyncWorldEdit `EditSession`s run **off-thread** and are awaited.
  Not tick-budgeted, never wrapped in the main-thread executor.
- **`BukkitWorldEditor` (fallback):** raw Bukkit writes on the **main thread**, spread across ticks by a
  `budgetPerTick` self-rescheduling drain with a TPS guard.

> **Scaffold status:** this is a compiling-*intent* scaffold. Only `authenticate` is fully implemented;
> every other RPC method and the actual block writes are clearly-marked `TODO M1..M5` stubs. **It has NOT
> been compiled** in the authoring environment (which had only Java 8 and no Gradle). Build it where a JDK
> 21 + Gradle are available. Do not treat "it's written" as "it compiles".

## Requirements

- **Java 21** (Paper 1.21.x requires it).
- **Gradle** (or add the Gradle wrapper — see below). No Gradle is vendored here.
- A **Paper 1.21.x** server to run it on.
- **FastAsyncWorldEdit** for the default off-thread backend (optional but strongly recommended; without it
  the plugin falls back to the slower main-thread Bukkit editor).

## Build

```bash
# from this plugin/ directory, on a machine with JDK 21 + Gradle:
gradle shadowJar          # or: ./gradlew shadowJar  (after `gradle wrapper` creates the wrapper)
```

This produces a **shaded** jar under `build/libs/` with Jetty, Javalin, and Jackson **relocated** under
`com.mcbuild.buildengine.shaded.*` to avoid classloader clashes with the server and other plugins (§3.1).
The plain (non-shaded) jar will not run — always install the shaded one.

> There is intentionally **no** `paperweight-userdev`: the plugin uses only the Bukkit/Paper + FAWE APIs
> (no raw NMS), so the mapping/deobfuscation machinery would be pure overhead. Add it only if a future
> feature genuinely needs NMS (confirm at M1).

## Install & configure

1. Drop the shaded jar into your Paper server's `plugins/` folder (alongside FastAsyncWorldEdit).
2. Start the server once to generate `plugins/BuildEngine/config.yml`, then edit it:
   - `rpc.host` — keep `127.0.0.1` (loopback only).
   - `rpc.port` — default `25566`.
   - `rpc.token` — **change from `CHANGE_ME`** to a strong secret. Every RPC can edit the world.
   - `limits.maxRegionVolume`, `limits.budgetPerTick`, `limits.tpsFloor`, `worldAllowlist`,
     `autosnapshotThreshold` — safety rails.
3. Restart the server. You should see `BuildEngine RPC listening on 127.0.0.1:25566 ...` in the log.
4. `/buildengine status` prints the bind address, active backend, and selection count.

## How the Node MCP connects

The Node MCP's `PluginConnection` opens the WebSocket and authenticates with the same token:

```
--plugin-url ws://127.0.0.1:25566   --token <your-rpc.token>
```

- WebSocket endpoint: `ws://127.0.0.1:25566/ws` (session + streamed `job.progress`).
- One-shot HTTP endpoint: `POST http://127.0.0.1:25566/rpc`.
- Auth: send `Authorization: Bearer <token>` on the WS handshake / each HTTP request (a `?token=` query
  param is accepted as a fallback for clients that can't set headers), then call `authenticate`:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "authenticate", "params": { "token": "<your-rpc.token>" } }
```

Response:

```json
{ "jsonrpc": "2.0", "id": 1,
  "result": { "ok": true, "serverVersion": "...", "dataVersion": 3953, "faweAvailable": true } }
```

Mutating RPCs (`fillRegion`, `setBlocks`, ...) return a `jobId` immediately and (once implemented) stream
`{"method":"job.progress","params":{jobId,done,total}}` over the WebSocket.

## Layout

```
plugin/
├─ build.gradle.kts          # Java 21 toolchain; Paper compileOnly; Javalin+Jackson shaded/relocated; FAWE compileOnly
├─ settings.gradle.kts       # rootProject.name = "buildengine-plugin"
└─ src/main/
   ├─ resources/{plugin.yml, config.yml}
   └─ java/com/mcbuild/buildengine/
      ├─ BuildEnginePlugin.java        # JavaPlugin: config -> pick backend -> start RPC -> command
      ├─ rpc/                          # RpcServer (Javalin HTTP+WS, JSON-RPC 2.0), JsonRpc types/helpers
      ├─ world/                        # WorldEditor iface + Fawe/Bukkit impls + MainThreadExecutor (+Bukkit impl, Folia seam)
      ├─ region/                       # RegionRegistry + Selection (per-region async edit serialization, reservation)
      ├─ capture/                      # RegionCapture: region -> .schem/JSON extraction (never renders — §6.1)
      └─ model/                        # Region, Vec3, RpcOptions, Pattern, BlockChange, CaptureResult, WorldDiff
                                       #   (to be codegen'd from protocol/schema later — §8)
```

## Dependency coordinates (verify/bump at M1)

Pinned loosely; align the exact patch with the target MC version (§11 #2) at M1:

| Dependency | Coordinate | Repo | Scope |
|---|---|---|---|
| Paper API | `io.papermc.paper:paper-api:1.21.8-R0.1-SNAPSHOT` | `repo.papermc.io` | compileOnly |
| WorldEdit (Bukkit) | `com.sk89q.worldedit:worldedit-bukkit:7.3.8` | `maven.enginehub.org` | compileOnly |
| FastAsyncWorldEdit | `com.fastasyncworldedit:FastAsyncWorldEdit-Bukkit:2.13.0` | `mvn.intellectualsites.com` | compileOnly |
| Javalin | `io.javalin:javalin:6.6.0` | Maven Central | implementation (shaded) |
| Jackson | `com.fasterxml.jackson.core:jackson-databind:2.18.2` | Maven Central | implementation (shaded) |
| Shadow plugin | `com.gradleup.shadow:8.3.5` | Gradle Plugin Portal | build |

## Milestone map for the stubs

| RPC / write | Where | Milestone |
|---|---|---|
| `authenticate` | `RpcServer#authenticate` | **done** |
| `fillRegion` / `setBlocks` block writes | `BukkitWorldEditor` (loop wired), `FaweWorldEditor` (EditSession) | M1 |
| `selectRegion` / `getRegionInfo` / `releaseRegion` / `snapshot` | `RpcServer` + `RegionRegistry` | M1 |
| `getBlocks` / `dryRun` / `pasteSchematic` / `saveSchematic` | `RpcServer` / `WorldEditor` | M2 |
| `captureRegion` | `RegionCapture`, `WorldEditor#capture` | M4 |
| `applyDiff` / `undoDiff` | `WorldEditor` (engine owns the history — §7.4) | M5 |
```
