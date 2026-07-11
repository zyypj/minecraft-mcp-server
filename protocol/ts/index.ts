/**
 * @mcbuild/protocol — the language-neutral contract between the Node MCP server
 * and the Java Paper plugin (and, in-process, the build engine).
 *
 * This file is the single TypeScript source that both `mcp` and `engine` import.
 * It is kept mutually consistent with the JSON Schema under `../schema/*.schema.json`
 * (the language-neutral source of truth from which Java records are code-generated).
 *
 * Design references: BUILD_ENGINE_PLAN.md
 *   - section 3.3  RPC protocol (envelope, job model, shared options, method table)
 *   - section 7    Region / BuildSite / WorldDiff
 *
 * Conventions:
 *   - Coordinates are INTEGER block positions ({x,y,z}).
 *   - Dimensions use {w,h,l} matching the .schem / voxel-buffer index order
 *     `x + z*w + y*w*l`.
 *   - Every schema `XSchema` has a matching `type X = z.infer<typeof XSchema>`.
 *   - Types are inferred from zod (z.infer) so runtime validation and static
 *     types can never drift.
 */

import { z } from "zod";

/** Semantic version of this protocol package / contract. */
export const PROTOCOL_VERSION = "0.1.0" as const;

/** JSON-RPC protocol version literal used in every envelope. */
export const JSONRPC_VERSION = "2.0" as const;

/* ============================================================================
 * 1. Common domain primitives  (mirrors common.schema.json)
 * ========================================================================== */

/** An integer block position in world space. */
export const Vec3Schema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/**
 * Extent of a box. `w`=X span, `h`=Y span, `l`=Z span.
 * Matches the .schem / voxel-buffer index order `x + z*w + y*w*l`.
 */
export const DimensionsSchema = z.object({
  w: z.number().int().nonnegative(),
  h: z.number().int().nonnegative(),
  l: z.number().int().nonnegative(),
});
export type Dimensions = z.infer<typeof DimensionsSchema>;

/** An axis-aligned box with no world attached (min/max inclusive corners). */
export const BoundsSchema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
});
export type Bounds = z.infer<typeof BoundsSchema>;

/**
 * A namespaced block id with optional bracketed state, e.g.
 * `minecraft:oak_stairs[facing=north,half=top]`. The bracket body is validated
 * loosely; the plugin's data version is authoritative on legal states.
 */
export const BLOCK_STATE_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./]+(\[[^\]]*\])?$/;
export const BlockStateSchema = z
  .string()
  .regex(BLOCK_STATE_PATTERN, "Expected 'namespace:id' with optional '[state,...]'");
export type BlockState = z.infer<typeof BlockStateSchema>;

/** A horizontal cardinal direction; the anchor facing of a BuildSite. */
export const FacingSchema = z.enum(["north", "east", "south", "west"]);
export type Facing = z.infer<typeof FacingSchema>;
export const FACINGS = FacingSchema.options;

/**
 * WorldEdit-style selection shape. Everything normalizes internally to
 * (AABB, mask) per section 7.1.
 */
export const SelectionTypeSchema = z.enum(["cuboid", "poly", "cylinder"]);
export type SelectionType = z.infer<typeof SelectionTypeSchema>;
export const SELECTION_TYPES = SelectionTypeSchema.options;

/** A cuboid volume in a named world; min/max are inclusive integer corners. */
export const RegionSchema = z.object({
  world: z.string().min(1),
  min: Vec3Schema,
  max: Vec3Schema,
});
export type Region = z.infer<typeof RegionSchema>;

/**
 * A per-voxel membership predicate over a region's AABB (the writable cells).
 * Absent mask means the whole cuboid is writable. Discriminated on `kind`.
 */
export const RegionMaskSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("poly"),
    vertices: z
      .array(z.object({ x: z.number().int(), z: z.number().int() }))
      .min(3),
    yMin: z.number().int(),
    yMax: z.number().int(),
  }),
  z.object({
    kind: z.literal("cylinder"),
    center: Vec3Schema,
    radiusX: z.number().nonnegative(),
    radiusZ: z.number().nonnegative(),
    yMin: z.number().int(),
    yMax: z.number().int(),
  }),
  z.object({
    kind: z.literal("dense"),
    dims: DimensionsSchema,
    // RLE membership over the AABB in .schem order; runs alternate
    // OUT,IN,OUT,... starting with OUT.
    runs: z.array(z.number().int().nonnegative()),
  }),
]);
export type RegionMask = z.infer<typeof RegionMaskSchema>;

