import { createHmac, randomUUID } from "node:crypto";
import { Client } from "langsmith";
import { RunTree } from "langsmith/run_trees";
import { withRunTree } from "langsmith/traceable";

export interface MetadataTraceConfig {
  enabled: boolean;
  apiKey?: string;
  endpoint?: string;
  project?: string;
  hashKey: string;
}

export interface SafeTraceMetadata {
  provider: string;
  model: string;
  apiMode: string;
  graphVersion: string;
  query: string;
}

export function queryHmac(query: string, key: string): string {
  return createHmac("sha256", key).update(query.normalize("NFKC")).digest("hex");
}

export function safeTracePayload(metadata: SafeTraceMetadata, hashKey: string) {
  return {
    provider: metadata.provider,
    model: metadata.model,
    apiMode: metadata.apiMode,
    graphVersion: metadata.graphVersion,
    queryHmac: queryHmac(metadata.query, hashKey),
  };
}

export async function withMetadataTrace<T>(
  config: MetadataTraceConfig,
  metadata: SafeTraceMetadata,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const runId = randomUUID();
  const safe = safeTracePayload(metadata, config.hashKey);
  const client = config.enabled && config.apiKey
    ? new Client({
        apiKey: config.apiKey,
        apiUrl: config.endpoint,
        hideInputs: true,
        hideOutputs: true,
      })
    : null;
  if (client) {
    await client.createRun({
      id: runId,
      name: "naibaji-agent-graph",
      run_type: "chain",
      project_name: config.project,
      inputs: {},
      extra: { metadata: safe },
    }).catch(() => undefined);
  }
  try {
    // Suppress LangChain's environment-driven automatic tracing: it would
    // serialize raw prompts/tool bodies. Only the explicit metadata run above
    // is allowed to leave the container.
    const result = await withRunTree(new RunTree({
      name: "naibaji-agent-redaction-boundary",
      run_type: "chain",
      inputs: {},
      tracingEnabled: false,
    }), operation);
    if (client) await client.updateRun(runId, {
      end_time: Date.now(),
      outputs: {},
      extra: { metadata: { ...safe, status: "ok", durationMs: Date.now() - startedAt } },
    }).catch(() => undefined);
    return result;
  } catch (error) {
    if (client) await client.updateRun(runId, {
      end_time: Date.now(),
      outputs: {},
      error: error instanceof Error && error.message.startsWith("NBJ_")
        ? error.message
        : "NBJ_AGENT_UNAVAILABLE",
      extra: { metadata: { ...safe, status: "error", durationMs: Date.now() - startedAt } },
    }).catch(() => undefined);
    throw error;
  }
}
