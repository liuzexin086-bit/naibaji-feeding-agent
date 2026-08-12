import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const persistenceRoot = resolve(import.meta.dirname, "../../src/persistence");
const forbiddenImport = /(?:^node:|(?:^|[/@.])(?:container|local-db|sqlite|langgraph|langchain|react|supabase|openai|anthropic|llm|ui|legacy|optimizer|shared[\\/]local-store-contract)(?:[/.'"]|$))/i;
const importTarget = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g;
const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Return every TypeScript module below root in deterministic path order. */
function typescriptFilesUnder(root: string): string[] {
  const files: string[] = [];
  const visitedDirectories = new Set<string>();

  function visit(directory: string): void {
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return;
    const canonical = resolve(directory);
    if (visitedDirectories.has(canonical)) return;
    visitedDirectories.add(canonical);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      lexicalCompare(a.name, b.name))) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(resolve(entryPath));
      }
    }
  }

  visit(root);
  return files.sort((a, b) => lexicalCompare(relative(root, a), relative(root, b)));
}

function assertPersistenceImportsAreAllowed(root: string): void {
  for (const file of typescriptFilesUnder(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importTarget)) {
      expect(match[1], `${relative(root, file)} import`).not.toMatch(forbiddenImport);
    }
  }
}

describe("persistence architecture boundary", () => {
  it("recursively scans every persistence module and keeps adapters independent", () => {
    const files = typescriptFilesUnder(persistenceRoot);
    expect(files.map((file) => relative(persistenceRoot, file))).toEqual([
      "contracts.ts",
      "index.ts",
      "observation-codec.ts",
      "sqlite-observation-repository.ts",
    ]);
    assertPersistenceImportsAreAllowed(persistenceRoot);
  });

  it("rejects forbidden ESM, dynamic, and CommonJS imports in a nested fixture", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "naibaji-persistence-boundary-"));
    try {
      const nested = join(fixtureRoot, "nested", "deeper");
      mkdirSync(nested, { recursive: true });
      const forbiddenFile = join(nested, "forbidden.ts");
      writeFileSync(forbiddenFile, 'import type { Server } from "../../../../container/server.js";\n');
      expect(typescriptFilesUnder(fixtureRoot).map((file) => relative(fixtureRoot, file).replaceAll("\\", "/"))).toEqual([
        "nested/deeper/forbidden.ts",
      ]);
      for (const source of [
        'import type { Server } from "../../../../container/server.js";\n',
        'const sqlite = await import("node:sqlite");\n',
        'const supabase = require("@supabase/supabase-js");\n',
      ]) {
        writeFileSync(forbiddenFile, source);
        expect(() => assertPersistenceImportsAreAllowed(fixtureRoot)).toThrow(/forbidden\.ts/);
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