/* ============================================================================
 * 2. Shared edit options  (section 3.3 "Shared options")
 * ========================================================================== */

/**
 * Shared edit flags (mirrors GDMC-HTTP). `notifyClients` MUST default true or
 * placed blocks stay invisible to connected players. `budgetPerTick` applies
 * only to the main-thread BukkitWorldEditor path; FAWE ignores it (section 3.4).
 */
export const RpcOptionsSchema = z.object({
  physics: z.boolean().default(false),
  updateLighting: z.boolean().default(true),
  notifyClients: z.boolean().default(true),
  spawnDrops: z.boolean().default(false),
  budgetPerTick: z.number().int().positive().optional(),
});
export type RpcOptions = z.infer<typeof RpcOptionsSchema>;
/** Input shape for options (all fields optional; defaults applied on parse). */
export type RpcOptionsInput = z.input<typeof RpcOptionsSchema>;

/** Options field as used inside method params: omit the whole object and defaults still apply. */
const OptionsField = RpcOptionsSchema.default({});

/* ============================================================================
 * 3. WorldDiff  (mirrors worlddiff.schema.json; section 7.4)
 *
 * The engine-owned inverse patch — the single source of truth for build-level
 * undo. FAWE is only the write mechanism.
 * ========================================================================== */

/**
 * A single cell's transition. `before` is what the world held prior to commit
 * (used for undo); `after` is what the commit wrote (used for redo).
 */
export const BlockChangeSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  before: BlockStateSchema,
  after: BlockStateSchema,
});
export type BlockChange = z.infer<typeof BlockChangeSchema>;

export const WorldDiffSchema = z.object({
  id: z.string().min(1),
  region: RegionSchema,
  changes: z.array(BlockChangeSchema),
});
export type WorldDiff = z.infer<typeof WorldDiffSchema>;

/* ============================================================================
 * 4. BuildSite  (mirrors buildsite.schema.json; section 7.2)
 * ========================================================================== */

/** Ground survey under the footprint, sampled once at define time. */
export const TerrainProfileSchema = z.object({
  /** Ground Y per footprint cell, row-major indexed `x + z*width`. */
  heightmap: z.array(z.number().int()),
  /** Block states observed at the surface under the footprint. */
  surfacePalette: z.array(BlockStateSchema),
  /** Max ground rise (in blocks) across the footprint; drives terracing. */
  slope: z.number(),
  minGroundY: z.number().int(),
  maxGroundY: z.number().int(),
  /** True if water or lava is present under the footprint. */
  water: z.boolean(),
});
export type TerrainProfile = z.infer<typeof TerrainProfileSchema>;

/** What surrounds the site; used for grounding, entrance-facing, collisions. */
export const AdjacencySchema = z.object({
  hasNeighbors: z.boolean(),
  structures: z.array(z.string()).optional(),
  roadAccess: z.boolean().optional(),
  water: z.boolean().optional(),
});
export type Adjacency = z.infer<typeof AdjacencySchema>;

/** The box plus optional non-rectangular mask. */
export const BuildSiteRegionSchema = z.object({
  type: SelectionTypeSchema,
  min: Vec3Schema,
  max: Vec3Schema,
  mask: RegionMaskSchema.optional(),
});
export type BuildSiteRegion = z.infer<typeof BuildSiteRegionSchema>;

/** The local->world coordinate frame; rotation changes mapping, not the box. */
export const BuildSiteAnchorSchema = z.object({
  origin: Vec3Schema,
  baseY: z.number().int(),
  facing: FacingSchema,
});
export type BuildSiteAnchor = z.infer<typeof BuildSiteAnchorSchema>;

export const FootprintSchema = z.object({
  width: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type Footprint = z.infer<typeof FootprintSchema>;

export const BuildSiteContextSchema = z.object({
  biome: z.string(),
  adjacency: AdjacencySchema,
  /** Prevents overlapping concurrent builds. */
  reserved: z.boolean(),
});
export type BuildSiteContext = z.infer<typeof BuildSiteContextSchema>;

/**
 * A named, reserved region: the persistent contract between "where" and "what",
 * distinct from the transient voxel buffer written into it.
 */
export const BuildSiteSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  region: BuildSiteRegionSchema,
  anchor: BuildSiteAnchorSchema,
  footprint: FootprintSchema,
  terrain: TerrainProfileSchema,
  context: BuildSiteContextSchema,
  /** Monotonic pointer into the site's BuildVersion history (section 7.4). */
  currentBuildVersion: z.number().int().nonnegative(),
});
export type BuildSite = z.infer<typeof BuildSiteSchema>;

