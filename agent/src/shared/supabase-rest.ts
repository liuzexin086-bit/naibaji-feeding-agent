export interface SupabaseRuntime {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
}

export class SupabaseRestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Supabase request failed with status ${status}`);
  }
}

export async function supabaseRest<T>(
  env: SupabaseRuntime,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("apikey", env.SUPABASE_PUBLISHABLE_KEY);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw new SupabaseRestError(response.status, body);
  return body as T;
}

export async function supabaseInsert<T>(
  env: SupabaseRuntime,
  token: string,
  table: string,
  body: unknown,
): Promise<T> {
  return supabaseRest<T>(env, token, `/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  return token || null;
}
