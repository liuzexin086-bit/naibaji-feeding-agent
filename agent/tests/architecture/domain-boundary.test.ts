import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const domainRoot = resolve(import.meta.dirname, "../../src/domain");
const forbidden = /(?:from\s+["'](?:node:|[^"']*(?:container|local-db|sqlite|persistence|langgraph|langchain|react|supabase|openai|anthropic|llm|ui|legacy|optimizer)[^"']*)["']|import\s*\(\s*["'](?:node:|[^"']*(?:container|local-db|sqlite|persistence|langgraph|langchain|react|supabase|openai|anthropic|llm|ui|legacy|optimizer)[^"']*)["']\s*\)\))/i;

describe("domain architecture boundary", () => {
  it("keeps the Domain dependency-free from transport, persistence, UI and providers", () => {
    const files = readdirSync(domainRoot).filter((file) => file.endsWith(".ts"));
    expect(files.sort()).toEqual([
      "creep-control.ts",
      "decision.ts",
      "index.ts",
      "observation.ts",
      "operation.ts",
      "runtime-state.ts",
    ]);
    for (const file of files) {
      const source = readFileSync(resolve(domainRoot, file), "utf8");
      expect(source, file).not.toMatch(forbidden);
    }
  });
});
