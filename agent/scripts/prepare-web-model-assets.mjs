import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minify } from "terser";

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

async function resolveSourceRoot(agentRoot) {
  const candidates = [agentRoot, resolve(agentRoot, "..")];
  for (const candidate of candidates) {
    if (await exists(resolve(candidate, "feeding-model.js"))) {
      return candidate;
    }
  }
  throw new Error("NBJ_MODEL_SOURCE_ROOT_NOT_FOUND");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();
}

// P2-6 single-source (nbj-arch-p2-6-contract.md §5.2/§6.2): the Web min
// artifact is derived ONE-WAY from the packages/feeding-model publication
// authority (dist/index.js), never from the root parity oracle feeding-model.js.
// syncRoot still writes the tracked root feeding-model.min.js, which becomes the
// synced copy of the generated Web artifact. Behavior stays parity-identical
// because the package port is byte/behavior-equal to the baseline (golden-vector
// parity, contract §8.2).
export async function generateWebModelArtifact({
  agentRoot = DEFAULT_AGENT_ROOT,
  sourceRoot,
  outputPath,
  syncRoot = false,
} = {}) {
  const resolvedSourceRoot = sourceRoot ?? await resolveSourceRoot(agentRoot);
  // Source of truth for the Web artifact is the package compiled authority.
  const packageDist = resolve(resolvedSourceRoot, "packages", "feeding-model", "dist", "index.js");
  if (!(await exists(packageDist))) {
    throw new Error("NBJ_PACKAGE_AUTHORITY_DIST_NOT_FOUND");
  }
  const source = (await readFile(packageDist, "utf8")).replace(/\r\n/g, "\n");
  const result = await minify(source, {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  if (!result.code) throw new Error("NBJ_WEB_MODEL_MINIFY_FAILED");
  const code = result.code.replace(/\r\n/g, "\n");
  const resolvedOutput = outputPath ?? resolve(agentRoot, ".generated-web", "feeding-model.min.js");
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, code, "utf8");
  if (syncRoot) {
    // Tracked root feeding-model.min.js is the synced copy of the Web artifact.
    await writeFile(resolve(resolvedSourceRoot, "feeding-model.min.js"), code, "utf8");
  }
  return {
    code,
    outputPath: resolvedOutput,
    sourceSha256: sha256Text(source),
    artifactSha256: sha256Text(code),
  };
}

async function main() {
  const syncRoot = process.argv.includes("--root");
  const agentRoot = DEFAULT_AGENT_ROOT;
  const sourceRoot = await resolveSourceRoot(agentRoot);
  const result = await generateWebModelArtifact({
    agentRoot,
    sourceRoot,
    syncRoot,
  });
  console.log("web model artifact ok sha256=" + result.artifactSha256);
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
