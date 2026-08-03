import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const worker = readFileSync(resolve(root, "src/worker/index.ts"), "utf8");
const wrangler = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const compose = readFileSync(resolve(root, "docker/compose.local.yaml"), "utf8");

describe("local frontend/backend boundary", () => {
  it("keeps the Worker as a same-origin static host and API proxy", () => {
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain("proxyToLocalBackend");
    expect(worker).toContain('headers.set("x-agent-gateway-secret"');
    expect(worker).toContain("env.ASSETS.fetch(request)");
    expect(worker).not.toContain("verifySupabaseJwt");
    expect(worker).not.toContain("supabaseRest");
  });

  it("routes the tunnel-facing local Worker to the local container", () => {
    expect(wrangler).toContain('"LOCAL_AGENT_URL": "http://127.0.0.1:8080"');
    expect(wrangler).not.toContain("SUPABASE_URL");
    expect(wrangler).not.toContain("SUPABASE_PUBLISHABLE_KEY");
  });

  it("starts the container with local storage and local administrator seeding", () => {
    expect(compose).toContain("AGENT_STORAGE_BACKEND: ${AGENT_STORAGE_BACKEND:-local}");
    expect(compose).toContain("LOCAL_DB_PATH: ${LOCAL_DB_PATH:-/data/naibaji.db}");
    expect(compose).toContain("LOCAL_ADMIN_EMAIL:");
    expect(compose).toContain("LOCAL_ADMIN_PASSWORD:");
    expect(compose).not.toContain("SUPABASE_URL:");
  });
});
