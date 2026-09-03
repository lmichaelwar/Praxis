# Build from the repository root:
# docker build -f apps/render-worker/Dockerfile -t praxis-render-worker .
FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
COPY apps/render-worker/package.json apps/render-worker/package.json
COPY packages/project-schema/package.json packages/project-schema/package.json
COPY packages/render-manifest/package.json packages/render-manifest/package.json
RUN npm ci --workspace @praxis/render-worker --workspace @praxis/render-manifest --workspace @praxis/project-schema

COPY apps/render-worker apps/render-worker
COPY packages/project-schema packages/project-schema
COPY packages/render-manifest packages/render-manifest
RUN npm run build --workspace @praxis/render-worker

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-roboto-unhinted ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PRAXIS_RENDER_PORT=8790 \
    PRAXIS_OBJECT_STORE_ROOT=/data/objects \
    PRAXIS_RENDER_TEMP_ROOT=/data/tmp \
    PRAXIS_FONT_PATH=/usr/share/fonts/truetype/roboto/unhinted/RobotoCondensed-Bold.ttf \
    PRAXIS_FONT_FAMILY="Roboto Condensed Variable" \
    PRAXIS_ASS_FONT_FAMILY="Roboto Condensed" \
    PRAXIS_FONT_WEIGHT=700 \
    PRAXIS_FONT_STYLE=normal
WORKDIR /app
COPY --from=build /workspace/apps/render-worker/dist ./dist
COPY --from=build /workspace/node_modules ./node_modules
RUN mkdir -p /data/objects /data/tmp && chown -R node:node /data
USER node
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8790/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
