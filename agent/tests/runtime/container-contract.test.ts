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
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+/);
  });

  it("keeps database ports private and binds local ingress to loopback", async () => {
    const compose = await readFile(join(root, "docker", "compose.local.yaml"), "utf8");
    const caddy = await readFile(join(root, "docker", "Caddyfile"), "utf8");

    expect(compose).toContain('"127.0.0.1:${AGENT_PORT:-8080}:8080"');
    expect(compose).toContain('"127.0.0.1:${CADDY_PORT:-8788}:8080"');
    expect(compose).not.toMatch(/\b5432:/);
    expect(caddy).toContain("respond @internal 404");
  });

  it("preserves staging and provides an explicit Wrangler local profile", async () => {
    const wrangler = await readFile(join(root, "wrangler.jsonc"), "utf8");

    expect(wrangler).toContain('"local"');
    expect(wrangler).toContain('"LOCAL_AGENT_URL": "http://127.0.0.1:8080"');
    expect(wrangler).toContain('"staging"');
  });
});
