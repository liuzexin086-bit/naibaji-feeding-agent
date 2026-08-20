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

// P2-6 single-source (nbj-arch-p2-6-contract.md §5.2/§6.2): ALL production
// feeding artifacts are derived ONE-WAY from the packages/feeding-model
// publication authority, never from the root parity oracle. The feeding
// artifact below is a byte-copy of the package compiled dist; the root
// feeding-model.js serves only as the migration parity oracle (§4.1) and is no
// longer a production dependency. v5lite-model.cjs stays a shadow-only copy of
// the root v5lite-model.js baseline (frozen Authority Map row 57).
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

// P2-6 package authority: dist/index.js is the compiled single TS authority
// (package.json "main"). This must exist before prepare runs (t1 build).
const packageDist = resolve(sourceRoot, "packages", "feeding-model", "dist", "index.js");
if (!(await exists(packageDist))) {
  throw new Error("NBJ_PACKAGE_AUTHORITY_DIST_NOT_FOUND");
}

const targetRoot = resolve(agentRoot, ".generated-models");
await mkdir(targetRoot, { recursive: true });
// Feeding artifact is derived byte-equal from the package authority.
await cp(packageDist, resolve(targetRoot, "feeding-model.cjs"));
// v5lite-model.cjs stays from the root shadow baseline (unchanged).
await cp(resolve(sourceRoot, "v5lite-model.js"), resolve(targetRoot, "v5lite-model.cjs"));
