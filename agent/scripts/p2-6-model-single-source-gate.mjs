#!/usr/bin/env node
/**
 * P2-6 Feeding Model Single Source gate
 * ======================================
 * Assert the P2-6 single-source invariants (nbj-arch-p2-6-contract.md §7):
 *   (a) no duplicate feeding-model-logic files outside the frozen whitelist
 *   (b) derived artifacts are byte-equivalent to the package authority dist
 *   (c) package dist is byte-reproducible from source via tsc
 *   (d) provenance SHAs reproduce (write-provenance.mjs)
 *   (e) the optimizer surrogate is absent from production runtime imports
 *   (f) F1/F2/F3 on-disk divergences are resolved (byte-equal / no MEALS>10)
 *   (g) golden vectors >= 100 and publication-manifest hashes match
 *
 * Exits non-zero on any failure and prints NBJ_P2_6_GATE_FAIL:<check>.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const repoRoot = resolve(agentRoot, "..");
const require = createRequire(import.meta.url);

function gitLsFiles() {
  return execFileSync(
    "git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" },
  ).split(/\r?\n/).filter((l) => l.trim().length > 0);
}

const GEN_MODELS = resolve(agentRoot, ".generated-models");
const GEN_WEB = resolve(agentRoot, ".generated-web");
const PKG_DIR = resolve(repoRoot, "packages", "feeding-model");
const PKG_SRC = resolve(PKG_DIR, "src", "index.ts");
const PKG_DIST = resolve(PKG_DIR, "dist", "index.js");
const PKG_GOLDEN = resolve(PKG_DIR, "golden-vectors.json");
const PKG_MANIFEST = resolve(PKG_DIR, "publication-manifest.json");
const ROOT_MIN = resolve(repoRoot, "feeding-model.min.js");
const ROOT_FEEDING = resolve(repoRoot, "feeding-model.js");
const ROOT_V5 = resolve(repoRoot, "v5lite-model.js");

const failures = [];

function fail(check, detail) {
  const message = `NBJ_P2_6_GATE_FAIL:${check}${detail ? ":" + detail : ""}`;
  failures.push(message);
  console.error(message);
}

function sha256Bytes(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function sha256Text(path) {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").toUpperCase();
}

function exists(p) { return existsSync(p); }

function cleanTmpBase() {
  const t = String(process.env.TMPDIR || process.env.TMP || process.env.TEMP || tmpdir())
    .replace(/[\r\n\t]/g, "");
  if (t && t.length > 1) return t;
  const fallback = resolve(repoRoot, ".dsh", "gate-tmp");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

function makeTemp(prefix) {
  return mkdtempSync(join(cleanTmpBase(), prefix));
}

// ── (a) NO-DUPLICATION (captain disposition): logic-definition + constant drift ──
// Frozen DEFINE allowlist — the single authority + its src/schema/dist, the
// baseline parity oracle feeding-model.js, the V5-Lite shadow source, the pure
// backend re-export wrappers, the distinct research model feeding-model-simple.js,
// and the experimental optimizer surrogate. feeding-model.min.js is the tracked
// derived Web artifact (byte-equal to the regenerated package min, check b.ii) —
// it is the single source's derived form, not a duplicate implementation.
const PROTECTED_FUNCS = [
  "computeControlPlan", "generatePlan", "milkToGain", "getDailyCapacity",
  "getRampFactor", "computeDailyStats", "exportTrainingData", "createFeedingBatch",
];
const PROTECTED_CONSTS = [
  "CREEP_GRADE_VALUES", "WEIGHT_STANDARD", "CREEP_GRADE_ORDER", "CREEP_MEAL_FLOORS", "INTERNAL",
];

// (a1) DEFINE allowlist (repo-relative paths).
function isDefinePath(rel) {
  if (rel === "packages/feeding-model/src/index.ts") return true;
  if (rel === "packages/feeding-model/src/schema.ts") return true;
  if (rel.startsWith("packages/feeding-model/dist/")) return true;
  if (rel === "feeding-model.js") return true;       // baseline parity oracle
  if (rel === "v5lite-model.js") return true;        // V5-Lite shadow baseline
  if (rel === "feeding-model.min.js") return true;   // derived web artifact (single source)
  if (rel === "backend/src/models/feedingModel.js") return true;  // re-export
  if (rel === "backend/src/models/v5liteModel.js") return true;   // re-export
  if (rel === "feeding-model-simple.js") return true; // distinct research model
  if (rel.startsWith("optimizer/")) return true;      // experimental surrogate
  return false;
}

// (a2) Reference allowlist — references/consumers/tests/docs are NEVER flagged.
const REF_ALLOW_EXACT = new Set([
  "index.html",
  "admin.html",
  "agent/src/model/production-model.ts",
  "package.json",
  "tsconfig.json",
]);
const REF_ALLOW_PREFIXES = [
  "agent/src/decision/",
  "agent/tests/",
  "docs/",
  "backend/src/services/",
  "agent/ui/",
  ".github/",
  "agent/scripts/",
  ".generated-web/",
  "packages/feeding-model/scripts/",
  "packages/feeding-model/dist/",
];
function isReferencePath(rel) {
  if (REF_ALLOW_EXACT.has(rel)) return true;
  for (const pref of REF_ALLOW_PREFIXES) if (rel.startsWith(pref)) return true;
  if (/^packages\/[^/]+\/scripts\//.test(rel)) return true; // generation tooling
  return false;
}

// (a1) LOGIC-DEFINITION: does content DEFINE a protected function at a definition site?
function definesFunction(content, name) {
  if (
    new RegExp("(?:function\\s+|\\bexport\\s+function\\s+)" + name + "\\s*\\(").test(content)
  ) return true;
  if (new RegExp("\\b" + name + "\\s*\\([^)]*\\)\\s*\\{").test(content)) return true; // method shorthand
  if (new RegExp("\\b(?:const|let|var)\\s+" + name + "\\b[^=]*=\\s*function\\b").test(content)) return true;
  if (
    new RegExp("\\b(?:const|let|var)\\s+" + name + "\\b[^=]*=\\s*(?:async\\s*)?(?:\\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>").test(content)
  ) return true;
  return false;
}

// (a3) constant: does content DEFINE a protected constant (object/array literal)?
function definesConstant(content, name) {
  return new RegExp("(?:export\\s+)?(?:const|let|var)\\s+" + name + "\\b\\s*(=|:)").test(content);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  const sorted = {};
  for (const k of Object.keys(value).sort()) sorted[k] = value[k];
  return JSON.stringify(sorted);
}

// Quote bare object keys and drop trailing commas so a numeric object literal
// becomes JSON-parseable.
function quoteBareKeys(text) {
  return text
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,+(\s*[}\]])/g, '$1');
}

// (a1) logic-definition scan: flag tracked files that DEFINE protected model logic
// outside the frozen DEFINE allowlist (reference files never flagged).
function checkLogicDefinition() {
  const flagged = [];
  for (const rel of gitLsFiles()) {
    if (isDefinePath(rel)) continue;
    if (isReferencePath(rel)) continue;
    const abs = resolve(repoRoot, rel);
    if (!exists(abs)) continue;
    let content;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    for (const name of PROTECTED_FUNCS) {
      if (definesFunction(content, name)) { flagged.push(rel + " (" + name + ")"); break; }
    }
  }
  if (flagged.length > 0) {
    fail("a1", "duplicate model-logic function definitions outside DEFINE allowlist: " + flagged.join(", "));
  } else {
    console.log("p2-6 (a1) logic-definition scan: PASS (no duplicate function definitions)");
  }
}

// (a3) constant drift-control: a constant defined OUTSIDE the DEFINE allowlist
// must not DIVERGE from the package's exported constant. feeding-model-simple.js
// is a distinct model and excluded via the DEFINE allowlist.
function checkConstantDrift() {
  let pkg;
  try { pkg = require(PKG_DIST); } catch (e) { fail("a3", "cannot load package dist: " + (e.message || e)); return; }
  const drifting = [];
  const driftSkipped = [];
  for (const rel of gitLsFiles()) {
    if (isDefinePath(rel)) continue;
    if (isReferencePath(rel)) continue;
    const abs = resolve(repoRoot, rel);
    if (!exists(abs)) continue;
    let content;
    try { content = readFileSync(abs, "utf8"); } catch { continue; }
    for (const cname of PROTECTED_CONSTS) {
      if (!definesConstant(content, cname)) continue;
      if (pkg[cname] == null || typeof pkg[cname] !== "object") continue; // not a comparable package constant
      const re = new RegExp("(?:export\\s+)?const\\s+" + cname + "\\b[^=]*=\\s*(\\{[\\s\\S]*?\\})");
      const m = content.match(re);
      if (!m) { driftSkipped.push(rel + ":" + cname + " (cannot locate literal)"); continue; }
      let parsed;
      try { parsed = JSON.parse(quoteBareKeys(m[1])); }
      catch { driftSkipped.push(rel + ":" + cname + " (literal not parseable/verifiable)"); continue; }
      if (canonicalValue(parsed) !== canonicalValue(pkg[cname])) {
        drifting.push(rel + ":" + cname);
      }
    }
  }
  if (drifting.length > 0) {
    fail("a3", "constant divergence outside DEFINE allowlist: " + drifting.join(", "));
  } else if (driftSkipped.length > 0) {
    fail("a3", "constant defined outside DEFINE allowlist but not verifiable: " + driftSkipped.join(", "));
  } else {
    console.log("p2-6 (a3) constant drift-control: PASS (no divergence from package constants)");
  }
}

function checkNoDuplication() {
  checkLogicDefinition();
  checkConstantDrift();
}

// ── (b) DERIVATION ─────────────────────────────────────────────────────────
async function checkDerivation() {
  const genCjs = resolve(GEN_MODELS, "feeding-model.cjs");
  if (!exists(genCjs) || !exists(PKG_DIST)) {
    fail("b", "missing generated cjs or package dist");
    return;
  }
  if (readFileSync(genCjs).equals(readFileSync(PKG_DIST))) {
    console.log("p2-6 (b.i) .generated-models/feeding-model.cjs == package dist: PASS");
  } else {
    fail("b", ".generated-models/feeding-model.cjs != packages/feeding-model/dist/index.js");
  }

  const { generateWebModelArtifact } = await import(pathToFileURL(
    resolve(agentRoot, "scripts", "prepare-web-model-assets.mjs"),
  ).href);
  const tempDir = makeTemp("p26-web-");
  const tempFile = join(tempDir, "feeding-model.min.js");
  try {
    const res = await generateWebModelArtifact({
      agentRoot,
      sourceRoot: repoRoot,
      outputPath: tempFile,
    });
    const regen = readFileSync(tempFile);
    const genWeb = resolve(GEN_WEB, "feeding-model.min.js");
    const gWebOk = exists(genWeb) && readFileSync(genWeb).equals(regen);
    const rootOk = exists(ROOT_MIN) && readFileSync(ROOT_MIN).equals(regen);
    if (!gWebOk) fail("b", "regenerated web min != .generated-web/feeding-model.min.js (sha " + res.artifactSha256 + ")");
    if (!rootOk) fail("b", "regenerated web min != tracked root feeding-model.min.js (sha " + res.artifactSha256 + ")");
    if (gWebOk && rootOk) console.log("p2-6 (b.ii) web min regenerated from package dist byte-equal to generated+tracked: PASS");
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { }
  }
}

// ── (c) PACKAGE BUILD REPRODUCIBILITY ──────────────────────────────────────
function checkPackageReproducibility() {
  if (!exists(PKG_DIST)) { fail("c", "package dist missing"); return; }
  const tscBin = resolve(agentRoot, "node_modules", "typescript", "bin", "tsc");
  if (!exists(tscBin)) { fail("c", "typescript not found under agent/node_modules"); return; }
  const tempDir = makeTemp("p26-tsc-");
  try {
    execFileSync(process.execPath, [
      tscBin, "-p", resolve(PKG_DIR, "tsconfig.json"), "--outDir", tempDir,
    ], { cwd: PKG_DIR, encoding: "utf8" });
    const fresh = resolve(tempDir, "index.js");
    if (!exists(fresh)) { fail("c", "tsc produced no index.js"); return; }
    if (readFileSync(fresh).equals(readFileSync(PKG_DIST))) {
      console.log("p2-6 (c) package dist byte-reproducible from tsconfig build: PASS");
    } else {
      fail("c", "fresh tsc build != committed packages/feeding-model/dist/index.js");
    }
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { }
  }
}

// ── (d) PROVENANCE ─────────────────────────────────────────────────────────
async function checkProvenance() {
  const { computeProvenance } = await import(pathToFileURL(
    resolve(agentRoot, "scripts", "write-provenance.mjs"),
  ).href);
  const p = await computeProvenance({ commit: "local-p2-6", agentRoot, sourceRoot: repoRoot });
  const srcExp = sha256Text(PKG_SRC);
  const distExp = sha256Text(PKG_DIST);
  const genCjs = resolve(GEN_MODELS, "feeding-model.cjs");
  const artifactExp = exists(genCjs) ? sha256Text(genCjs) : null;
  const v5Exp = sha256Text(ROOT_V5);
  let ok = true;
  if (p.feedingModelSourceSha256 !== srcExp) { fail("d", "sourceSha256 mismatch"); ok = false; }
  if (p.feedingModelArtifactSha256 !== distExp) { fail("d", "artifactSha256 != package dist"); ok = false; }
  if (artifactExp != null && p.feedingModelArtifactSha256 !== artifactExp) { fail("d", "artifactSha256 != .generated-models cjs"); ok = false; }
  if (p.v5LiteModelSourceSha256 !== v5Exp) { fail("d", "v5Lite source != root v5lite-model.js"); ok = false; }
  if (ok) console.log("p2-6 (d) provenance reproduces package source/artifact SHAs: PASS");
}

// ── (e) OPTIMIZER absent from production runtime imports ───────────────────
function listFiles(dir) {
  const out = [];
  (function rec(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        // Skip vendored dependency trees: never production runtime source.
        if (ent.name === "node_modules") continue;
        rec(p);
      } else if (/\.(?:[cm]?js|[cm]?ts)$/.test(ent.name)) out.push(p);
    }
  })(dir);
  return out;
}
function checkOptimizerAbsent() {
  const scanDirs = [
    resolve(agentRoot, "src"),
    resolve(repoRoot, "backend", "src"),
    resolve(repoRoot, "web"),
  ];
  const hits = [];
  for (const dir of scanDirs) {
    if (!exists(dir)) continue;
    for (const f of listFiles(dir)) {
      const content = readFileSync(f, "utf8");
      if (/optimizer\//.test(content)) hits.push(f.replace(repoRoot + sep, ""));
    }
  }
  if (hits.length === 0) console.log("p2-6 (e) optimizer absent from agent/backend/web runtime imports: PASS");
  else fail("e", "optimizer/ import found in: " + hits.join(", "));
}

// ── (f) F1/F2/F3 lifecycle — FAIL-CLOSED (contract §4.3/§7) ───────────────
// F04: F1/F2 are PIPELINE-OWNED derived artifacts and F3 must be ELIMINATED.
// Absence or divergence of a required derived artifact, or any divergent
// feeding implementation (tracked OR on-disk, including gitignored web/),
// is a HARD FAILURE.
function checkF1F2F3() {
  // F1: container-models feeding cjs is pipeline-owned and MUST equal generated cjs
  const containerCjs = resolve(agentRoot, "container-models", "feeding-model.cjs");
  const genCjs = resolve(GEN_MODELS, "feeding-model.cjs");
  if (!exists(containerCjs)) {
    fail("f", "F1-UNRESOLVED: container-models/feeding-model.cjs MISSING (pipeline-owned; prepare-model-assets must generate it)");
  } else if (!exists(genCjs) || !readFileSync(containerCjs).equals(readFileSync(genCjs))) {
    fail("f", "F1-UNRESOLVED: container-models/feeding-model.cjs != .generated-models/feeding-model.cjs");
  } else {
    console.log("p2-6 (f.F1) container-models/feeding-model.cjs == generated cjs (pipeline-owned): PASS");
  }
  // F2: agent/public min is pipeline-owned and MUST equal generated web min
  const publicMin = resolve(agentRoot, "public", "feeding-model.min.js");
  const genWeb = resolve(GEN_WEB, "feeding-model.min.js");
  if (!exists(publicMin)) {
    fail("f", "F2-UNRESOLVED: agent/public/feeding-model.min.js MISSING (pipeline-owned; prepare-web-model-assets must generate it)");
  } else if (!exists(genWeb) || !readFileSync(publicMin).equals(readFileSync(genWeb))) {
    fail("f", "F2-UNRESOLVED: agent/public/feeding-model.min.js != .generated-web/feeding-model.min.js");
  } else {
    console.log("p2-6 (f.F2) agent/public/feeding-model.min.js == generated web min (pipeline-owned): PASS");
  }
  // F3: NO divergent feeding implementation may survive ANYWHERE (tracked or
  // on-disk gitignored web/). Contract §4.3/§8.3: eliminate or pre-approved
  // Expected Delta - a warning is NOT sufficient (F04). web/lib/feeding.ts
  // MUST be eliminated; the production Web consumer must consume the
  // package-derived artifact.
  const divergent = [];
  for (const rel of gitLsFiles()) {
    if (rel.startsWith("docs/")) continue;   // docs describe F3, not an implementation
    if (isDefinePath(rel)) continue;          // DEFINE allowlist is the authority
    const abs = resolve(repoRoot, rel);
    if (!exists(abs)) continue;
    const src = readFileSync(abs, "utf8");
    const m = src.match(/MEALS\s*=\s*(\d+)/);
    if (m && Number(m[1]) > 10) divergent.push(rel + " (MEALS=" + m[1] + ")");
  }
  const feedingTs = resolve(repoRoot, "web", "lib", "feeding.ts");
  if (exists(feedingTs)) {
    const src = readFileSync(feedingTs, "utf8");
    const m = src.match(/MEALS\s*=\s*(\d+)/);
    if (m && Number(m[1]) > 10) divergent.push("web/lib/feeding.ts (MEALS=" + m[1] + ")");
  }
  if (divergent.length > 0) {
    fail("f", "F3-UNRESOLVED: divergent feeding implementation(s): " + divergent.join(", ") + ". web/lib/feeding.ts must be eliminated (no pre-approved Expected Delta); Web must consume the package-derived artifact (contract §4.3/§8.3).");
  } else {
    console.log("p2-6 (f.F3) no divergent feeding implementation anywhere (tracked or on-disk): PASS");
  }
}

// ── (g) GOLDEN VECTORS + PUBLICATION MANIFEST ─────────────────────────────
function checkGoldenVectors() {
  if (!exists(PKG_GOLDEN)) { fail("g", "golden-vectors.json missing"); return; }
  const golden = JSON.parse(readFileSync(PKG_GOLDEN, "utf8"));
  const count = Array.isArray(golden.vectors) ? golden.vectors.length : 0;
  if (count < 100) {
    fail("g", "golden-vectors count " + count + " < 100");
  } else {
    console.log("p2-6 (g) golden-vectors count " + count + " >= 100: PASS");
  }
  if (!exists(PKG_MANIFEST)) { fail("g", "publication-manifest.json missing"); return; }
  const manifest = JSON.parse(readFileSync(PKG_MANIFEST, "utf8"));
  // EOL-invariant canonical hash (LF-normalized) so committed values match on
  // any checkout (git eol=lf vs core.autocrlf) - same canonical as
  // scripts/refresh-publication-manifest.mjs and write-provenance.mjs.
  const canon = (p) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const srcSha = canon(PKG_SRC);
  const goldenSha = canon(PKG_GOLDEN);
  const baselineSha = canon(ROOT_FEEDING);
  const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  let ok = true;
  if (!eq(manifest.sourceSha256, srcSha)) { fail("g", "manifest.sourceSha256 != src/index.ts"); ok = false; }
  if (!eq(manifest.baselineSha256, baselineSha)) { fail("g", "manifest.baselineSha256 != feeding-model.js"); ok = false; }
  if (!eq(manifest.goldenVectorsSha256, goldenSha)) { fail("g", "manifest.goldenVectorsSha256 != golden-vectors.json"); ok = false; }
  // F05: full 12-item artifact inventory must be enumerated with a valid
  // disposition and, for present artifacts, a matching per-artifact SHA-256.
  const inventoryPaths = {
    packageSource: resolve(PKG_DIR, "src", "index.ts"),
    packageDist: resolve(PKG_DIR, "dist", "index.js"),
    baselineOracle: ROOT_FEEDING,
    v5ShadowSource: ROOT_V5,
    agentGeneratedCjs: resolve(agentRoot, ".generated-models", "feeding-model.cjs"),
    webGeneratedMin: resolve(GEN_WEB, "feeding-model.min.js"),
    rootSyncedMin: ROOT_MIN,
    containerCopy: resolve(agentRoot, "container-models", "feeding-model.cjs"),
    publicCopy: resolve(agentRoot, "public", "feeding-model.min.js"),
    productionWrapper: resolve(repoRoot, "backend", "src", "models", "feedingModel.js"),
    optimizerSurrogate: resolve(repoRoot, "optimizer", "model.py"),
  };
  const expectedKeys = Object.keys(inventoryPaths).concat(["webConsumer"]);
  const manifestInv = manifest.artifacts && typeof manifest.artifacts === "object" ? manifest.artifacts : {};
  for (const key of expectedKeys) {
    const entry = manifestInv[key];
    if (!entry || typeof entry.disposition !== "string") { fail("g", "manifest.artifacts missing entry: " + key); ok = false; continue; }
    if (key === "webConsumer") {
      if (entry.disposition !== "eliminated") { fail("g", "manifest.artifacts.webConsumer must be eliminated"); ok = false; }
      continue;
    }
    const p = inventoryPaths[key];
    if (!exists(p)) { fail("g", "inventory artifact missing on disk: " + key); ok = false; continue; }
    if (!eq(entry.sha256, canon(p))) { fail("g", "manifest.artifacts." + key + " sha256 mismatch"); ok = false; }
  }
  if (ok) console.log("p2-6 (g) publication-manifest hashes + full 12-item artifact inventory match: PASS");
}

async function main() {
  console.log("P2-6 Feeding Model Single Source gate — repo " + repoRoot);
  try { checkNoDuplication(); } catch (e) { fail("a", String(e && e.message || e)); }
  try { await checkDerivation(); } catch (e) { fail("b", String(e && e.message || e)); }
  try { checkPackageReproducibility(); } catch (e) { fail("c", String(e && e.message || e)); }
  try { await checkProvenance(); } catch (e) { fail("d", String(e && e.message || e)); }
  try { checkOptimizerAbsent(); } catch (e) { fail("e", String(e && e.message || e)); }
  try { checkF1F2F3(); } catch (e) { fail("f", String(e && e.message || e)); }
  try { checkGoldenVectors(); } catch (e) { fail("g", String(e && e.message || e)); }

  if (failures.length === 0) {
    console.log("P2-6 gate PASS");
    return 0;
  }
  console.error("P2-6 gate FAIL — " + failures.length + " failure(s)");
  return 1;
}

main().then((code) => { process.exitCode = code; });
