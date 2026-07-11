package com.mcbuild.buildengine.rpc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.mcbuild.buildengine.region.RegionRegistry;
import com.mcbuild.buildengine.world.WorldEditor;
import io.javalin.Javalin;
import org.bukkit.Bukkit;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

import static com.mcbuild.buildengine.rpc.JsonRpc.INTERNAL_ERROR;
import static com.mcbuild.buildengine.rpc.JsonRpc.INVALID_REQUEST;
import static com.mcbuild.buildengine.rpc.JsonRpc.METHOD_NOT_FOUND;
import static com.mcbuild.buildengine.rpc.JsonRpc.MAPPER;
import static com.mcbuild.buildengine.rpc.JsonRpc.NOT_IMPLEMENTED;
import static com.mcbuild.buildengine.rpc.JsonRpc.UNAUTHORIZED;

/**
 * Embedded JSON-RPC 2.0 server (§3.3): Javalin (embedded Jetty) exposing HTTP {@code POST /rpc} for
 * one-shot calls and WebSocket {@code /ws} for the long-running iterative session with streamed
 * {@code job.progress} notifications. Binds localhost, bearer-token auth.
 *
 * <p><b>Implemented for real:</b> {@code authenticate} (token validation + server/version/FAWE info).
 * Every other §3.3 method is a clear stub — mutating methods return a (TODO) {@code jobId}, queries throw
 * a {@code NOT_IMPLEMENTED} JSON-RPC error tagged with the milestone that will implement it.
 *
 * <p><b>Threading:</b> Javalin/Jetty handlers run OFF the main server thread. Handlers must never touch
 * the world directly — they go through {@link WorldEditor}, whose two implementations own their own
 * threading (§3.4). {@code authenticate} only reads immutable server metadata, so it is main-thread-safe
 * to call from here.
 */
public final class RpcServer {

    /** Immutable server config (subset of config.yml relevant to the RPC layer). */
    public record Config(
            String host,
            int port,
            String token,
            long maxRegionVolume,
            int budgetPerTick,
            List<String> worldAllowlist,
            boolean faweAvailable
    ) {}

    /** Sink for streamed {@code job.progress} notifications. No-op over one-shot HTTP; real over WS. */
    @FunctionalInterface
    public interface ProgressSink {
        void progress(String jobId, long done, long total);
        ProgressSink NOOP = (jobId, done, total) -> { };
    }

    /** A dispatchable RPC method. */
    @FunctionalInterface
    private interface RpcMethod {
        Object invoke(JsonNode params, ProgressSink progress) throws Exception;
    }

    private final Logger log;
    private final Config config;
    private final WorldEditor worldEditor;
    private final RegionRegistry regions;
    private final Map<String, RpcMethod> methods = new ConcurrentHashMap<>();

    private Javalin app;

    public RpcServer(Logger log, Config config, WorldEditor worldEditor, RegionRegistry regions) {
        this.log = log;
        this.config = config;
        this.worldEditor = worldEditor;
        this.regions = regions;
        registerMethods();
    }

    // ------------------------------------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------------------------------------

    public void start() {
        this.app = Javalin.create(cfg -> {
            cfg.showJavalinBanner = false;
            // NOTE: bind loopback only. Javalin's start(host, port) below enforces the host.
        });

        // One-shot JSON-RPC over HTTP.
        app.post("/rpc", ctx -> {
            if (!authorized(ctx.header("Authorization"), ctx.queryParam("token"))) {
                ctx.status(401).contentType("application/json")
                        .result(errorJson(null, UNAUTHORIZED, "Unauthorized"));
                return;
            }
            ctx.contentType("application/json").result(handle(ctx.body(), ProgressSink.NOOP));
        });

        // Long-running session over WebSocket, with streamed job.progress notifications.
        app.ws("/ws", ws -> {
            ws.onConnect(ctx -> {
                if (!authorized(ctx.header("Authorization"), ctx.queryParam("token"))) {
                    // 1008 = policy violation.
                    ctx.closeSession(1008, "Unauthorized");
                }
            });
            ws.onMessage(ctx -> {
                // Progress notifications for this request stream back over the same socket.
                ProgressSink sink = (jobId, done, total) -> {
                    try {
                        ObjectNode n = MAPPER.createObjectNode();
                        n.put("jsonrpc", "2.0");
                        n.put("method", "job.progress");
                        ObjectNode p = n.putObject("params");
                        p.put("jobId", jobId);
                        p.put("done", done);
                        p.put("total", total);
                        ctx.send(MAPPER.writeValueAsString(n));
                    } catch (Exception ignored) {
                        // best-effort progress; never fail the edit because a progress frame failed
                    }
                };
                ctx.send(handle(ctx.message(), sink));
            });
            ws.onClose(ctx -> {
                // TODO: cancel/await in-flight jobs owned by this session, release its selections (§3.4).
            });
        });

        // Enforce the configured (loopback) host.
        app.start(config.host(), config.port());
    }

