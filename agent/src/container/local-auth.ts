import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { SqliteLocalStore } from "../local-db/index.js";
import type { LocalUser } from "../shared/local-store-contract.js";

export const SESSION_COOKIE_NAME = "nbj_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("NBJ_AUTH_FIELDS_REQUIRED");
  const email = value.trim().toLowerCase();
  if (!email || email.length > 320 || !email.includes("@")) {
    throw new Error("NBJ_AUTH_EMAIL_INVALID");
  }
  return email;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512) {
    throw new Error("NBJ_AUTH_PASSWORD_INVALID");
  }
  return value;
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")):
  { hash: string; salt: string } {
  const hash = scryptSync(password, salt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  }).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, expectedHash: string, salt: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt).hash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function initializeLocalAdmin(
  store: SqliteLocalStore,
  email: string | undefined,
  password: string | undefined,
): LocalUser | null {
  if (!email || !password) return null;
  const normalized = normalizeEmail(email);
  // Container seed credentials are bootstrap-only. Reapplying Compose must
  // never rotate or re-enable an existing administrator implicitly.
  const existing = store.getUserByEmail(normalized);
  if (existing) return existing;
  const secret = validatePassword(password);
  const { hash, salt } = hashPassword(secret);
  return store.ensureUser({
    email: normalized,
    passwordHash: hash,
    passwordSalt: salt,
    role: "admin",
  });
}

export interface AuthContext {
  user: LocalUser;
  token: string;
  sessionId: string;
}

function parseCookies(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>();
  const values = headers.cookie;
  const input = Array.isArray(values) ? values.join(";") : values ?? "";
  for (const part of input.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (key) result.set(key, value);
  }
  return result;
}

export function getSessionToken(request: IncomingMessage): string | null {
  const fromCookie = parseCookies(request.headers).get(SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return null;
}

export function resolveLocalAuth(
  request: IncomingMessage,
  store: SqliteLocalStore,
): AuthContext | null {
  const token = getSessionToken(request);
  if (!token) return null;
  const session = store.getAuthSession(hashSessionToken(token));
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = store.getUserById(session.userId);
  if (!user || user.disabled) return null;
  return { user, token, sessionId: session.id };
}

export function requireLocalAuth(
  request: IncomingMessage,
  store: SqliteLocalStore,
): AuthContext {
  const auth = resolveLocalAuth(request, store);
  if (!auth) throw new Error("NBJ_AUTH_REQUIRED");
  return auth;
}

export function requireLocalAdmin(
  request: IncomingMessage,
  store: SqliteLocalStore,
): AuthContext {
  const auth = requireLocalAuth(request, store);
  if (auth.user.role !== "admin") throw new Error("NBJ_ADMIN_REQUIRED");
  return auth;
}

export function authenticateLocalUser(
  store: SqliteLocalStore,
  emailInput: unknown,
  passwordInput: unknown,
): { user: LocalUser; token: string; sessionId: string; expiresAt: string } {
  const email = normalizeEmail(emailInput);
  const password = validatePassword(passwordInput);
  const credential = store.getUserCredential(email);
  if (!credential || !verifyPassword(password, credential.passwordHash, credential.passwordSalt)) {
    throw new Error("NBJ_AUTH_INVALID_CREDENTIALS");
  }
  if (credential.user.disabled) throw new Error("NBJ_AUTH_DISABLED");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const session = store.createAuthSession({
    userId: credential.user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
  });
  return { user: credential.user, token, sessionId: session.id, expiresAt };
}

export function setSessionCookie(
  response: ServerResponse,
  token: string,
  maxAgeSeconds = SESSION_TTL_MS / 1_000,
  secure = true,
): void {
  const secureAttribute = secure ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly${secureAttribute}; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`,
  );
}

export function clearSessionCookie(response: ServerResponse, secure = true): void {
  const secureAttribute = secure ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly${secureAttribute}; SameSite=Lax; Max-Age=0`,
  );
}
