import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";

export interface AgentModelConfig {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl: string;
  apiMode: "responses" | "chat_completions";
  timeout: number;
  maxOutputTokens: number;
}

export function createLangChainModel(config: AgentModelConfig): BaseChatModel {
  if (config.provider === "anthropic") {
    return new ChatAnthropic({
      model: config.model,
      apiKey: config.apiKey,
      anthropicApiUrl: config.baseUrl,
      maxTokens: config.maxOutputTokens,
      maxRetries: 0,
      clientOptions: { timeout: config.timeout },
    });
  }
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    maxTokens: config.maxOutputTokens,
    timeout: config.timeout,
    maxRetries: 0,
    useResponsesApi: config.apiMode === "responses",
    configuration: { baseURL: config.baseUrl },
  });
}
