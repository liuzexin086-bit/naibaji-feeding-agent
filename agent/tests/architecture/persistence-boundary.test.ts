import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const persistenceRoot = resolve(import.meta.dirname, "../../src/persistence");
const forbiddenImport = /(?:^|[/.-])(?:container|langgraph|react|ui|optimizer)(?:[/.'"]|$)/i;
const importTarget = /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

describe("persistence architecture boundary", () => {
  it("keeps persistence adapters independent from orchestration and UI", () => {
    const files = readdirSync(persistenceRoot).filter((file) => file.endsWith(".ts"));
    expect(files.sort()).toEqual([
      "contracts.ts",
      "index.ts",
      "observation-codec.ts",
      "sqlite-observation-repository.ts",
    ]);
    for (const file of files) {
      const source = readFileSync(resolve(persistenceRoot, file), "utf8");
      for (const match of source.matchAll(importTarget)) {
        expect(match[1], `${file} import`).not.toMatch(forbiddenImport);
      }
    }
  });
});
