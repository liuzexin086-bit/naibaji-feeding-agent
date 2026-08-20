import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENT_ROOT = resolve(here, "..");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();
}

async function sha256File(path) {
  return sha256Text(await readFile(path, "utf8"));
}

// F06: production discovery locates the PACKAGE authority (src/index.ts) plus
// the V5-Lite shadow baseline; the root feeding-model.js parity oracle must
// NOT be a production build/provenance dependency (contract §4.1/§6.2).
async function resolveSourceRoot(agentRoot) {
  const candidates = [agentRoot, resolve(agentRoot, "..")];
  for (const candidate of candidates) {
    if (
      (await exists(resolve(candidate, "packages", "feeding-model", "src", "index.ts"))) &&
      (await exists(resolve(candidate, "v5lite-model.js")))
    ) {
      return candidate;
    }
  }
  throw new Error("NBJ_MODEL_SOURCE_ROOT_NOT_FOUND");
}

// F05 (contract §8.1/§9): machine-verifiable FULL 12-item artifact inventory.
// Every item in contract §3.5 carries its own SHA-256 identity + disposition.
// webConsumer must be ELIMINATED (F3): the provenance pipeline fails if the
// divergent gitignored web/lib/feeding.ts reappears on disk (no pre-approved
// Expected Delta exists).
async function buildArtifactInventory(repoRoot) {
  const present = async (relativePath, disposition) => {
    const abs = resolve(repoRoot, relativePath);
    if (!(await exists(abs))) {
      throw new Error("NBJ_P2_6_INVENTORY_MISSING:" + relativePath);
    }
    return { disposition, sha256: await sha256File(abs) };
  };
  if (await exists(resolve(repoRoot, "web", "lib", "feeding.ts"))) {
    throw new Error(
      "NBJ_P2_6_F3_PRESENT:web/lib/feeding.ts must be eliminated " +
      "(frozen contract §4.3/§8.3); no pre-approved Expected Delta exists.",
    );
  }
  return {
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
}

async function extractConstant(file, pattern, name) {
  const source = await readFile(file, "utf8");
  const match = pattern.exec(source);
  if (!match) throw new Error(`NBJ_PROVENANCE_${name}_MISSING`);
  return match[1];
}

export async function computeProvenance({
  commit = "unknown",
  agentRoot = DEFAULT_AGENT_ROOT,
  sourceRoot,
} = {}) {
  const resolvedSourceRoot = sourceRoot ?? await resolveSourceRoot(agentRoot);
  // P2-6 single source: the source authority is packages/feeding-model/src/index.ts
  // (the single TS authority per contract §5.2/§6.2); the root feeding-model.js is
  // only the migration parity oracle and is not the provenance source identity.
  const packageSource = resolve(resolvedSourceRoot, "packages", "feeding-model", "src", "index.ts");
  if (!(await exists(packageSource))) {
    throw new Error("NBJ_PACKAGE_AUTHORITY_SOURCE_NOT_FOUND");
  }
  const feedingModelSourceSha256 = await sha256File(packageSource);
  const v5LiteModelSourceSha256 = await sha256File(resolve(resolvedSourceRoot, "v5lite-model.js"));
  const feedingModelArtifactSha256 = await sha256File(resolve(agentRoot, ".generated-models", "feeding-model.cjs"));
  const v5LiteModelArtifactSha256 = await sha256File(resolve(agentRoot, ".generated-models", "v5lite-model.cjs"));
  const uiSha256 = await sha256File(resolve(agentRoot, "ui", "liquid-index.html"));
  const schemaVersion = Number(await extractConstant(
    resolve(agentRoot, "..", "packages", "persistence", "migrations", "schema.js"),
    /export const MIGRATION_VERSION\s*=\s*(\d+)/u,
    "SCHEMA_VERSION",
  ));
  const decisionPolicyVersion = await extractConstant(
    resolve(agentRoot, "src", "shared", "agent-v2-contract.ts"),
    /export const DECISION_POLICY_VERSION\s*=\s*"([^"]+)"/u,
    "DECISION_POLICY_VERSION",
  );
  // F05: full 12-item inventory identity (contract §8.1/§9).
  const artifactInventory = await buildArtifactInventory(resolvedSourceRoot);
  return {
    commit,
    schemaVersion,
    decisionPolicyVersion,
    feedingModelSourceSha256,
    feedingModelArtifactSha256,
    v5LiteModelSourceSha256,
    v5LiteModelArtifactSha256,
    uiSha256,
    artifactInventory,
  };
}

export async function computeWebProvenance(input = {}) {
  const agentProvenance = await computeProvenance(input);
  const agentRoot = input.agentRoot ?? DEFAULT_AGENT_ROOT;
  const feedingModelArtifactSha256 = await sha256File(
    resolve(agentRoot, ".generated-web", "feeding-model.min.js"),
  );
  return {
    commit: agentProvenance.commit,
    schemaVersion: agentProvenance.schemaVersion,
    decisionPolicyVersion: agentProvenance.decisionPolicyVersion,
    feedingModelSourceSha256: agentProvenance.feedingModelSourceSha256,
    feedingModelArtifactSha256,
    uiSha256: agentProvenance.uiSha256,
    artifactInventory: agentProvenance.artifactInventory,
  };
}

async function main() {
  const commit = process.argv[2] ?? "unknown";
  const agentProvenance = await computeProvenance({ commit });
  const webProvenance = await computeWebProvenance({ commit });
  await writeFile(
    resolve(DEFAULT_AGENT_ROOT, "agent-provenance.json"),
    `${JSON.stringify(agentProvenance, null, 2)}\n`,
  );
  await writeFile(
    resolve(DEFAULT_AGENT_ROOT, "web-provenance.json"),
    `${JSON.stringify(webProvenance, null, 2)}\n`,
  );
  console.log(`provenance ok commit=${commit}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