/* ============================================================================
 * 5. JSON-RPC 2.0 envelope  (section 3.3; mirrors rpc.schema.json $defs)
 * ========================================================================== */

/** Request id. Notifications omit it entirely. */
export const RpcIdSchema = z.union([z.string(), z.number().int()]);
export type RpcId = z.infer<typeof RpcIdSchema>;

/** A method invocation expecting a response. */
export const RpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

/** A request with no id; no response is returned. */
export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/** Response id may be null when the request id could not be determined. */
const ResponseIdSchema = z.union([z.string(), z.number().int(), z.null()]);

export const RpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: ResponseIdSchema,
  result: z.unknown(),
});
export type RpcSuccessResponse = z.infer<typeof RpcSuccessResponseSchema>;

export const RpcErrorResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: ResponseIdSchema,
  error: RpcErrorSchema,
});
export type RpcErrorResponse = z.infer<typeof RpcErrorResponseSchema>;

export const RpcResponseSchema = z.union([
  RpcSuccessResponseSchema,
  RpcErrorResponseSchema,
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Type guard: narrow a response to its error variant. */
export function isRpcErrorResponse(r: RpcResponse): r is RpcErrorResponse {
  return "error" in r;
}

/** Standard JSON-RPC 2.0 error codes plus protocol-specific ones. */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Protocol-specific range (server errors -32000..-32099). */
  UNAUTHENTICATED: -32001,
  REGION_LOCKED: -32002,
  JOB_FAILED: -32003,
} as const;

/* ============================================================================
 * 6. Job model  (section 3.3 "Job model")
 * ========================================================================== */

export const JobStateSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type JobState = z.infer<typeof JobStateSchema>;
export const JOB_STATES = JobStateSchema.options;

/** Params of the streamed `job.progress` notification. */
export const JobProgressParamsSchema = z.object({
  jobId: z.string(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type JobProgressParams = z.infer<typeof JobProgressParamsSchema>;

/** The `job.progress` notification pushed over the WebSocket during a job. */
export const JOB_PROGRESS_METHOD = "job.progress" as const;
export const JobProgressNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.literal(JOB_PROGRESS_METHOD),
  params: JobProgressParamsSchema,
});
export type JobProgressNotification = z.infer<
  typeof JobProgressNotificationSchema
>;

/* ============================================================================
 * 7. Shared building blocks for method params/results
 * ========================================================================== */

/** A single positioned block state. */
export const BlockEntrySchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  data: BlockStateSchema,
});
export type BlockEntry = z.infer<typeof BlockEntrySchema>;

