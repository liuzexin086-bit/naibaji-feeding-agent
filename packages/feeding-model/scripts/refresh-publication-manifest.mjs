#!/usr/bin/env node
/**
 * P2-6 (F05): refresh packages/feeding-model/publication-manifest.json with the
 * FULL 12-item artifact inventory (contract §8.1/§9). Each artifact carries its
 * per-item SHA-256 + disposition; the eliminated webConsumer must be ABSENT
 * (F3) - the script fails if the divergent web/lib/feeding.ts exists.
 */
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(here, "../../..");

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function sha256FileSync(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function sha256File(path) {
  return sha256FileSync(await readFile(path));
}

async function present(relativePath, disposition) {
  const abs = resolve(repoRoot, relativePath);
  if (!(await exists(abs))) {
    throw new Error("NBJ_P2_6_INVENTORY_MISSING:" + relativePath);
  }
  return { disposition, sha256: await sha256File(abs) };
}

async function main() {
  if (await exists(resolve(repoRoot, "web", "lib", "feeding.ts"))) {
    throw new Error("NBJ_P2_6_F3_PRESENT:web/lib/feeding.ts must be eliminated (contract §4.3/§8.3)");
  }
  const artifacts = {
    packageSource: await present("packages/feeding-model/src/index.ts", "authority"),
    packageDist: await present("packages/feeding-model/dist/index.js", "derived"),
    baselineOracle: await present("feeding-model.js", "parity-oracle"),
    v5ShadowSource: await present("v5lite-model.js", "shadow"),
    agentGeneratedCjs: await present("agent/.generated-models/feeding-model.cjs", "derived"),
    webGeneratedMin: await present("agent/.generated-web/feeding-model.min.js", "derived"),
    rootSyncedMin: await present("feeding-model.min.js", "derived"),
    containerCopy: await present("agent/container-models/feeding-model.cjs", "derived-pipeline-owned"),
    publicCopy: await present("agent/public/feeding-model.min.js", "derived-pipeline-owned"),
    webConsumer: { disposition: "eliminated", sha256: null },
    productionWrapper: await present("backend/src/models/feedingModel.js", "re-export"),
    optimizerSurrogate: await present("optimizer/model.py", "experimental-excluded"),
  };
  const manifest = {
    formatVersion: 1,
    packageName: "@naibaji/feeding-model",
    packageVersion: "0.1.0",
    behaviorVersion: "naibaji-v2",
    sourceSha256: await sha256File(resolve(pkgDir, "src", "index.ts")),
    baselineSha256: await sha256File(resolve(repoRoot, "feeding-model.js")),
    goldenVectorsSha256: await sha256File(resolve(pkgDir, "golden-vectors.json")),
    artifacts,
  };
  await writeFile(resolve(pkgDir, "publication-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log("publication manifest refreshed: " + Object.keys(artifacts).length + " artifacts");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
