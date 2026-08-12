import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(agentRoot, "..");

describe("CI contract", () => {
  it("defines the Node 24.18.0 safety workflow", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github", "workflows", "agent-safety.yml"),
      "utf8",
    );
    const optimizerRequirements = readFileSync(
      resolve(repoRoot, "optimizer", "requirements.txt"),
      "utf8",
    );
    expect(workflow).toContain("node-version: 24.18.0");
    expect(workflow).toContain("uses: actions/setup-python@v5");
    expect(workflow).toContain("python-version: 3.10.9");
    expect(optimizerRequirements.trim().split(/\r?\n/)).toEqual([
      "numpy==2.2.6",
      "matplotlib==3.9.4",
    ]);
    for (const command of [
      "npm ci",
      "npm run check",
      "npm test",
      "npm run p2-1-domain-gate",
      "npm run p2-2-persistence-gate",
      "npm run p0-release-gate",
      "npm run p1-safety-gate",
      "npm run build",
      "npm run clean-source-gate",
      "python -m pip install --upgrade pip",
      "python -m pip install -r optimizer/requirements.txt",
      'python -m unittest discover -s optimizer/tests -p "test_*.py"',
      "python -m compileall -q optimizer",
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow.indexOf("python -m pip install -r optimizer/requirements.txt")).toBeLessThan(
      workflow.indexOf('python -m unittest discover -s optimizer/tests -p "test_*.py"'),
    );
    expect(workflow).toContain("docker build --target agent");
    expect(workflow).toContain("docker build --target web");
    expect(workflow).toContain("scripts/ci-runtime-check.mjs");
    expect(workflow).toContain("docker compose -f agent/docker/compose.local.yaml config --quiet");
    expect(workflow).toContain("P2-1 Domain gate");
    expect(workflow).toContain("P2-2 Persistence gate");
  });

  it("verifies runtime provenance against image files and UI markers", () => {
    const script = readFileSync(
      resolve(agentRoot, "scripts", "ci-runtime-check.mjs"),
      "utf8",
    );
    expect(script).toContain("sha256sum /app/.generated-models/feeding-model.cjs");
    expect(script).toContain("sha256sum /usr/share/nginx/html/feeding-model.min.js");
    expect(script).toContain("sha256sum /usr/share/nginx/html/index.html");
    expect(script).toContain("NBJ_CI_PROVENANCE_MISMATCH");
    expect(script).toContain('id="deviceHeading">今日执行状态');
    expect(script).toContain('id="execModeValue"');
    expect(script).toContain("今日设备设定");
  });
});
