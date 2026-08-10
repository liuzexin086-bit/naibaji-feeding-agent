import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
const serviceBlock = (compose: string, service: string) => {
  const start = compose.indexOf(`\n  ${service}:`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe("Docker Compose deployment contract", () => {
  const dockerfile = read("Dockerfile");
  const compose = read("docker/compose.local.yaml");
  const nginx = read("docker/nginx.conf.template");

  it("builds separate non-root Agent and static Nginx targets", () => {
    expect(dockerfile).toContain("FROM node:24.18.0-slim AS agent");
    expect(dockerfile).toContain("FROM nginx:1.29.1-alpine AS web");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("COPY admin.html admin.js chart.umd.min.js v5lite-model.js /tmp/naibaji-assets/");
    expect(dockerfile).toContain("COPY --from=build /app/.generated-web/feeding-model.min.js /tmp/naibaji-assets/feeding-model.min.js");
    expect(dockerfile).toContain("COPY agent/ui /tmp/naibaji-assets/ui/");
    expect(dockerfile).toContain('echo "$GIT_COMMIT" > /usr/share/nginx/html/version');
    expect(compose).toContain("context: ../..");
    expect(compose).toContain("dockerfile: agent/Dockerfile");
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+/);
  });

  it("uses the Tunnel to Nginx topology and keeps data services private", () => {
    expect(compose).toContain("cloudflare/cloudflared:2026.7.0");
    expect(serviceBlock(compose, "cloudflared")).toContain('network_mode: "service:nginx"');
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain('"127.0.0.1:${INGRESS_PORT:-8788}:8080"');
    expect(compose).toContain("chromadb/chroma:1.5.9");
    expect(compose).toContain("text-embeddings-inference:cpu-1.9.3");
    expect(compose).toContain("internal: true");
    expect(compose).toContain("CHROMA_URL: http://chroma:8000");
    expect(compose).toContain("EMBEDDING_BASE_URL: http://embedding:80");
    expect(serviceBlock(compose, "chroma")).toContain("/dev/tcp/127.0.0.1/8000");
    expect(serviceBlock(compose, "chroma")).not.toContain('"python"');
    expect(serviceBlock(compose, "agent")).not.toContain("\n    ports:");
    expect(serviceBlock(compose, "chroma")).not.toContain("\n    ports:");
    expect(serviceBlock(compose, "embedding")).not.toContain("\n    ports:");
  });

  it("pins the Chinese CPU embedding model and isolated persistent volumes", () => {
    expect(compose).toContain("BAAI/bge-small-zh-v1.5");
    expect(compose).toContain("534b6bfaaf500e70bcb9f3771cebc940c23b219d");
    expect(compose).toContain("name: naibaji-agent-config");
    expect(compose).toContain("name: naibaji-agent-checkpoints");
    expect(compose).toContain("name: naibaji-chroma-data");
    expect(compose).toContain("name: naibaji-embedding-cache");
    expect(compose).toContain("environment: AGENT_GATEWAY_SECRET");
    expect(compose).toContain("environment: LANGSMITH_API_KEY");
  });

  it("serves the UI and proxies API/SSE without buffering", () => {
    expect(nginx).toContain("root /usr/share/nginx/html");
    expect(nginx).toContain("listen 8787");
    expect(nginx).toContain("location ^~ /api/");
    expect(nginx).toContain("proxy_pass http://agent:8080");
    expect(nginx).toContain("proxy_buffering off");
    expect(nginx).toContain("proxy_request_buffering off");
    expect(nginx).toContain('add_header X-Accel-Buffering "no" always');
    expect(nginx).toContain("proxy_read_timeout 3600s");
    expect(nginx).toContain("location ^~ /internal/");
    expect(nginx).toContain("return 404");
  });

  it("removes the Worker, Wrangler and Caddy runtime path", () => {
    expect(existsSync(resolve(root, "src/worker/index.ts"))).toBe(false);
    expect(existsSync(resolve(root, "src/worker/auth.ts"))).toBe(false);
    expect(existsSync(resolve(root, "wrangler.jsonc"))).toBe(false);
    expect(existsSync(resolve(root, "worker-configuration.d.ts"))).toBe(false);
    expect(existsSync(resolve(root, "docker/Caddyfile"))).toBe(false);
  });
});
