import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateWebModelArtifact } from "../scripts/prepare-web-model-assets.mjs";

const agentRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(agentRoot, "..");
const require = createRequire(import.meta.url);

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex").toUpperCase();
}

function basePlan() {
  return require(resolve(repoRoot, "feeding-model.js")).generatePlan({
    startAge: 3,
    endAge: 9,
    startWeight: 10,
    headCount: 20,
  });
}

describe("Web model derivation seal", () => {
  it("generates the same Web artifact deterministically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-web-model-deterministic-"));
    try {
      const firstPath = join(directory, "first.min.js");
      const secondPath = join(directory, "second.min.js");
      const first = await generateWebModelArtifact({
        agentRoot,
        sourceRoot: repoRoot,
        outputPath: firstPath,
      });
      const second = await generateWebModelArtifact({
        agentRoot,
        sourceRoot: repoRoot,
        outputPath: secondPath,
      });
      expect(first.artifactSha256).toBe(second.artifactSha256);
      expect(sha256File(firstPath)).toBe(first.artifactSha256);
      expect(sha256File(secondPath)).toBe(second.artifactSha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps authoritative and generated Web models behavior-identical for control safety", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nbj-web-model-parity-"));
    try {
      const webPath = join(directory, "feeding-model.min.js");
      await generateWebModelArtifact({
        agentRoot,
        sourceRoot: repoRoot,
        outputPath: webPath,
      });
      const authoritative = require(resolve(repoRoot, "feeding-model.js"));
      const generated = require(webPath);
      const plan = basePlan();

      const persisted = authoritative.computeControlPlan(plan, [], 2);
      const generatedPersisted = generated.computeControlPlan(plan, [], 2);
      expect(generatedPersisted.controlStartDay).toBe(persisted.controlStartDay);
      expect(generatedPersisted.feedTimes).toEqual(persisted.feedTimes);

      const nonMonotonicRecords = [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
      ];
      expect(() => authoritative.computeControlPlan(plan, nonMonotonicRecords, 2))
        .toThrow("NBJ_CONTROL_HISTORY_NON_MONOTONIC");
      expect(() => generated.computeControlPlan(plan, nonMonotonicRecords, 2))
        .toThrow("NBJ_CONTROL_HISTORY_NON_MONOTONIC");

      const stepRecords = [
        { dayAge: 3, creepGrade: "high", headCount: 20 },
        { dayAge: 4, creepGrade: "high", headCount: 20 },
        {
          dayAge: 5,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 10,
        },
        {
          dayAge: 6,
          creepGrade: "high",
          headCount: 20,
          planPerPigAtCommit: 300,
          planTotalAtCommit: 6000,
          feedTimesAtCommit: 8,
        },
      ];
      expect(() => authoritative.computeControlPlan(plan, stepRecords, 2))
        .toThrow("NBJ_CONTROL_HISTORY_STEP_INVALID");
      expect(() => generated.computeControlPlan(plan, stepRecords, 2))
        .toThrow("NBJ_CONTROL_HISTORY_STEP_INVALID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("synchronizes the tracked root Web model with the generated artifact", () => {
    const generated = resolve(agentRoot, ".generated-web", "feeding-model.min.js");
    const tracked = resolve(repoRoot, "feeding-model.min.js");
    expect(sha256File(generated)).toBe(sha256File(tracked));
  });
});
