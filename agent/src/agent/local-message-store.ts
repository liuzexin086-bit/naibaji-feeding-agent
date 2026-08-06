import type { AgentMessageStore, StoredAgentMessage } from "./message-store.js";
import {
  LocalStoreError,
  SqliteLocalStore,
} from "../local-db/index.js";
import type { SupabaseRuntime } from "../shared/supabase-rest.js";

export type AgentStorageBackend = "local" | "supabase";

export type AgentStorageConfig =
  | { backend: "local"; localDbPath: string }
  | { backend: "supabase"; supabase: SupabaseRuntime };

export function selectAgentStorageBackend(
  value: string | undefined,
): AgentStorageBackend {
  const normalized = (value ?? "supabase").trim().toLowerCase();
  if (normalized !== "local" && normalized !== "supabase") {
    throw new Error("NBJ_AGENT_STORAGE_BACKEND_INVALID");
  }
  return normalized;
}

export function resolveAgentStorageConfig(
  env: Record<string, string | undefined>,
): AgentStorageConfig {
  const backend = selectAgentStorageBackend(env.AGENT_STORAGE_BACKEND);
  if (backend === "local") {
    const localDbPath = env.LOCAL_DB_PATH?.trim();
    if (!localDbPath) throw new Error("NBJ_LOCAL_DB_PATH_REQUIRED");
    return { backend, localDbPath };
  }
  if (!env.SUPABASE_URL) throw new Error("Missing environment variable SUPABASE_URL");
  if (!env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Missing environment variable SUPABASE_PUBLISHABLE_KEY");
  }
  return {
    backend,
    supabase: {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
    },
  };
}

export function openLocalAgentStore(filename: string): SqliteLocalStore {
  try {
    const store = new SqliteLocalStore({ filename });
    store.migrate();
    return store;
  } catch {
    throw new Error("NBJ_LOCAL_STORAGE_UNAVAILABLE");
  }
}

function localError(error: unknown): Error {
  if (error instanceof LocalStoreError) {
    const code = error.code.replace(/^LOCAL_STORE_/, "");
    return new Error(`NBJ_LOCAL_STORAGE_${code}`);
  }
  if (error instanceof Error && error.message.startsWith("NBJ_")) return error;
  return new Error("NBJ_LOCAL_STORAGE_UNAVAILABLE");
}

function storedMessage(
  row: ReturnType<SqliteLocalStore["listMessages"]>[number],
): StoredAgentMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    evidence: row.evidence,
    created_at: row.createdAt,
  };
}

export function requireLocalAgentSession(input: {
  store: SqliteLocalStore;
  userId: string;
  batchId: string;
  sessionId: string;
}): void {
  try {
    const session = input.store.getSession(
      input.userId,
      input.batchId,
      input.sessionId,
    );
    if (!session || session.status !== "active") {
      throw new Error("NBJ_AGENT_SESSION_NOT_FOUND");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "NBJ_AGENT_SESSION_NOT_FOUND") {
      throw error;
    }
    throw localError(error);
  }
}

export function createLocalAgentMessageStore(input: {
  store: SqliteLocalStore;
  userId: string;
  batchId: string;
}): AgentMessageStore {
  const { store, userId, batchId } = input;
  const messages = (sessionId: string) =>
    store.listMessages(userId, batchId, sessionId, { limit: 1_000 });

  return {
    async loadHistory(sessionId, limit = 30) {
      try {
        return messages(sessionId).slice(-limit).reverse().map(storedMessage);
      } catch (error) {
        throw localError(error);
      }
    },

    async findByClientMessageId(sessionId, clientMessageId) {
      try {
        return store.findMessagesByClientMessageId(
          userId,
          batchId,
          sessionId,
          clientMessageId,
        )
          .map(storedMessage);
      } catch (error) {
        throw localError(error);
      }
    },

    async findAssistantById(sessionId, messageId) {
      try {
        const row = messages(sessionId).find((message) =>
          message.id === messageId && message.role === "assistant");
        return row ? storedMessage(row) : null;
      } catch (error) {
        throw localError(error);
      }
    },

    async findByResponseMessageId(sessionId, messageId) {
      try {
        return store.findMessagesByResponseMessageId(
          userId,
          batchId,
          sessionId,
          messageId,
        )
          .map(storedMessage);
      } catch (error) {
        throw localError(error);
      }
    },

    async append(message) {
      if (message.userId !== userId) {
        throw new Error("NBJ_LOCAL_STORAGE_USER_MISMATCH");
      }
      try {
        store.appendMessage({
          id: message.id,
          userId,
          batchId,
          sessionId: message.sessionId,
          role: message.role,
          content: message.content,
          evidence: message.evidence,
        });
      } catch (error) {
        throw localError(error);
      }
    },
  };
}
