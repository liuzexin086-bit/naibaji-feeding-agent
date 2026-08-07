const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeIsoTimestamp(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!ISO_TIMESTAMP_PATTERN.test(raw)) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function timestampOrderValue(value: unknown): number {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
