import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const compose = readFileSync(resolve(root, "docker/compose.local.yaml"), "utf8");
const nginx = readFileSync(resolve(root, "docker/nginx.conf.template"), "utf8");

describe("local Nginx frontend/backend boundary", () => {
  it("keeps Nginx as a same-origin static host and API proxy", () => {
    expect(nginx).toContain("root /usr/share/nginx/html");
    expect(nginx).toContain("location ^~ /api/");
    expect(nginx).toContain("proxy_pass http://agent:8080");
    expect(nginx).toContain("proxy_set_header X-Agent-Gateway-Secret");
    expect(nginx).toContain("proxy_buffering off");
  });

  it("routes the optional tunnel to Nginx without publishing private services", () => {
    expect(compose).toContain('profiles: ["tunnel"]');
    expect(compose).toContain('"127.0.0.1:${INGRESS_PORT:-8788}:8080"');
    expect(compose).toContain("internal: true");
    expect(compose).not.toContain("SUPABASE_URL");
  });

  it("starts the container with local storage and local administrator seeding", () => {
    expect(compose).toContain("AGENT_STORAGE_BACKEND: ${AGENT_STORAGE_BACKEND:-local}");
    expect(compose).toContain("LOCAL_DB_PATH: ${LOCAL_DB_PATH:-/data/naibaji.db}");
    expect(compose).toContain("LOCAL_ADMIN_EMAIL:");
    expect(compose).toContain("local_admin_password:");
    expect(compose).not.toContain("SUPABASE_URL:");
  });
});
