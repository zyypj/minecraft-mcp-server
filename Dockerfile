# The Minecraft 1.8 build engine, as an MCP server over stdio.
#
# The image carries only what the build engine needs. `mineflayer` and `minecraft-data` are optional
# dependencies of the MCP package — a quarter of a gigabyte that only the legacy player-bot backend
# uses — so `--omit=optional` leaves them out and the engine backend never notices.
#
# Build:  docker build -t minecraft-build-mcp .
# Run:    docker run -i --rm -v ./schematics:/data/schematics -v ./builds:/data/builds \
#                          -v ./styles:/data/styles minecraft-build-mcp

# ---------------------------------------------------------------------------------------------
# Stage 1 — compile the engine and the MCP server
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /src

# The engine has zero runtime dependencies, so its install is dev-tooling only and caches well.
COPY engine/package.json engine/tsconfig.json engine/tsconfig.build.json ./engine/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix engine install --no-audit --no-fund --ignore-scripts

COPY engine/src ./engine/src
RUN npm --prefix engine run build

# The protocol package is a type-only dependency of the legacy plugin backend, but the MCP package
# imports it, so it has to resolve at compile time.
COPY protocol/package.json protocol/tsconfig.json ./protocol/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix protocol install --no-audit --no-fund --ignore-scripts
COPY protocol/ts ./protocol/ts
COPY protocol/schema ./protocol/schema

# Install the MCP package with its optional deps, because the *type* declarations for the bot
# backend are needed to compile it even though the runtime image will not ship them.
COPY mcp/package.json mcp/tsconfig.json mcp/tsconfig.build.json ./mcp/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix mcp install --no-audit --no-fund --ignore-scripts

COPY mcp/src ./mcp/src
RUN npm --prefix mcp run build

# ---------------------------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only, and without the optional bot stack.
COPY engine/package.json ./engine/
COPY --from=builder /src/engine/dist ./engine/dist

COPY protocol/package.json ./protocol/
COPY protocol/ts ./protocol/ts
COPY protocol/schema ./protocol/schema
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix protocol install --omit=dev --no-audit --no-fund --ignore-scripts

COPY mcp/package.json ./mcp/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix mcp install --omit=dev --omit=optional --no-audit --no-fund --ignore-scripts

COPY --from=builder /src/mcp/dist ./mcp/dist

# A launcher, so attaching to a running container is one word instead of a long argument list.
COPY docker/mcp-build /usr/local/bin/mcp-build
RUN chmod +x /usr/local/bin/mcp-build

# The three mount points. Creating them here means an unmounted run still works, writing inside the
# container, rather than failing on a missing directory.
RUN mkdir -p /data/schematics /data/builds /data/styles \
    && chown -R node:node /data /app

USER node

VOLUME ["/data/schematics", "/data/builds", "/data/styles"]

# The MCP protocol is JSON-RPC over stdio, so the container's stdin/stdout *are* the transport.
# It must be run with -i; there is nothing to expose on a port.
ENTRYPOINT ["node", "/app/mcp/dist/main.js", \
            "--backend", "engine", \
            "--schematics-dir", "/data/schematics", \
            "--builds-dir", "/data/builds", \
            "--styles-dir", "/data/styles"]
