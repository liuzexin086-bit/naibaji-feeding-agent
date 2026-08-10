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

export async function generateWebModelArtifact({
  agentRoot = DEFAULT_AGENT_ROOT,
  sourceRoot,
  outputPath,
  syncRoot = false,
} = {}) {
  const resolvedSourceRoot = sourceRoot ?? await resolveSourceRoot(agentRoot);
  const source = (await readFile(resolve(resolvedSourceRoot, "feeding-model.js"), "utf8"))
    .replace(/\r\n/g, "\n");
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
  console.log(`web model artifact ok sha256=${result.artifactSha256}`);
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