    public void stop() {
        if (app != null) {
            app.stop();
            app = null;
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Auth
    // ------------------------------------------------------------------------------------------------

    /** Accept the token from {@code Authorization: Bearer <token>} or a {@code ?token=} query param. */
    private boolean authorized(String authHeader, String tokenParam) {
        String presented = null;
        if (authHeader != null && authHeader.regionMatches(true, 0, "Bearer ", 0, 7)) {
            presented = authHeader.substring(7).trim();
        } else if (tokenParam != null) {
            presented = tokenParam;
        }
        return presented != null && constantTimeEquals(presented, config.token());
    }

    private static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    // ------------------------------------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------------------------------------

    /** Parse, dispatch, and serialize a single JSON-RPC request. Returns the response JSON string. */
    private String handle(String body, ProgressSink progress) {
        JsonNode root;
        try {
            root = MAPPER.readTree(body);
        } catch (Exception e) {
            return errorJson(null, JsonRpc.PARSE_ERROR, "Parse error");
        }
        // Batch requests are not supported in this scaffold (single object only).
        JsonNode id = root.get("id");
        try {
            String method = root.path("method").asText(null);
            if (method == null || method.isEmpty()) {
                return errorJson(id, INVALID_REQUEST, "Missing 'method'");
            }
            RpcMethod handler = methods.get(method);
            if (handler == null) {
                return errorJson(id, METHOD_NOT_FOUND, "Method not found: " + method);
            }
            JsonNode params = root.has("params") ? root.get("params") : MAPPER.createObjectNode();
            Object result = handler.invoke(params, progress);
            return JsonRpc.write(JsonRpc.Response.ok(id, result));
        } catch (JsonRpc.RpcException e) {
            return JsonRpc.write(JsonRpc.Response.err(id, new JsonRpc.Error(e.code(), e.getMessage(), e.data())));
        } catch (Exception e) {
            log.warning("RPC internal error: " + e);
            return errorJson(id, INTERNAL_ERROR, String.valueOf(e.getMessage()));
        }
    }

    private static String errorJson(JsonNode id, int code, String message) {
        return JsonRpc.write(JsonRpc.Response.err(id, new JsonRpc.Error(code, message, null)));
    }

    // ------------------------------------------------------------------------------------------------
    // Method registry
    // ------------------------------------------------------------------------------------------------

    private void registerMethods() {
        // --- Fully implemented ---
        methods.put("authenticate", this::authenticate);

        // --- Mutating methods: §3.3 returns a jobId immediately, executes async (stubbed) ---
        methods.put("setBlocks",      stubJob("setBlocks", "M1"));
        methods.put("fillRegion",     stubJob("fillRegion", "M1"));
        methods.put("pasteSchematic", stubJob("pasteSchematic", "M2"));
        methods.put("applyDiff",      stubJob("applyDiff", "M5"));
        methods.put("undoDiff",       stubJob("undoDiff", "M5"));
        methods.put("snapshot",       stubJob("snapshot", "M1"));
        methods.put("restoreSnapshot", stubJob("restoreSnapshot", "M1"));
        methods.put("captureRegion",  stubJob("captureRegion", "M4"));
        methods.put("saveSchematic",  stubJob("saveSchematic", "M2"));

        // --- Query / control methods: return data (stubbed as NOT_IMPLEMENTED for now) ---
        methods.put("selectRegion",   notImplemented("selectRegion", "M1"));
        methods.put("getRegionInfo",  notImplemented("getRegionInfo", "M1"));
        methods.put("getBlocks",      notImplemented("getBlocks", "M2"));
        methods.put("getJob",         notImplemented("getJob", "M1"));
        methods.put("dryRun",         notImplemented("dryRun", "M2"));
        methods.put("releaseRegion",  notImplemented("releaseRegion", "M1"));
    }

    // ------------------------------------------------------------------------------------------------
    // authenticate — THE fully-worked method
    // ------------------------------------------------------------------------------------------------

    /**
     * {@code authenticate({token}) -> {ok, serverVersion, dataVersion, faweAvailable}} (§3.3).
     *
     * <p>The transport already required a valid bearer token to reach any method; {@code authenticate}
     * additionally validates the {@code token} param (matching the documented signature) and returns the
     * server metadata the Node client needs to negotiate ({@code .schem} DataVersion, whether FAWE is
     * the active backend, etc.).
     */
    @SuppressWarnings("deprecation") // Bukkit.getUnsafe() (UnsafeValues) is the supported way to read DataVersion
    private Object authenticate(JsonNode params, ProgressSink progress) {
        String provided = params.path("token").asText(null);
        if (provided == null || !constantTimeEquals(provided, config.token())) {
            throw new JsonRpc.RpcException(UNAUTHORIZED, "Invalid token");
        }

        int dataVersion;
        try {
            dataVersion = Bukkit.getUnsafe().getDataVersion();
        } catch (Throwable t) {
            dataVersion = -1; // never fail the handshake if the server hides this
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", true);
        result.put("serverVersion", Bukkit.getVersion());
        result.put("dataVersion", dataVersion);
        // Report the ACTIVE backend, not merely whether the FAWE plugin is installed.
        result.put("faweAvailable", worldEditor.isFawe() && config.faweAvailable());
        return result;
    }

    // ------------------------------------------------------------------------------------------------
    // Stub helpers
    // ------------------------------------------------------------------------------------------------

    /**
     * A mutating-method stub that honours the §3.3 job contract by minting a jobId and returning it
     * immediately. The job does not actually run yet (no progress is emitted); the {@code state:"TODO"}
     * field makes that explicit to the caller.
     */
    private RpcMethod stubJob(String method, String milestone) {
        return (params, progress) -> {
            String jobId = "job-" + UUID.randomUUID();
            // TODO (milestone): validate params, enforce limits (maxRegionVolume / worldAllowlist), then
            //   regions.get(selectionId).serializeEdit(() -> worldEditor.<op>(...)) and stream job.progress.
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("jobId", jobId);
            result.put("state", "TODO");
            result.put("note", method + " not implemented yet (" + milestone + ")");
            return result;
        };
    }

    /** A query-method stub that returns a NOT_IMPLEMENTED JSON-RPC error tagged with its milestone. */
    private RpcMethod notImplemented(String method, String milestone) {
        return (params, progress) -> {
            throw new JsonRpc.RpcException(NOT_IMPLEMENTED, "TODO " + milestone + ": " + method + " not implemented");
        };
    }
}
