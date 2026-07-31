import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const sourceRoot = resolve(agentRoot, "..");
const targetRoot = resolve(agentRoot, "public");

const files = [
  "index.html",
  "admin.html",
  "admin.js",
  "chart.umd.min.js",
  "feeding-model.min.js",
  "v5lite-model.js",
  "supabase-client.js",
];

await mkdir(targetRoot, { recursive: true });
for (const file of files) {
  await cp(resolve(sourceRoot, file), resolve(targetRoot, file));
}
