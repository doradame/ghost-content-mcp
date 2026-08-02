# node:22-slim (glibc) — onnxruntime-node's native binding does not load on alpine/musl.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Cache the model layer independently of source changes.
COPY scripts ./scripts
RUN EMBEDDINGS_CACHE_DIR=/app/models npm run fetch-model
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV EMBEDDINGS_CACHE_DIR=/app/models
# onnxruntime spawns worker threads; cap glibc arenas so freed memory isn't retained (lower RSS).
ENV MALLOC_ARENA_MAX=2
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
