import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeProvenance,
  computeWebProvenance,
} from "../scripts/write-provenance.mjs";

const agentRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(agentRoot, "..");

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8"), "utf8").digest("hex").toUpperCase();
}

describe("build provenance contract", () => {
  it("returns source and generated artifact SHAs for agent and web", async () => {
    const agent = await computeProvenance({ commit: "provenance-test", agentRoot });
    expect(agent).toMatchObject({
      commit: "provenance-test",
      schemaVersion: 14,
      decisionPolicyVersion: "execution-contract-v1",
    });
    expect(agent.feedingModelSourceSha256).toBe(sha256File(resolve(repoRoot, "feeding-model.js")));
    expect(agent.v5LiteModelSourceSha256).toBe(sha256File(resolve(repoRoot, "v5lite-model.js")));
    expect(agent.feedingModelArtifactSha256).toBe(sha256File(resolve(agentRoot, ".generated-models", "feeding-model.cjs")));
    expect(agent.v5LiteModelArtifactSha256).toBe(sha256File(resolve(agentRoot, ".generated-models", "v5lite-model.cjs")));
    expect(agent.uiSha256).toBe(sha256File(resolve(agentRoot, "ui", "liquid-index.html")));

    const web = await computeWebProvenance({ commit: "provenance-test", agentRoot });
    expect(web.commit).toBe("provenance-test");
    expect(web.schemaVersion).toBe(14);
    expect(web.decisionPolicyVersion).toBe("execution-contract-v1");
    expect(web.feedingModelSourceSha256).toBe(agent.feedingModelSourceSha256);
    expect(web.feedingModelArtifactSha256).toBe(
      sha256File(resolve(agentRoot, ".generated-web", "feeding-model.min.js")),
    );
    expect(web.uiSha256).toBe(agent.uiSha256);
  });

  it("wires provenance files, dockerignore, and /version endpoints", () => {
    expect(existsSync(resolve(repoRoot, ".dockerignore"))).toBe(true);
    const dockerignore = readFileSync(resolve(repoRoot, ".dockerignore"), "utf8");
    for (const entry of [
      ".git",
      "**/.env*",
      "**/node_modules",
      "agent/public",
      "agent/container-models",
      "agent/.generated-models",
      "agent/.generated-web",
      "*.db",
      "*.sqlite*",
    ]) {
      expect(dockerignore).toContain(entry);
    }

    const dockerfile = readFileSync(resolve(repoRoot, "agent", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY agent/ui ./ui");
    expect(dockerfile).toContain("COPY feeding-model.js v5lite-model.js ./");
    expect(dockerfile).not.toContain("COPY feeding-model.js v5lite-model.js feeding-model.min.js ./");
    expect(dockerfile).toContain("COPY --from=build /app/.generated-web/feeding-model.min.js /tmp/naibaji-assets/feeding-model.min.js");
    expect(dockerfile).not.toContain("COPY admin.html admin.js chart.umd.min.js feeding-model.min.js");
    expect(dockerfile).toContain('RUN node scripts/write-provenance.mjs "$GIT_COMMIT"');
    expect(dockerfile).toContain("COPY --from=build /app/agent-provenance.json ./agent-provenance.json");
    expect(dockerfile).toContain("COPY --from=build /app/web-provenance.json /usr/share/nginx/html/version.json");

    const nginx = readFileSync(resolve(repoRoot, "agent", "docker", "nginx.conf.template"), "utf8");
    expect(nginx).toContain("location = /version");
    expect(nginx).toContain("try_files /version.json =404;");

    const server = readFileSync(resolve(repoRoot, "agent", "src", "container", "server.ts"), "utf8");
    expect(server).toContain('/app/agent-provenance.json');
  });
});
