FROM node:24.18.0-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json worker-configuration.d.ts ./
COPY src ./src
COPY container-models ./container-models
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.18.0-slim
ENV NODE_ENV=production \
    PORT=8080 \
    AGENT_CONFIG_PATH=/data/runtime-config.enc.json
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/container-models ./container-models
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/container/server.js"]
