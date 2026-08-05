import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentStorageConfig,
  selectAgentStorageBackend,
} from "../../src/agent/local-message-store.js";

describe("agent storage selection", () => {
  it("selects local and supabase explicitly while preserving the supabase default", () => {
    expect(selectAgentStorageBackend("local")).toBe("local");
    expect(selectAgentStorageBackend("supabase")).toBe("supabase");
    expect(selectAgentStorageBackend(undefined)).toBe("supabase");
    expect(() => selectAgentStorageBackend("filesystem"))
      .toThrowError("NBJ_AGENT_STORAGE_BACKEND_INVALID");
  });

  it("accepts local configuration without any Supabase environment variables", () => {
    expect(resolveAgentStorageConfig({
      AGENT_STORAGE_BACKEND: "local",
      LOCAL_DB_PATH: ":memory:",
    })).toEqual({ backend: "local", localDbPath: ":memory:" });
  });

  it("conditionally requires the selected backend's environment", () => {
    expect(() => resolveAgentStorageConfig({ AGENT_STORAGE_BACKEND: "local" }))
      .toThrowError("NBJ_LOCAL_DB_PATH_REQUIRED");
    expect(() => resolveAgentStorageConfig({ AGENT_STORAGE_BACKEND: "supabase" }))
      .toThrowError("Missing environment variable SUPABASE_URL");
    expect(resolveAgentStorageConfig({
      AGENT_STORAGE_BACKEND: "supabase",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "publishable",
    })).toMatchObject({ backend: "supabase" });
  });

  it("makes the local compose profile fully local", () => {
    const compose = readFileSync(
      resolve(import.meta.dirname, "../../docker/compose.local.yaml"),
      "utf8",
    );
    expect(compose).toContain("AGENT_STORAGE_BACKEND: ${AGENT_STORAGE_BACKEND:-local}");
    expect(compose).toContain("LOCAL_DB_PATH: ${LOCAL_DB_PATH:-/data/naibaji.db}");
    expect(compose).toContain("LOCAL_ADMIN_EMAIL:");
    expect(compose).toContain("local_admin_password:");
    expect(compose).toContain("environment: LOCAL_ADMIN_PASSWORD");
    expect(compose).not.toContain("SUPABASE_URL:");
  });
});
