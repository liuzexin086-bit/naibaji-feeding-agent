FROM node:24.18.0-slim AS build
WORKDIR /app
ARG GIT_COMMIT=unknown
RUN echo "$GIT_COMMIT" > /app/version

COPY agent/package.json agent/package-lock.json ./
COPY packages/persistence /packages/persistence
COPY packages/feeding-model packages/feeding-model
RUN npm ci

COPY agent/tsconfig.json ./
COPY agent/src ./src
COPY agent/scripts ./scripts
COPY agent/ui ./ui
COPY v5lite-model.js ./
RUN npm run build
RUN node scripts/write-provenance.mjs "$GIT_COMMIT"
RUN npm prune --omit=dev

FROM node:24.18.0-slim AS agent
ENV NODE_ENV=production \
    PORT=8080 \
    AGENT_CONFIG_PATH=/data/runtime-config.enc.json \
    AGENT_CHECKPOINT_DB_PATH=/checkpoints/agent-checkpoints.db
WORKDIR /app
RUN mkdir -p /data /checkpoints \
    && chown node:node /data /checkpoints
ARG GIT_COMMIT=unknown
RUN echo "$GIT_COMMIT" > /app/version
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /packages/persistence /packages/persistence
COPY --from=build /app/dist ./dist
COPY --from=build /app/version ./version
COPY --from=build /app/.generated-models ./.generated-models
COPY --from=build /app/agent-provenance.json ./agent-provenance.json
COPY --chmod=755 agent/docker/agent-entrypoint.sh /usr/local/bin/agent-entrypoint
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["agent-entrypoint"]
CMD ["node", "dist/container/server.js"]

FROM nginx:1.29.1-alpine AS web
ARG GIT_COMMIT=unknown
COPY --chmod=755 agent/docker/nginx-entrypoint.sh /usr/local/bin/nginx-entrypoint
COPY agent/docker/nginx.conf.template /etc/nginx/templates/naibaji.conf.template
COPY admin.html admin.js chart.umd.min.js v5lite-model.js /tmp/naibaji-assets/
COPY --from=build /app/.generated-web/feeding-model.min.js /tmp/naibaji-assets/feeding-model.min.js
COPY agent/ui /tmp/naibaji-assets/ui/
RUN mkdir -p /usr/share/nginx/html \
    && cp /tmp/naibaji-assets/admin.html /tmp/naibaji-assets/admin.js /tmp/naibaji-assets/chart.umd.min.js /tmp/naibaji-assets/feeding-model.min.js /tmp/naibaji-assets/v5lite-model.js /usr/share/nginx/html/ \
    && cp -r /tmp/naibaji-assets/ui /usr/share/nginx/html/ui \
    && cp /tmp/naibaji-assets/ui/liquid-index.html /usr/share/nginx/html/index.html \
    && echo "$GIT_COMMIT" > /usr/share/nginx/html/version
COPY --from=build /app/web-provenance.json /usr/share/nginx/html/version.json
RUN rm -f /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
ENTRYPOINT ["nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
