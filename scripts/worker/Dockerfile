# Off-laptop analysis worker.
#
# Deliberately pins Stockfish 16 rather than installing whatever the distro
# ships. The evaluation a given Stockfish version produces is what every
# classification and accuracy figure in the library is derived from, so a
# different version would quietly make its output non-comparable with the rest.
# `npm run worker:verify` is the check; this pin is what makes it pass.
#
# Build from the repo root:
#   docker build -f scripts/worker/Dockerfile -t chess-coach-worker .
#
# Run (see README.md for the env vars):
#   docker run --rm --env-file worker.env chess-coach-worker

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# Dev deps needed: esbuild does the bundling, chess.js is bundled in.
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN node scripts/worker/build.mjs

FROM node:22-bookworm-slim
WORKDIR /app

# Stockfish 16, official build. The AVX2 binary is much faster but needs a CPU
# that supports it; nearly every cloud instance since ~2014 does. If yours
# doesn't, swap to the `-sse41-popcnt` archive — the evaluation is identical,
# only the speed differs.
ARG SF_URL=https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-ubuntu-x86-64-avx2.tar
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL "$SF_URL" -o /tmp/sf.tar \
 && tar -xf /tmp/sf.tar -C /tmp \
 && mv /tmp/stockfish/stockfish-ubuntu-x86-64-avx2 /usr/local/bin/stockfish \
 && chmod +x /usr/local/bin/stockfish \
 && rm -rf /tmp/sf.tar /tmp/stockfish \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# The network is embedded in the binary (which is why it is ~40 MB), so there is
# no separate .nnue to ship. Fail the build if that ever stops being true rather
# than silently shipping a worker that falls back to classical eval.
RUN printf 'uci\n' | timeout 30 stockfish | grep -q 'id name Stockfish 16' \
 && echo "stockfish 16 ok"

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist-worker ./dist-worker

ENV STOCKFISH_PATH=/usr/local/bin/stockfish
ENV NODE_ENV=production

# Default to the verifier being one command away, but run the worker.
CMD ["node", "dist-worker/worker.mjs"]
