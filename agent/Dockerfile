FROM node:24.18.0-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY container-models ./container-models
RUN npm run build
RUN npm prune --omit=dev

FROM node:24.18.0-slim AS agent
ENV NODE_ENV=production \
    PORT=8080 \
    AGENT_CONFIG_PATH=/data/runtime-config.enc.json \
    AGENT_CHECKPOINT_DB_PATH=/checkpoints/agent-checkpoints.db
WORKDIR /app
RUN mkdir -p /data /checkpoints \
    && chown node:node /data /checkpoints
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/container-models ./container-models
COPY --chmod=755 docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["agent-entrypoint"]
CMD ["node", "dist/container/server.js"]

FROM nginx:1.29.1-alpine AS web
COPY --chmod=755 docker/nginx-entrypoint.sh /usr/local/bin/nginx-entrypoint
COPY docker/nginx.conf.template /etc/nginx/templates/naibaji.conf.template
COPY public /usr/share/nginx/html
RUN rm -f /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
ENTRYPOINT ["nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
