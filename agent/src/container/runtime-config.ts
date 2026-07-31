import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AAD = Buffer.from("naibaji-feeding-agent-runtime-config-v1", "utf8");

export interface RuntimeAgentConfig {
  enabled: boolean;
  provider: "anthropic" | "openai";
  model: string;
  baseUrl: string;
  apiMode: "responses" | "chat_completions";
  apiKey: string;
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
  return JSON.parse(plaintext.toString("utf8")) as RuntimeAgentConfig;
}

export async function saveRuntimeAgentConfig(
  env: RuntimeConfigEnv,
  config: RuntimeAgentConfig,
): Promise<void> {
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
    hasApiKey: key.length > 0,
    apiKeyHint: key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : null,
    updatedAt: config?.updatedAt ?? null,
    updatedBy: config?.updatedBy ?? null,
  };
}
