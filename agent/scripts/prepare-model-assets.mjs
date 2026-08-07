import { access, cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const candidates = [resolve(agentRoot, ".."), agentRoot];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let sourceRoot;
for (const candidate of candidates) {
  if (
    (await exists(resolve(candidate, "feeding-model.js"))) &&
    (await exists(resolve(candidate, "v5lite-model.js")))
  ) {
    sourceRoot = candidate;
    break;
  }
}

if (!sourceRoot) {
  throw new Error("NBJ_MODEL_SOURCE_ROOT_NOT_FOUND");
}

const targetRoot = resolve(agentRoot, ".generated-models");
await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, "feeding-model.js"), resolve(targetRoot, "feeding-model.cjs"));
await cp(resolve(sourceRoot, "v5lite-model.js"), resolve(targetRoot, "v5lite-model.cjs"));
