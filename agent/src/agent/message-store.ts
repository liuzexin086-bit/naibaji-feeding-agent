import {
  supabaseInsert,
  supabaseRest,
  type SupabaseRuntime,
} from "../shared/supabase-rest.js";

export interface StoredAgentMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  evidence: Record<string, unknown>;
  created_at: string;
}

export interface AgentMessageStore {
  loadHistory(sessionId: string, limit?: number): Promise<StoredAgentMessage[]>;
  findByClientMessageId(
    sessionId: string,
    clientMessageId: string,
  ): Promise<StoredAgentMessage[]>;
  findAssistantById(
    sessionId: string,
    messageId: string,
  ): Promise<StoredAgentMessage | null>;
  findByResponseMessageId(
    sessionId: string,
    messageId: string,
  ): Promise<StoredAgentMessage[]>;
  append(input: {
    id: string;
    userId: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    evidence: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Current persistence adapter. The chat handler depends only on
 * AgentMessageStore so a local store can replace Supabase without changing
 * deterministic tools or the streaming protocol.
 */
export function createSupabaseAgentMessageStore(input: {
  env: SupabaseRuntime;
  token: string;
}): AgentMessageStore {
  const { env, token } = input;
  const select = "id,role,content,evidence,created_at";
  return {
    async loadHistory(sessionId, limit = 30) {
      const rows = await supabaseRest<StoredAgentMessage[]>(
        env,
        token,
        `/rest/v1/feeding_agent_messages?session_id=eq.${encodeURIComponent(sessionId)}&role=in.(user,assistant)&select=${select}&order=created_at.desc&limit=${limit}`,
      );
      return rows;
    },

    async findByClientMessageId(sessionId, clientMessageId) {
      return supabaseRest<StoredAgentMessage[]>(
        env,
        token,
        `/rest/v1/feeding_agent_messages?session_id=eq.${encodeURIComponent(sessionId)}&evidence->>clientMessageId=eq.${encodeURIComponent(clientMessageId)}&select=${select}&order=created_at.asc&limit=2`,
      );
    },

    async findAssistantById(sessionId, messageId) {
      const rows = await supabaseRest<StoredAgentMessage[]>(
        env,
        token,
        `/rest/v1/feeding_agent_messages?session_id=eq.${encodeURIComponent(sessionId)}&id=eq.${encodeURIComponent(messageId)}&role=eq.assistant&select=${select}&limit=1`,
      );
      return rows[0] ?? null;
    },

    async findByResponseMessageId(sessionId, messageId) {
      return supabaseRest<StoredAgentMessage[]>(
        env,
        token,
        `/rest/v1/feeding_agent_messages?session_id=eq.${encodeURIComponent(sessionId)}&evidence->>responseMessageId=eq.${encodeURIComponent(messageId)}&select=${select}&order=created_at.asc&limit=2`,
      );
    },

    async append(message) {
      await supabaseInsert(env, token, "feeding_agent_messages", {
        id: message.id,
        user_id: message.userId,
        session_id: message.sessionId,
        role: message.role,
        content: message.content,
        evidence: message.evidence,
      });
    },
  };
}
