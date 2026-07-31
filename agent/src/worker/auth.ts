import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { SupabaseRuntime } from "../shared/supabase-rest.js";

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function projectIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
}

async function verifyLegacyToken(
  env: SupabaseRuntime,
  token: string,
): Promise<JWTPayload> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new Error("NBJ_AUTH_INVALID_JWT");
  const user = (await response.json()) as { id?: string; aud?: string; role?: string };
  if (!user.id) throw new Error("NBJ_AUTH_INVALID_JWT");
  return { sub: user.id, aud: user.aud ?? "authenticated", role: user.role };
}

export async function verifySupabaseJwt(
  env: SupabaseRuntime,
  token: string,
): Promise<JWTPayload> {
  const header = decodeProtectedHeader(token);
  if (header.alg?.startsWith("HS")) return verifyLegacyToken(env, token);

  const jwksUrl = `${projectIssuer(env.SUPABASE_URL)}/.well-known/jwks.json`;
  let jwks = jwksByUrl.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksByUrl.set(jwksUrl, jwks);
  }
  const result = await jwtVerify(token, jwks, {
    issuer: projectIssuer(env.SUPABASE_URL),
    audience: "authenticated",
  });
  if (!result.payload.sub) throw new Error("NBJ_AUTH_INVALID_JWT");
  return result.payload;
}
