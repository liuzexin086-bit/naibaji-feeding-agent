import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AAD = Buffer.from("naibaji-feeding-agent-runtime-config-v1", "utf8");

export const DEFAULT_RUNTIME_TIMEOUT = 15_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

const MIN_RUNTIME_TIMEOUT = 1_000;
const MAX_RUNTIME_TIMEOUT = 120_000;
const MIN_MAX_OUTPUT_TOKENS = 1;
const MAX_MAX_OUTPUT_TOKENS = 131_072;

export interface RuntimeAgentConfig {
  enabled: boolean;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiMode: "responses" | "chat_completions";
  apiKey: string;
  /** Provider request timeout in milliseconds. */
  timeout?: number;
  maxOutputTokens?: number;
  updatedAt: string;
  updatedBy: string;
}

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface RuntimeConfigEnv {
  CONFIG_ENCRYPTION_KEY?: string;
  AGENT_CONFIG_PATH?: string;
}

function configPath(env: RuntimeConfigEnv): string {
  return env.AGENT_CONFIG_PATH || "/data/runtime-config.enc.json";
}

function encryptionKey(env: RuntimeConfigEnv): Buffer {
  const encoded = env.CONFIG_ENCRYPTION_KEY;
  if (!encoded) throw new Error("NBJ_AGENT_CONFIG_KEY_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("NBJ_AGENT_CONFIG_KEY_INVALID");
  return key;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return false;
  }
  const numbers = octets.map(Number);
  return numbers.every((number) => number >= 0 && number <= 255) && numbers[0] === 127;
}

/**
 * Validates an OpenAI-compatible or first-party provider base URL.
 * Plain HTTP is intentionally limited to the local machine so a key cannot be
 * sent over an unencrypted public connection.
 */
export function validateRuntimeBaseUrl(baseUrl: string): string {
  const input = baseUrl.trim();
  if (!input || input.length > 2_048) throw new Error("NBJ_AGENT_BASE_URL_INVALID");

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("NBJ_AGENT_BASE_URL_INVALID");
  }
  if (parsed.username || parsed.password) {
    throw new Error("NBJ_AGENT_BASE_URL_CREDENTIALS_FORBIDDEN");
  }
  if (!parsed.hostname || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error("NBJ_AGENT_BASE_URL_INVALID");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("NBJ_AGENT_BASE_URL_HTTPS_REQUIRED");
  }
  if (parsed.search || parsed.hash) throw new Error("NBJ_AGENT_BASE_URL_INVALID");

  return parsed.toString().replace(/\/$/, "");
}

export function validateRuntimeAgentConfig(config: RuntimeAgentConfig): void {
  if (!config || typeof config !== "object") throw new Error("NBJ_AGENT_CONFIG_INVALID");
  if (typeof config.enabled !== "boolean") throw new Error("NBJ_AGENT_ENABLED_INVALID");
  if (config.provider !== "anthropic" && config.provider !== "openai") {
    throw new Error("NBJ_AGENT_PROVIDER_INVALID");
  }
  if (typeof config.model !== "string" || !config.model.trim() || config.model.length > 160) {
    throw new Error("NBJ_AGENT_MODEL_INVALID");
  }
  validateRuntimeBaseUrl(config.baseUrl);
  if (config.apiMode !== "responses" && config.apiMode !== "chat_completions") {
    throw new Error("NBJ_AGENT_API_MODE_INVALID");
  }
  if (
    typeof config.apiKey !== "string" ||
    config.apiKey.length > 512 ||
    /[\r\n]/.test(config.apiKey)
  ) {
    throw new Error("NBJ_AGENT_API_KEY_INVALID");
  }
  if (config.enabled && !config.apiKey) throw new Error("NBJ_AGENT_API_KEY_REQUIRED");
  if (
    config.timeout !== undefined &&
    (!Number.isInteger(config.timeout) ||
      config.timeout < MIN_RUNTIME_TIMEOUT ||
      config.timeout > MAX_RUNTIME_TIMEOUT)
  ) {
    throw new Error("NBJ_AGENT_TIMEOUT_INVALID");
  }
  if (
    config.maxOutputTokens !== undefined &&
    (!Number.isInteger(config.maxOutputTokens) ||
      config.maxOutputTokens < MIN_MAX_OUTPUT_TOKENS ||
      config.maxOutputTokens > MAX_MAX_OUTPUT_TOKENS)
  ) {
    throw new Error("NBJ_AGENT_MAX_OUTPUT_TOKENS_INVALID");
  }
}

export async function loadRuntimeAgentConfig(
  env: RuntimeConfigEnv,
): Promise<RuntimeAgentConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  if (envelope.version !== 1) throw new Error("NBJ_AGENT_CONFIG_VERSION_UNSUPPORTED");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(env),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  const config = JSON.parse(plaintext.toString("utf8")) as RuntimeAgentConfig;
  validateRuntimeAgentConfig(config);
  return config;
}

export async function saveRuntimeAgentConfig(
  env: RuntimeConfigEnv,
  config: RuntimeAgentConfig,
): Promise<void> {
  validateRuntimeAgentConfig(config);
  const path = configPath(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function publicRuntimeAgentConfig(config: RuntimeAgentConfig | null): {
  configured: boolean;
  enabled: boolean;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiMode: "responses" | "chat_completions";
  timeout: number;
  maxOutputTokens: number;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
} {
  const key = config?.apiKey || "";
  return {
    configured: config !== null,
    enabled: config?.enabled ?? false,
    provider: config?.provider ?? "anthropic",
    model: config?.model ?? "claude-sonnet-4-6",
    baseUrl: config?.baseUrl ??
      (config?.provider === "openai"
        ? "https://api.openai.com/v1"
        : "https://api.anthropic.com/v1"),
    apiMode: config?.apiMode ?? "responses",
    timeout: config?.timeout ?? DEFAULT_RUNTIME_TIMEOUT,
    maxOutputTokens: config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    hasApiKey: key.length > 0,
    apiKeyHint: key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : null,
    updatedAt: config?.updatedAt ?? null,
    updatedBy: config?.updatedBy ?? null,
  };
}
