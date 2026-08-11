import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("local container contract", () => {
  it("pins Node, runs as non-root, and has an HTTP healthcheck", async () => {
    const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");

    expect(dockerfile).toContain("FROM node:24.18.0-slim");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("http://127.0.0.1:8080/health");
    expect(dockerfile).toContain('echo "$GIT_COMMIT" > /app/version');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+/);
  });

  it("keeps database ports private and binds local ingress to loopback", async () => {
    const compose = await readFile(join(root, "docker", "compose.local.yaml"), "utf8");
    const nginx = await readFile(join(root, "docker", "nginx.conf.template"), "utf8");

    expect(compose).toContain('"127.0.0.1:${INGRESS_PORT:-8788}:8080"');
    expect(compose).toContain("internal: true");
    expect(compose).toContain("CHROMA_URL: http://chroma:8000");
    expect(compose).not.toMatch(/\b5432:/);
    expect(nginx).toContain("location ^~ /internal/");
    expect(nginx).toContain("return 404");
    expect(nginx).toContain("proxy_buffering off");
  });

  it("uses Nginx as the static/API edge and keeps Cloudflare Tunnel optional", async () => {
    const compose = await readFile(join(root, "docker", "compose.local.yaml"), "utf8");
    const nginx = await readFile(join(root, "docker", "nginx.conf.template"), "utf8");

    expect(compose).toContain('profiles: ["tunnel"]');
    expect(compose).toContain("cloudflare/cloudflared:");
    expect(nginx).toContain("root /usr/share/nginx/html");
    expect(nginx).toContain("proxy_pass http://agent:8080");
  });
});
