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

// EOL-invariant canonical hash (LF-normalized) so provenance values match the
// committed publication-manifest on any checkout (git eol=lf vs core.autocrlf).
async function sha256InventoryFile(path) {
  const text = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
  return sha256Text(text).toLowerCase();
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

// Full 12-item inventory keys (contract §3.5).
const INVENTORY_KEYS = [
  "packageSource", "packageDist", "baselineOracle", "v5ShadowSource",
  "agentGeneratedCjs", "webGeneratedMin", "rootSyncedMin",
  "containerCopy", "publicCopy", "webConsumer", "productionWrapper", "optimizerSurrogate",
];

// F05 (contract §8.1/§8.4/§9): validate a canonical artifact-inventory object.
// Every non-eliminated item MUST carry a 64-hex per-item SHA-256 identity;
// presence flags may NOT replace identity; webConsumer must be eliminated.
export function validateInventoryArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    throw new Error("NBJ_P2_6_INVENTORY_EMPTY");
  }
  for (const key of INVENTORY_KEYS) {
    const entry = artifacts[key];
    if (!entry || typeof entry.disposition !== "string") {
      throw new Error("NBJ_P2_6_INVENTORY_MISSING_KEY:" + key);
    }
    if (key === "webConsumer") {
      if (entry.disposition !== "eliminated") {
        throw new Error("NBJ_P2_6_INVENTORY_WEB_NOT_ELIMINATED:" + key);
      }
      continue;
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(entry.sha256)) {
      throw new Error("NBJ_P2_6_INVENTORY_NO_SHA:" + key);
    }
  }
  return true;
}

// F05.2: artifactInventory is the CANONICAL CHECKPOINT IDENTITY taken verbatim
// from the committed publication-manifest.artifacts (permanent per-item
// SHA-256; webConsumer eliminated). It is independent of build context.
async function canonicalArtifactInventory(sourceRoot) {
  const manifestPath = resolve(sourceRoot, "packages", "feeding-model", "publication-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("NBJ_P2_6_MANIFEST_UNREADABLE:" + String(error && error.message || error));
  }
  if (!manifest.artifacts) {
    throw new Error("NBJ_P2_6_MANIFEST_ARTIFACTS_MISSING");
  }
  validateInventoryArtifacts(manifest.artifacts);
  return manifest.artifacts;
}

// F05.1: runtimePresence is a SEPARATE field describing which artifacts exist
// in THIS context (repo checkout vs production Docker image). In the Docker
// build stage agentRoot is /app (agent payload root) and the agent artifacts
// live directly under it, while repo-only items (root parity oracle, backend
// wrapper, optimizer) are legitimately absent. Presence never replaces
// identity (artifactInventory).
async function buildRuntimePresence(agentRoot, sourceRoot) {
  const resolvePath = (key) => {
    switch (key) {
      case "packageSource": return resolve(sourceRoot, "packages", "feeding-model", "src", "index.ts");
      case "packageDist": return resolve(sourceRoot, "packages", "feeding-model", "dist", "index.js");
      case "baselineOracle": return resolve(sourceRoot, "feeding-model.js");
      case "v5ShadowSource": return resolve(sourceRoot, "v5lite-model.js");
      case "agentGeneratedCjs": return resolve(agentRoot, ".generated-models", "feeding-model.cjs");
      case "webGeneratedMin": return resolve(agentRoot, ".generated-web", "feeding-model.min.js");
      case "rootSyncedMin": return resolve(sourceRoot, "feeding-model.min.js");
      case "containerCopy": return resolve(agentRoot, "container-models", "feeding-model.cjs");
      case "publicCopy": return resolve(agentRoot, "public", "feeding-model.min.js");
      case "productionWrapper": return resolve(sourceRoot, "backend", "src", "models", "feedingModel.js");
      case "optimizerSurrogate": return resolve(sourceRoot, "optimizer", "model.py");
      default: return null;
    }
  };
  const presence = {};
  for (const key of INVENTORY_KEYS) {
    if (key === "webConsumer") { presence[key] = { present: false }; continue; }
    const p = resolvePath(key);
    if (p && (await exists(p))) {
      presence[key] = { present: true, sha256: await sha256InventoryFile(p) };
    } else {
      presence[key] = { present: false, sha256: null };
    }
  }
  return presence;
}

async function extractConstant(file, pattern, name) {
  const source = await readFile(file, "utf8");
  const match = pattern.exec(source);
  if (!match) throw new Error("NBJ_PROVENANCE_" + name + "_MISSING");
  return match[1];
}

export async function computeProvenance({
  commit = "unknown",
  agentRoot = DEFAULT_AGENT_ROOT,
  sourceRoot,
} = {}) {
  const resolvedSourceRoot = sourceRoot ?? await resolveSourceRoot(agentRoot);
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
  if (await exists(resolve(resolvedSourceRoot, "web", "lib", "feeding.ts"))) {
    throw new Error(
      "NBJ_P2_6_F3_PRESENT:web/lib/feeding.ts must be eliminated " +
      "(frozen contract §4.3/§8.3); no pre-approved Expected Delta exists.",
    );
  }
  const artifactInventory = await canonicalArtifactInventory(resolvedSourceRoot);
  const runtimePresence = await buildRuntimePresence(agentRoot, resolvedSourceRoot);
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
    runtimePresence,
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
    runtimePresence: agentProvenance.runtimePresence,
  };
}

async function main() {
  const commit = process.argv[2] ?? "unknown";
  const agentProvenance = await computeProvenance({ commit });
  const webProvenance = await computeWebProvenance({ commit });
  await writeFile(
    resolve(DEFAULT_AGENT_ROOT, "agent-provenance.json"),
    JSON.stringify(agentProvenance, null, 2) + "\n",
  );
  await writeFile(
    resolve(DEFAULT_AGENT_ROOT, "web-provenance.json"),
    JSON.stringify(webProvenance, null, 2) + "\n",
  );
  console.log("provenance ok commit=" + commit);
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
