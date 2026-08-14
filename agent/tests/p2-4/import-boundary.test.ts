import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const importRoot = resolve(import.meta.dirname, "../../src/import");
const runtimeForbidden = /(?:^|[/@.])(?:container|local-db|langgraph|langchain|react|supabase|openai|anthropic|llm|ui|legacy|optimizer|shared[\\/]local-store-contract)(?:[/.'"]|$)/i;
const serviceForbidden = /(?:^node:(?:sqlite|os|path)|(?:^|[/@.])(?:sqlite|os|path)(?:[/.'"]|$))/i;
const importTarget = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g;

describe("P2-4 import architecture boundary", () => {
  it("keeps the import authority free of runtime, SQLite, and legacy dependencies", () => {
    const files = readdirSync(importRoot).filter((name) => name.endsWith(".ts")).sort();
    expect(files).toEqual([
      "canonical-json.ts",
      "contracts.ts",
      "identity.ts",
      "importer.ts",
      "owner-mapping.ts",
      "source-adapter.ts",
      "sqlite-adapters.ts",
    ]);
    for (const file of files) {
      const source = readFileSync(join(importRoot, file), "utf8");
      for (const match of source.matchAll(importTarget)) {
        const specifier = match[1] as string;
        expect(specifier, file + " import").not.toMatch(runtimeForbidden);
      }
    }
  });

  it("keeps the application service and identity free of node modules", () => {
    for (const file of ["canonical-json.ts", "contracts.ts", "identity.ts", "importer.ts", "owner-mapping.ts"]) {
      const source = readFileSync(join(importRoot, file), "utf8");
      for (const match of source.matchAll(importTarget)) {
        expect(match[1], file + " import").not.toMatch(serviceForbidden);
      }
    }
  });

  it("keeps the importer dependent only on ports", () => {
    const importer = readFileSync(join(importRoot, "importer.ts"), "utf8");
    expect(importer).not.toContain("node:sqlite");
    expect(importer).not.toContain("node:fs");
    expect(importer).toContain("ImportPersistencePort");
  });

  it("keeps the source adapter read-only", () => {
    const adapter = readFileSync(join(importRoot, "source-adapter.ts"), "utf8");
    expect(adapter).not.toMatch(/writeFileSync|writeFile|appendFile|createWriteStream/);
  });
});
