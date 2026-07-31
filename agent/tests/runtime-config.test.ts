import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRuntimeAgentConfig,
  publicRuntimeAgentConfig,
  saveRuntimeAgentConfig,
  type RuntimeAgentConfig,
} from "../src/container/runtime-config.js";

const temporaryDirectories: string[] = [];

async function testEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "naibaji-agent-config-"));
  temporaryDirectories.push(directory);
  return {
    CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    AGENT_CONFIG_PATH: join(directory, "runtime-config.enc.json"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime Agent API configuration", () => {
  it("encrypts the API key at rest and decrypts the complete configuration", async () => {
    const env = await testEnvironment();
    const config: RuntimeAgentConfig = {
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1",
      apiMode: "responses",
      apiKey: "sk-ant-test-secret-value",
      updatedAt: "2026-07-31T08:00:00.000Z",
      updatedBy: "00000000-0000-0000-0000-000000000001",
    };

    await saveRuntimeAgentConfig(env, config);
    const raw = await readFile(env.AGENT_CONFIG_PATH, "utf8");

    expect(raw).not.toContain(config.apiKey);
    expect(JSON.parse(raw)).toMatchObject({ version: 1 });
    await expect(loadRuntimeAgentConfig(env)).resolves.toEqual(config);
  });

  it("never exposes the plaintext API key through the public projection", () => {
    const publicConfig = publicRuntimeAgentConfig({
      enabled: true,
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      apiMode: "responses",
      apiKey: "sk-test-12345678",
      updatedAt: "2026-07-31T08:00:00.000Z",
      updatedBy: "admin-id",
    });

    expect(publicConfig).not.toHaveProperty("apiKey");
    expect(publicConfig.hasApiKey).toBe(true);
    expect(publicConfig.apiKeyHint).toBe("sk-••••5678");
  });

  it("rejects missing or malformed encryption keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "naibaji-agent-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "runtime-config.enc.json");
    const config: RuntimeAgentConfig = {
      enabled: false,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com/v1",
      apiMode: "responses",
      apiKey: "",
      updatedAt: "2026-07-31T08:00:00.000Z",
      updatedBy: "admin-id",
    };

    await expect(
      saveRuntimeAgentConfig({ AGENT_CONFIG_PATH: path }, config),
    ).rejects.toThrow("NBJ_AGENT_CONFIG_KEY_REQUIRED");
    await expect(
      saveRuntimeAgentConfig({
        AGENT_CONFIG_PATH: path,
        CONFIG_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      }, config),
    ).rejects.toThrow("NBJ_AGENT_CONFIG_KEY_INVALID");
  });
});
