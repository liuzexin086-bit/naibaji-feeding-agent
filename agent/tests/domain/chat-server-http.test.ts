import { describe, expect, it } from "vitest";
import {
  createContainerServer,
  type ChatContext,
  type ContainerEnv,
  type ContainerStorage,
} from "../../src/container/server.js";

const env: ContainerEnv = {
  AGENT_GATEWAY_SECRET: "test-gateway",
  LLM_PROVIDER: "openai",
  LLM_MODEL: "test-model",
};

const storage: ContainerStorage = {
  backend: "supabase",
  runtime: {
    SUPABASE_URL: "https://example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-key",
  },
};

async function withServer(
  run: (url: string, contexts: ChatContext[]) => Promise<void>,
): Promise<void> {
  const contexts: ChatContext[] = [];
  const server = createContainerServer(env, storage, {
    onChatContext: (context) => contexts.push(context),
    stopAfterChatObservation: true,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
  try {
    await run(`http://127.0.0.1:${address.port}`, contexts);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function requestBody(observation: unknown): Record<string, unknown> {
  return {
    batchId: "batch-1",
    sessionId: "session-1",
    message: "请检查本轮观察",
    observation,
  };
}

function requestInit(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-gateway-secret": "test-gateway",
      authorization: "Bearer test-token",
      "x-auth-user": "user-1",
    },
    body: JSON.stringify(body),
  };
}

describe("feeding-agent chat observation HTTP boundary", () => {
  it("accepts the complete UI payload and preserves explicit none", async () => {
    await withServer(async (url, contexts) => {
      const response = await fetch(`${url}/api/feeding-agent/chat`, requestInit(requestBody({
        dayIndex: 2,
        dayAge: 9,
        effectiveHeads: 20,
        creepGrade: "high",
        creepValue: 80,
        diarrheaGrade: "none",
        waterState: "closed",
        actualPowderGrams: "0",
      })));
      expect(response.status).toBe(204);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.observation).toEqual({
        diarrheaGrade: "none",
        actualPowderGrams: 0,
      });
      expect(contexts[0]?.observation).not.toHaveProperty("deviceOperation");
      expect(contexts[0]?.observation).not.toHaveProperty("applied");
      expect(contexts[0]?.observation).not.toHaveProperty("application");
    });
  });

  it("keeps omitted diarrhea distinct from explicit none in the downstream context", async () => {
    await withServer(async (url, contexts) => {
      const omitted = await fetch(`${url}/api/feeding-agent/chat`, requestInit(requestBody({
        dayIndex: 2,
        dayAge: 9,
        effectiveHeads: 20,
        diarrheaGrade: undefined,
        actualPowderGrams: "",
      })));
      expect(omitted.status).toBe(204);
      const explicitNone = await fetch(`${url}/api/feeding-agent/chat`, requestInit(requestBody({
        dayIndex: 2,
        dayAge: 9,
        effectiveHeads: 20,
        diarrheaGrade: "none",
        actualPowderGrams: "",
      })));
      expect(explicitNone.status).toBe(204);
      expect(contexts).toHaveLength(2);
      expect(contexts[0]?.observation).toEqual({ actualPowderGrams: null });
      expect(contexts[1]?.observation).toEqual({
        diarrheaGrade: "none",
        actualPowderGrams: null,
      });
      expect(Object.prototype.hasOwnProperty.call(contexts[0]?.observation ?? {}, "diarrheaGrade")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(contexts[1]?.observation ?? {}, "diarrheaGrade")).toBe(true);
    });
  });

  it("fails closed for invalid selected fields", async () => {
    await withServer(async (url, contexts) => {
      const invalidDiarrhea = await fetch(`${url}/api/feeding-agent/chat`, requestInit(requestBody({
        diarrheaGrade: "invented",
        actualPowderGrams: 0,
      })));
      expect(invalidDiarrhea.status).toBe(400);
      expect(await invalidDiarrhea.json()).toEqual({ code: "NBJ_AGENT_OBSERVATION_INVALID" });

      const invalidActual = await fetch(`${url}/api/feeding-agent/chat`, requestInit(requestBody({
        diarrheaGrade: "none",
        actualPowderGrams: "not-a-number",
      })));
      expect(invalidActual.status).toBe(400);
      expect(await invalidActual.json()).toEqual({ code: "NBJ_AGENT_OBSERVATION_INVALID" });
      expect(contexts).toHaveLength(0);
    });
  });
});
