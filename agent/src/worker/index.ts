import { Container } from "@cloudflare/containers";

interface Env {
  ASSETS: Fetcher;
  FEEDING_AGENT_CONTAINER: DurableObjectNamespace<FeedingAgentContainer>;
  AGENT_GATEWAY_SECRET: string;
  LOCAL_AGENT_URL?: string;
  LLM_PROVIDER: string;
  LLM_MODEL: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CONFIG_ENCRYPTION_KEY?: string;
  LOCAL_ADMIN_EMAIL?: string;
  LOCAL_ADMIN_PASSWORD?: string;
}

/**
 * Kept as a deployment-compatible fallback. The field deployment uses
 * LOCAL_AGENT_URL and stores SQLite on the local Docker volume.
 */
export class FeedingAgentContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = true;
  allowedHosts = ["api.anthropic.com", "api.openai.com"];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      AGENT_STORAGE_BACKEND: "local",
      LOCAL_DB_PATH: "/data/naibaji.db",
      AGENT_GATEWAY_SECRET: env.AGENT_GATEWAY_SECRET,
      LLM_PROVIDER: env.LLM_PROVIDER,
      LLM_MODEL: env.LLM_MODEL,
      ...(env.CONFIG_ENCRYPTION_KEY
        ? { CONFIG_ENCRYPTION_KEY: env.CONFIG_ENCRYPTION_KEY }
        : {}),
      ...(env.LOCAL_ADMIN_EMAIL
        ? { LOCAL_ADMIN_EMAIL: env.LOCAL_ADMIN_EMAIL }
        : {}),
      ...(env.LOCAL_ADMIN_PASSWORD
        ? { LOCAL_ADMIN_PASSWORD: env.LOCAL_ADMIN_PASSWORD }
        : {}),
      ...(env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
        : {}),
      ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
    };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function staticResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyToLocalBackend(request: Request, env: Env): Promise<Response> {
  if (!env.LOCAL_AGENT_URL) {
    return json({ code: "NBJ_LOCAL_BACKEND_UNAVAILABLE" }, 503);
  }
  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, env.LOCAL_AGENT_URL);
  const headers = new Headers(request.headers);
  headers.set("x-agent-gateway-secret", env.AGENT_GATEWAY_SECRET);
  headers.delete("host");
  headers.delete("expect");
  headers.delete("content-length");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer(),
  });
  if (response.status < 200 || response.status > 599) {
    return json({
      code: "NBJ_LOCAL_BACKEND_INVALID_RESPONSE",
      upstreamStatus: response.status,
      upstreamType: response.type,
    }, 502);
  }
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      try {
        return await proxyToLocalBackend(request, env);
      } catch (error) {
        console.error(JSON.stringify({
          event: "local_backend_proxy_error",
          message: error instanceof Error ? error.message : String(error),
        }));
        return json({ code: "NBJ_LOCAL_BACKEND_UNAVAILABLE" }, 503);
      }
    }
    return staticResponse(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
