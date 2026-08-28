# kortix-worker — the harness, and nothing else.
#
# What is deliberately NOT here, compared with apps/sandbox/Dockerfile
# (Ubuntu 24.04 + TeX Live + LibreOffice + ffmpeg + Tesseract + Python/uv +
# Node + Bun + pnpm + Playwright browsers, ~6-8 GB):
#
#   no compilers, no interpreters, no browsers, no git, no package manager.
#
# The agent cannot use any of it, because every built-in tool resolves its
# filesystem and shell through the injected ExecutionEnv, which addresses an
# environment over the network. There is nothing here for it to reach.

# The runtime is one binary. npm, corepack and node's headers are ~90 MB of an
# image that will never install anything — the bundle is self-contained and
# nothing is resolved at boot — so we take the node binary and its two musl
# dependencies onto a bare Alpine rather than deleting them from a layer that
# would still ship.
FROM node:22-alpine AS nodesrc

FROM alpine:3.21 AS runtime
COPY --from=nodesrc /usr/local/bin/node /usr/local/bin/node
RUN apk add --no-cache libstdc++

WORKDIR /opt/kortix
# One self-contained .mjs. No node_modules in the image, no install at boot.
COPY dist/worker.mjs /opt/kortix/worker.mjs
# Bench-only: lets the RPC-tax gate import the transports inside the sandbox.
COPY dist/rpc-transport.mjs /opt/kortix/rpc-transport.mjs

# Unprivileged, and intended to run with `--read-only`. Defence in depth behind
# the ExecutionEnv seam: even a hand-written tool reaching for node:fs finds
# nothing writable.
RUN addgroup -S kortix && adduser -S -G kortix kortix
USER kortix

ENV NODE_ENV=production \
    PORT=8080 \
    KORTIX_MODEL_MODE=faux \
    KORTIX_ENV_CWD=/workspace

EXPOSE 8080
ENTRYPOINT ["node", "/opt/kortix/worker.mjs"]
