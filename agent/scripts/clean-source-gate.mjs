import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const forbidden = [
  "node_modules",
  "agent/node_modules",
  "agent/public",
  "agent/container-models",
  "agent/.generated-models",
  "agent/.generated-web",
  "agent/dist",
  "agent/data",
];

const directory = mkdtempSync(join(tmpdir(), "nbj-clean-source-"));
try {
  const archive = join(directory, "source.tar");
  const extracted = join(directory, "source");
  mkdirSync(extracted, { recursive: true });
  execFileSync("git", ["archive", "--format=tar", "-o", archive, "HEAD"], { cwd: root, stdio: "pipe" });
  execFileSync("tar", ["-xf", archive, "-C", extracted], { stdio: "pipe" });
  for (const path of forbidden) {
    if (existsSync(join(extracted, path))) {
      throw new Error(`NBJ_CLEAN_SOURCE_FORBIDDEN_ARTIFACT:${path}`);
    }
  }
  if (!existsSync(join(extracted, ".dockerignore"))) {
    throw new Error("NBJ_CLEAN_SOURCE_DOCKERIGNORE_MISSING");
  }
  if (!existsSync(join(extracted, "agent", "scripts", "write-provenance.mjs"))) {
    throw new Error("NBJ_CLEAN_SOURCE_PROVENANCE_SCRIPT_MISSING");
  }
  console.log(`clean source gate ok: ${root} HEAD=${execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
