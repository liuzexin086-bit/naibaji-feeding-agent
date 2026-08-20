/**
 * P2-6 adversarial architecture tests (contract §4.3/§6.2, findings F04/F06):
 *  1. Production preparation/provenance discovery must NOT require the root
 *     feeding-model.js parity oracle (F06) - only the packages/feeding-model
 *     authority and the v5lite-model.js shadow baseline may locate the repo.
 *  2. The production Dockerfile must NOT COPY feeding-model.js (F06).
 *  3. F1/F2 pipeline-owned derived artifacts must exist and equal the single
 *     source (container-models/feeding-model.cjs == generated cjs,
 *     agent/public/feeding-model.min.js == generated web min) (F04).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const agentRoot = resolve(repoRoot, "agent");

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), "utf8");
}

describe("P2-6 production build does not depend on the root parity oracle (F06)", () => {
  it("preparation/provenance scripts locate the repo via the package authority, not root feeding-model.js", () => {
    for (const rel of [
      "agent/scripts/prepare-model-assets.mjs",
      "agent/scripts/prepare-web-model-assets.mjs",
      "agent/scripts/write-provenance.mjs",
    ]) {
      const src = read(rel);
      // discovery may reference root v5lite-model.js (shadow) but never root
      // feeding-model.js (parity oracle) as a required locator
      expect(
        src,
        rel + " must not gate source-root discovery on root feeding-model.js",
      ).not.toMatch(
        /exists\s*\(\s*resolve\s*\(\s*candidate\s*,\s*["']feeding-model\.js["']/
      );
    }
  });

  it("Dockerfile must not COPY the root feeding-model.js parity oracle", () => {
    const dockerfile = read("agent/Dockerfile");
    expect(dockerfile).not.toContain("COPY feeding-model.js");
    expect(dockerfile).toContain("COPY packages/feeding-model packages/feeding-model");
  });
});

describe("P2-6 F1/F2 are pipeline-owned derived artifacts (F04)", () => {
  it("container-models/feeding-model.cjs exists and equals .generated-models/feeding-model.cjs", () => {
    const container = resolve(agentRoot, "container-models", "feeding-model.cjs");
    const generated = resolve(agentRoot, ".generated-models", "feeding-model.cjs");
    expect(existsSync(container)).toBe(true);
    expect(existsSync(generated)).toBe(true);
    expect(readFileSync(container)).toEqual(readFileSync(generated));
  });

  it("agent/public/feeding-model.min.js exists and equals .generated-web/feeding-model.min.js", () => {
    const publicMin = resolve(agentRoot, "public", "feeding-model.min.js");
    const generatedWeb = resolve(agentRoot, ".generated-web", "feeding-model.min.js");
    expect(existsSync(publicMin)).toBe(true);
    expect(existsSync(generatedWeb)).toBe(true);
    expect(readFileSync(publicMin)).toEqual(readFileSync(generatedWeb));
  });
});
