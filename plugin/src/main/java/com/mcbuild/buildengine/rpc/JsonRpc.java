package com.mcbuild.buildengine.rpc;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * JSON-RPC 2.0 framing types + Jackson (de)serialization helpers (§3.3).
 *
 * <p>Envelope: {@code { "jsonrpc":"2.0", "id":..., "method":..., "params":{...} }}. {@code id} is kept as
 * a raw {@link JsonNode} so string/number/null ids all round-trip unchanged. Responses omit whichever of
 * {@code result}/{@code error} is null (JSON-RPC requires exactly one) via {@link JsonInclude}.
 */
public final class JsonRpc {

    private JsonRpc() {}

    /** Shared mapper. {@code -parameters} (see build.gradle) lets Jackson bind record components by name. */
    public static final ObjectMapper MAPPER = new ObjectMapper();

    // ---- Standard JSON-RPC 2.0 error codes ----
    public static final int PARSE_ERROR      = -32700;
    public static final int INVALID_REQUEST  = -32600;
    public static final int METHOD_NOT_FOUND = -32601;
    public static final int INVALID_PARAMS   = -32602;
    public static final int INTERNAL_ERROR   = -32603;

    // ---- App-specific (implementation-defined -32000..-32099) ----
    public static final int UNAUTHORIZED   = -32000;
    public static final int NOT_IMPLEMENTED = -32001;

    /** Inbound request. */
    public record Request(String jsonrpc, JsonNode id, String method, JsonNode params) {}

    /** Outbound response. Exactly one of {@code result}/{@code error} is non-null. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Response(String jsonrpc, JsonNode id, Object result, Error error) {
        public static Response ok(JsonNode id, Object result) {
            return new Response("2.0", id, result, null);
        }
        public static Response err(JsonNode id, Error error) {
            return new Response("2.0", id, null, error);
        }
    }

    /** Error object. {@code data} is optional. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Error(int code, String message, Object data) {}

    /**
     * Thrown by a method handler to produce a JSON-RPC error response with a specific code.
     * (E.g. {@link #UNAUTHORIZED} from {@code authenticate}, {@link #NOT_IMPLEMENTED} from a stub.)
     */
    public static final class RpcException extends RuntimeException {
        private final int code;
        private final transient Object data;

        public RpcException(int code, String message) {
            this(code, message, null);
        }

        public RpcException(int code, String message, Object data) {
            super(message);
            this.code = code;
            this.data = data;
        }

        public int code() { return code; }
        public Object data() { return data; }
    }

    /** Serialize any value to a JSON string, falling back to a hardcoded internal-error envelope. */
    public static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            return "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":" + INTERNAL_ERROR
                    + ",\"message\":\"response serialization failed\"}}";
        }
    }
}
