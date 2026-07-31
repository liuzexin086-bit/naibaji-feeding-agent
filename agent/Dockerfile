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
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/container-models ./container-models
EXPOSE 8080
USER node
CMD ["node", "dist/container/server.js"]
