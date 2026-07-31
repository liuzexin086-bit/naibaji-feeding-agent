import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const sourceRoot = resolve(agentRoot, "..");
const targetRoot = resolve(agentRoot, "container-models");

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, "feeding-model.js"), resolve(targetRoot, "feeding-model.cjs"));
await cp(resolve(sourceRoot, "v5lite-model.js"), resolve(targetRoot, "v5lite-model.cjs"));
