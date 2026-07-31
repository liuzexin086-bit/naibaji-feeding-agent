import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRuntimeAgentConfig,
  publicRuntimeAgentConfig,
  saveRuntimeAgentConfig,
  validateRuntimeAgentConfig,
  validateRuntimeBaseUrl,
  type RuntimeAgentConfig,
} from "../../src/container/runtime-config.js";

const temporaryDirectories: string[] = [];

function config(overrides: Partial<RuntimeAgentConfig> = {}): RuntimeAgentConfig {
  return {
    enabled: true,
    provider: "openai",
    model: "local-openai-compatible-model",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiMode: "chat_completions",
    apiKey: "local-test-key-should-never-be-logged",
    timeout: 30_000,
    maxOutputTokens: 8_192,
    updatedAt: "2026-07-31T08:00:00.000Z",
    updatedBy: "runtime-test",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime provider configuration security", () => {
  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://gateway.example/v1/", "https://gateway.example/v1"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["http://127.12.34.56:11434/v1", "http://127.12.34.56:11434/v1"],
    ["http://[::1]:11434/v1", "http://[::1]:11434/v1"],
  ])("accepts secure or loopback base URL %s", (input, expected) => {
    expect(validateRuntimeBaseUrl(input)).toBe(expected);
  });

  it.each([
    ["http://api.openai.com/v1", "NBJ_AGENT_BASE_URL_HTTPS_REQUIRED"],
    ["http://192.168.1.9:11434/v1", "NBJ_AGENT_BASE_URL_HTTPS_REQUIRED"],
    ["https://user:password@gateway.example/v1", "NBJ_AGENT_BASE_URL_CREDENTIALS_FORBIDDEN"],
    ["https://gateway.example/v1?key=secret", "NBJ_AGENT_BASE_URL_INVALID"],
    ["file:///tmp/model", "NBJ_AGENT_BASE_URL_INVALID"],
  ])("rejects unsafe base URL %s", (input, code) => {
    expect(() => validateRuntimeBaseUrl(input)).toThrow(code);
  });

  it("validates timeout and output-token bounds", () => {
    expect(() => validateRuntimeAgentConfig(config({ timeout: 999 }))).toThrow(
      "NBJ_AGENT_TIMEOUT_INVALID",
    );
    expect(() => validateRuntimeAgentConfig(config({ maxOutputTokens: 0 }))).toThrow(
      "NBJ_AGENT_MAX_OUTPUT_TOKENS_INVALID",
    );
  });

  it("encrypts all fields and exposes only a redacted key projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "naibaji-runtime-security-"));
    temporaryDirectories.push(directory);
    const env = {
      CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      AGENT_CONFIG_PATH: join(directory, "runtime-config.enc.json"),
    };
    const input = config();

    await saveRuntimeAgentConfig(env, input);
    const encrypted = await readFile(env.AGENT_CONFIG_PATH, "utf8");
    const restored = await loadRuntimeAgentConfig(env);
    const projected = publicRuntimeAgentConfig(restored);

    expect(encrypted).not.toContain(input.apiKey);
    expect(restored).toEqual(input);
    expect(JSON.stringify(projected)).not.toContain(input.apiKey);
    expect(projected).toMatchObject({
      timeout: 30_000,
      maxOutputTokens: 8_192,
      hasApiKey: true,
    });
    expect(projected).not.toHaveProperty("apiKey");
  });
});