/** A dry-run conflict at a specific cell. */
export const ConflictSchema = z.object({
  pos: Vec3Schema,
  reason: z.string(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** Clockwise degrees for schematic paste. */
export const RotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type Rotation = z.infer<typeof RotationSchema>;

export const MirrorSchema = z.enum(["none", "x", "z", "xz"]);
export type Mirror = z.infer<typeof MirrorSchema>;

export const SchematicFormatSchema = z.enum(["schem", "json"]);
export type SchematicFormat = z.infer<typeof SchematicFormatSchema>;

/* ============================================================================
 * 8. Per-method param / result schemas  (section 3.3 method table)
 * ========================================================================== */

// -- authenticate ------------------------------------------------------------
export const AuthenticateParamsSchema = z.object({ token: z.string() });
export const AuthenticateResultSchema = z.object({
  ok: z.boolean(),
  serverVersion: z.string(),
  dataVersion: z.number().int(),
  faweAvailable: z.boolean(),
});

// -- selectRegion ------------------------------------------------------------
export const SelectRegionParamsSchema = z.object({
  region: RegionSchema,
  name: z.string().optional(),
});
export const SelectRegionResultSchema = z.object({
  selectionId: z.string(),
  blockCount: z.number().int().nonnegative(),
  dimensions: DimensionsSchema,
});

// -- getRegionInfo -----------------------------------------------------------
export const GetRegionInfoParamsSchema = z
  .object({
    selectionId: z.string().optional(),
    region: RegionSchema.optional(),
  })
  .refine((v) => v.selectionId !== undefined || v.region !== undefined, {
    message: "Provide either selectionId or region",
  });
export const GetRegionInfoResultSchema = z.object({
  dimensions: DimensionsSchema,
  biome: z.string(),
  groundLevel: z.number().int(),
  heightmap: z.array(z.number().int()),
  paletteHistogram: z.record(z.string(), z.number().int().nonnegative()),
});

// -- getBlocks ---------------------------------------------------------------
export const GetBlocksParamsSchema = z.object({ region: RegionSchema });
export const GetBlocksResultSchema = z.discriminatedUnion("encoding", [
  z.object({
    encoding: z.literal("list"),
    region: RegionSchema,
    blocks: z.array(BlockEntrySchema),
  }),
  z.object({
    encoding: z.literal("rle"),
    region: RegionSchema,
    palette: z.array(BlockStateSchema),
    runs: z.array(
      z.object({
        count: z.number().int().positive(),
        index: z.number().int().nonnegative(),
      }),
    ),
  }),
]);

// -- setBlocks ---------------------------------------------------------------
export const SetBlocksParamsSchema = z.object({
  world: z.string(),
  blocks: z.array(BlockEntrySchema),
  options: OptionsField,
});
export const SetBlocksResultSchema = z.object({
  jobId: z.string(),
  changed: z.number().int().nonnegative(),
});

// -- fillRegion --------------------------------------------------------------
export const FillRegionParamsSchema = z.object({
  region: RegionSchema,
  /** FAWE pattern expression, e.g. '50%stone,50%cobblestone' or a block state. */
  pattern: z.string(),
  /** FAWE mask expression limiting which cells are written. */
  mask: z.string().optional(),
  options: OptionsField,
});
export const FillRegionResultSchema = z.object({ jobId: z.string() });

// -- pasteSchematic ----------------------------------------------------------
export const PasteSchematicParamsSchema = z.object({
  schematicId: z.string(),
  at: Vec3Schema,
  rotate: RotationSchema.optional(),
  mirror: MirrorSchema.optional(),
  ignoreAir: z.boolean().optional(),
  options: OptionsField,
});
export const PasteSchematicResultSchema = z.object({
  jobId: z.string(),
  pastedBounds: BoundsSchema,
});

// -- saveSchematic -----------------------------------------------------------
export const SaveSchematicParamsSchema = z.object({
  region: RegionSchema,
  name: z.string(),
});
export const SaveSchematicResultSchema = z.object({
  schematicId: z.string(),
  bytesRef: z.string(),
});

// -- captureRegion -----------------------------------------------------------
export const CaptureRegionParamsSchema = z.object({
  region: RegionSchema,
  format: SchematicFormatSchema,
});
export const CaptureRegionResultSchema = z.object({
  format: SchematicFormatSchema,
  schematicId: z.string().optional(),
  jsonRef: z.string().optional(),
});

// -- applyDiff ---------------------------------------------------------------
export const ApplyDiffParamsSchema = z.object({
  diff: WorldDiffSchema,
  options: OptionsField,
});
export const ApplyDiffResultSchema = z.object({ jobId: z.string() });

// -- undoDiff ----------------------------------------------------------------
export const UndoDiffParamsSchema = z.object({ diffId: z.string() });
export const UndoDiffResultSchema = z.object({
  jobId: z.string(),
  restored: z.number().int().nonnegative(),
});

// -- snapshot ----------------------------------------------------------------
export const SnapshotParamsSchema = z.object({ region: RegionSchema });
export const SnapshotResultSchema = z.object({ snapshotId: z.string() });

// -- restoreSnapshot ---------------------------------------------------------
export const RestoreSnapshotParamsSchema = z.object({ snapshotId: z.string() });
export const RestoreSnapshotResultSchema = z.object({ restored: z.boolean() });

// -- getJob ------------------------------------------------------------------
export const GetJobParamsSchema = z.object({ jobId: z.string() });
export const GetJobResultSchema = z.object({
  state: JobStateSchema,
  progress: JobProgressParamsSchema,
  changed: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// -- dryRun ------------------------------------------------------------------
/** Methods that can be dry-run (world-mutating forward edits). */
export const DryRunnableMethodSchema = z.enum([
  "setBlocks",
  "fillRegion",
  "pasteSchematic",
  "applyDiff",
]);
export type DryRunnableMethod = z.infer<typeof DryRunnableMethodSchema>;
export const DRY_RUNNABLE_METHODS = DryRunnableMethodSchema.options;

export const DryRunParamsSchema = z.object({
  editMethod: DryRunnableMethodSchema,
  /** The params object for `editMethod`; validated by that method's schema. */
  params: z.unknown(),
});
export const DryRunResultSchema = z.object({
  wouldChange: z.number().int().nonnegative(),
  bounds: BoundsSchema,
  conflicts: z.array(ConflictSchema),
  warnings: z.array(z.string()),
});

// -- releaseRegion -----------------------------------------------------------
export const ReleaseRegionParamsSchema = z.object({ selectionId: z.string() });
export const ReleaseRegionResultSchema = z.object({});

/* ============================================================================
 * 9. Method registry — the typed map of every RPC method
 * ========================================================================== */

/**
 * Registry mapping each method name to its `{ params, result }` zod schemas.
 * This is the authoritative list of methods; `METHODS`, `MethodParams` and
 * `MethodResult` are all derived from it so they cannot drift.
 */
export const methodSchemas = {
  authenticate: {
    params: AuthenticateParamsSchema,
    result: AuthenticateResultSchema,
  },
  selectRegion: {
    params: SelectRegionParamsSchema,
    result: SelectRegionResultSchema,
  },
  getRegionInfo: {
    params: GetRegionInfoParamsSchema,
    result: GetRegionInfoResultSchema,
  },
  getBlocks: { params: GetBlocksParamsSchema, result: GetBlocksResultSchema },
  setBlocks: { params: SetBlocksParamsSchema, result: SetBlocksResultSchema },
  fillRegion: {
    params: FillRegionParamsSchema,
    result: FillRegionResultSchema,
  },
  pasteSchematic: {
    params: PasteSchematicParamsSchema,
    result: PasteSchematicResultSchema,
  },
  saveSchematic: {
    params: SaveSchematicParamsSchema,
    result: SaveSchematicResultSchema,
  },
  captureRegion: {
    params: CaptureRegionParamsSchema,
    result: CaptureRegionResultSchema,
  },
  applyDiff: { params: ApplyDiffParamsSchema, result: ApplyDiffResultSchema },
  undoDiff: { params: UndoDiffParamsSchema, result: UndoDiffResultSchema },
  snapshot: { params: SnapshotParamsSchema, result: SnapshotResultSchema },
  restoreSnapshot: {
    params: RestoreSnapshotParamsSchema,
    result: RestoreSnapshotResultSchema,
  },
  getJob: { params: GetJobParamsSchema, result: GetJobResultSchema },
  dryRun: { params: DryRunParamsSchema, result: DryRunResultSchema },
  releaseRegion: {
    params: ReleaseRegionParamsSchema,
    result: ReleaseRegionResultSchema,
  },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

type MethodSchemas = typeof methodSchemas;

/** Ordered list of every RPC method name. */
export const METHODS = Object.keys(methodSchemas) as MethodName[];

/** zod enum for validating an incoming method name. */
export const MethodNameSchema = z.enum(
  Object.keys(methodSchemas) as [MethodName, ...MethodName[]],
);

/** Union of all RPC method names. */
export type MethodName = keyof MethodSchemas;

/** Map: method name -> its parsed (output) params type. */
export type MethodParams = {
  [K in MethodName]: z.infer<MethodSchemas[K]["params"]>;
};
/** Map: method name -> its input params type (before defaults applied). */
export type MethodParamsInput = {
  [K in MethodName]: z.input<MethodSchemas[K]["params"]>;
};
/** Map: method name -> its result type. */
export type MethodResult = {
  [K in MethodName]: z.infer<MethodSchemas[K]["result"]>;
};

/** A typed JSON-RPC request for a specific method. */
export type TypedRpcRequest<M extends MethodName = MethodName> = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RpcId;
  method: M;
  params: MethodParams[M];
};

/* ============================================================================
 * 10. Validation helpers
 * ========================================================================== */

/** Look up the `{ params, result }` schemas for a method. */
export function getMethodSchema<M extends MethodName>(
  method: M,
): MethodSchemas[M] {
  return methodSchemas[method];
}

/** Parse+validate the params for a method, applying defaults. Throws on invalid. */
export function parseMethodParams<M extends MethodName>(
  method: M,
  data: unknown,
): MethodParams[M] {
  return methodSchemas[method].params.parse(data) as MethodParams[M];
}

/** Parse+validate the result for a method. Throws on invalid. */
export function parseMethodResult<M extends MethodName>(
  method: M,
  data: unknown,
): MethodResult[M] {
  return methodSchemas[method].result.parse(data) as MethodResult[M];
}

/** Narrowing type guard for a known method name. */
export function isMethodName(value: string): value is MethodName {
  return Object.prototype.hasOwnProperty.call(methodSchemas, value);
}
