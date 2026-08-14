import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const repoRoot = resolve(agentRoot, "..");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fetchJson(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Container may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`NBJ_CI_RUNTIME_UNAVAILABLE:${url}`);
}

function assertEqual(actual, expected, label) {
  if (String(actual ?? "").toUpperCase() !== String(expected ?? "").toUpperCase()) {
    throw new Error(`NBJ_CI_PROVENANCE_MISMATCH:${label} expected=${expected} actual=${actual}`);
  }
}

async function main() {
  const expectedCommit = process.argv[2] ?? "unknown";
  const agentImage = process.argv[3] ?? "naibaji-feeding-agent:local";
  const webImage = process.argv[4] ?? "naibaji-feeding-web:local";
  const agentName = "nbj-ci-agent";
  const webName = "nbj-ci-web";

  try {
    for (const name of [agentName, webName]) {
      try {
        docker(["rm", "-f", name]);
      } catch {
        // Container may not exist yet.
      }
    }

    docker([
      "run", "-d", "--name", agentName, "-p", "127.0.0.1:18080:8080",
      "-e", "AGENT_GATEWAY_SECRET=smoke-secret",
      "-e", "LLM_PROVIDER=openai",
      "-e", "LLM_MODEL=gpt-5",
      "-e", "LOCAL_DB_PATH=/tmp/naibaji.sqlite",
      "-e", "AGENT_CHECKPOINT_DB_PATH=/tmp/agent-checkpoints.db",
      "-e", "AGENT_CONFIG_PATH=/tmp/runtime-config.enc.json",
      agentImage,
    ]);
    const agentVersion = await fetchJson("http://127.0.0.1:18080/version");
    assertEqual(agentVersion.commit, expectedCommit, "agent.commit");
    assertEqual(agentVersion.schemaVersion, 15, "agent.schemaVersion");
    assertEqual(agentVersion.decisionPolicyVersion, "execution-contract-v1", "agent.decisionPolicyVersion");
    assertEqual(agentVersion.feedingModelSourceSha256, sha256File(resolve(repoRoot, "feeding-model.js")), "agent.feedingModelSourceSha256");
    assertEqual(agentVersion.v5LiteModelSourceSha256, sha256File(resolve(repoRoot, "v5lite-model.js")), "agent.v5LiteModelSourceSha256");

    const agentModelHash = docker([
      "exec", agentName, "sh", "-c", "sha256sum /app/.generated-models/feeding-model.cjs",
    ]).split(/\s+/)[0];
    const agentV5Hash = docker([
      "exec", agentName, "sh", "-c", "sha256sum /app/.generated-models/v5lite-model.cjs",
    ]).split(/\s+/)[0];
    assertEqual(agentVersion.feedingModelArtifactSha256, agentModelHash, "agent.feedingModelArtifactSha256");
    assertEqual(agentVersion.v5LiteModelArtifactSha256, agentV5Hash, "agent.v5LiteModelArtifactSha256");
    assertEqual(agentVersion.uiSha256, sha256File(resolve(agentRoot, "ui", "liquid-index.html")), "agent.uiSha256");

    docker([
      "run", "-d", "--name", webName, "-p", "127.0.0.1:18081:8080",
      "--add-host", "agent:127.0.0.1",
      "--entrypoint", "sh", webImage,
      "-c",
      "mkdir -p /run/secrets && printf 'smoke-secret' > /run/secrets/agent_gateway_secret && exec /usr/local/bin/nginx-entrypoint nginx -g 'daemon off;'",
    ]);
    const webVersion = await fetchJson("http://127.0.0.1:18081/version");
    assertEqual(webVersion.commit, expectedCommit, "web.commit");
    assertEqual(webVersion.feedingModelSourceSha256, sha256File(resolve(repoRoot, "feeding-model.js")), "web.feedingModelSourceSha256");

    const webModelHash = docker([
      "exec", webName, "sh", "-c", "sha256sum /usr/share/nginx/html/feeding-model.min.js",
    ]).split(/\s+/)[0];
    const webUiHash = docker([
      "exec", webName, "sh", "-c", "sha256sum /usr/share/nginx/html/index.html",
    ]).split(/\s+/)[0];
    assertEqual(webVersion.feedingModelArtifactSha256, webModelHash, "web.feedingModelArtifactSha256");
    assertEqual(webVersion.uiSha256, webUiHash, "web.uiSha256");
    assertEqual(webVersion.uiSha256, sha256File(resolve(agentRoot, "ui", "liquid-index.html")), "web.uiSha256.source");

    const response = await fetch("http://127.0.0.1:18081/");
    const html = await response.text();
    if (
      !html.includes('id="deviceHeading">今日执行状态') ||
      !html.includes('id="execModeValue"')
    ) {
      throw new Error("NBJ_CI_UI_NEW_MARKERS_MISSING");
    }
    for (const oldMarker of ["今日设备设定", "建议单日下粉总量", "今日执行："]) {
      if (html.includes(oldMarker)) {
        throw new Error(`NBJ_CI_UI_OLD_MARKER_PRESENT:${oldMarker}`);
      }
    }

    console.log(`ci runtime provenance ok commit=${expectedCommit}`);
  } finally {
    for (const name of [agentName, webName]) {
      try {
        docker(["rm", "-f", name]);
      } catch {
        // Cleanup best effort.
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
