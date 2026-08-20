/**
 * P2-6 F05 adversarial provenance-inventory contract (frozen §8.1/§8.4/§9):
 *  - artifactInventory is the CANONICAL CHECKPOINT IDENTITY, read verbatim from
 *    the committed publication-manifest.artifacts (permanent per-item SHA-256,
 *    independent of build context);
 *  - runtimePresence is a SEPARATE context field and must NEVER replace/overwrite
 *    identity (a missing artifact in one context does NOT null the canonical SHA);
 *  - dropping or changing one inventory SHA, or letting present:false replace a
 *    canonical identity, FAILS the validator.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProvenance, computeWebProvenance, validateInventoryArtifacts } from "../../scripts/write-provenance.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const agentRoot = resolve(repoRoot, "agent");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages", "feeding-model", "publication-manifest.json"), "utf8"));

const SHA = "a".repeat(64);
const base = Object.fromEntries(Object.keys(manifest.artifacts).map((k) => [
  k,
  k === "webConsumer"
    ? { disposition: "eliminated", sha256: null }
    : { disposition: "derived", sha256: SHA },
]));

describe("P2-6 artifactInventory is the canonical checkpoint identity (F05)", () => {
  it("computeProvenance artifactInventory equals the committed publication-manifest.artifacts verbatim", async () => {
    const agent = await computeProvenance({ commit: "provenance-test", agentRoot });
    expect(agent.artifactInventory).toEqual(manifest.artifacts);
    // F08: exercise the real Web provenance path (not a second agent call)
    const web = await computeWebProvenance({ commit: "provenance-test", agentRoot });
    expect(web.artifactInventory).toEqual(manifest.artifacts);
    expect(web.runtimePresence).toEqual(agent.runtimePresence);
  });

  it("runtimePresence is a separate context field and never replaces identity", async () => {
    const agent = await computeProvenance({ commit: "provenance-test", agentRoot });
    expect(Object.keys(agent.runtimePresence).sort()).toEqual(Object.keys(manifest.artifacts).sort());
    expect(agent.runtimePresence.webConsumer).toEqual({ present: false });
    for (const [key, entry] of Object.entries(agent.runtimePresence)) {
      if (key === "webConsumer") continue;
      if (entry.present) {
        expect(entry.sha256, key).toMatch(/^[0-9a-fA-F]{64}$/);
        // identity is untouched regardless of presence
        expect(agent.artifactInventory[key].sha256, key).toMatch(/^[0-9a-fA-F]{64}$/);
        // F08: for byte-identical present artifacts, runtime SHA == canonical identity
        expect(agent.runtimePresence[key].sha256, key).toBe(agent.artifactInventory[key].sha256);
      }
    }
  });
});

describe("P2-6 inventory validator fails closed (adversarial)", () => {
  it("drops one inventory SHA -> FAIL", () => {
    const bad = JSON.parse(JSON.stringify(base));
    delete bad.packageSource.sha256;
    expect(() => validateInventoryArtifacts(bad)).toThrow(/NBJ_P2_6_INVENTORY_NO_SHA:packageSource/);
  });

  it("changes one inventory SHA to a non-hex value -> FAIL", () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.agentGeneratedCjs.sha256 = "not-a-sha";
    expect(() => validateInventoryArtifacts(bad)).toThrow(/NBJ_P2_6_INVENTORY_NO_SHA:agentGeneratedCjs/);
  });

  it("present:false incorrectly replaces a canonical SHA (sha null) -> FAIL", () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.packageDist = { disposition: "derived", present: false, sha256: null };
    expect(() => validateInventoryArtifacts(bad)).toThrow(/NBJ_P2_6_INVENTORY_NO_SHA:packageDist/);
  });

  it("drops an inventory key entirely -> FAIL", () => {
    const bad = JSON.parse(JSON.stringify(base));
    delete bad.baselineOracle;
    expect(() => validateInventoryArtifacts(bad)).toThrow(/NBJ_P2_6_INVENTORY_MISSING_KEY:baselineOracle/);
  });

  it("webConsumer not eliminated -> FAIL", () => {
    const bad = JSON.parse(JSON.stringify(base));
    bad.webConsumer = { disposition: "parity-oracle", sha256: SHA };
    expect(() => validateInventoryArtifacts(bad)).toThrow(/NBJ_P2_6_INVENTORY_WEB_NOT_ELIMINATED:webConsumer/);
  });
});
