export function classifyAgentRuntimeError(message: unknown): string {
  const text = String(message ?? "").toLowerCase();
  if (
    text.includes("model_not_found") ||
    text.includes("model not found") ||
    text.includes("no available channel for model")
  ) {
    return "NBJ_AGENT_MODEL_NOT_FOUND";
  }
  if (
    text.includes("invalid_api_key") ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    /\b401\b/.test(text)
  ) {
    return "NBJ_AGENT_AUTH_FAILED";
  }
  if (text.includes("rate limit") || text.includes("too many requests") || /\b429\b/.test(text)) {
    return "NBJ_AGENT_RATE_LIMITED";
  }
  if (text.includes("timeout") || text.includes("timed out") || text.includes("aborterror")) {
    return "NBJ_AGENT_TIMEOUT";
  }
  return "NBJ_AGENT_UNAVAILABLE";
}
