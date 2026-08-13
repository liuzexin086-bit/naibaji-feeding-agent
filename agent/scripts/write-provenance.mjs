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

async function resolveSourceRoot(agentRoot) {
  const candidates = [agentRoot, resolve(agentRoot, "..")];
  for (const candidate of candidates) {
    if (
      (await exists(resolve(candidate, "feeding-model.js"))) &&
      (await exists(resolve(candidate, "v5lite-model.js")))
    ) {
      return candidate;
    }
  }
  throw new Error("NBJ_MODEL_SOURCE_ROOT_NOT_FOUND");
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
  const feedingModelSourceSha256 = await sha256File(resolve(resolvedSourceRoot, "feeding-model.js"));
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
  return {
    commit,
    schemaVersion,
    decisionPolicyVersion,
    feedingModelSourceSha256,
    feedingModelArtifactSha256,
    v5LiteModelSourceSha256,
    v5LiteModelArtifactSha256,
    uiSha256,
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
