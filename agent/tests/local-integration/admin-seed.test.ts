import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLocalAdmin, verifyPassword } from "../../src/container/local-auth.js";
import { createLocalStore, type SqliteLocalStore } from "../../src/local-db/index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("local administrator bootstrap", () => {
  it("does not rotate an existing password when the container restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "naibaji-admin-seed-"));
    const store = createLocalStore({ filename: join(directory, "local.sqlite") }) as SqliteLocalStore;
    store.migrate();
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    initializeLocalAdmin(store, "admin@example.com", "original-password");
    initializeLocalAdmin(store, "admin@example.com", "replacement-password");

    const credential = store.getUserCredential("admin@example.com");
    expect(credential).not.toBeNull();
    expect(verifyPassword(
      "original-password",
      credential!.passwordHash,
      credential!.passwordSalt,
    )).toBe(true);
    expect(verifyPassword(
      "replacement-password",
      credential!.passwordHash,
      credential!.passwordSalt,
    )).toBe(false);
  });
});
