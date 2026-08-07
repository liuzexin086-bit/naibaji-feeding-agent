const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function offsetMinutes(zone: string): number | null {
  if (zone === "Z") return 0;
  const sign = zone.startsWith("-") ? -1 : 1;
  const hour = Number(zone.slice(1, 3));
  const minute = Number(zone.slice(4, 6));
  if (hour > 23 || minute > 59) return null;
  return sign * (hour * 60 + minute);
}

export function normalizeIsoTimestamp(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = ISO_TIMESTAMP_PATTERN.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fractionMs = match[7] === undefined
    ? 0
    : Math.round(Number(`0.${match[7]}`) * 1000);
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  const zoneOffsetMinutes = offsetMinutes(match[8]);
  if (zoneOffsetMinutes === null) return null;
  const utcMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    fractionMs,
  ) - zoneOffsetMinutes * 60_000;
  return new Date(utcMs).toISOString();
}

export function timestampOrderValue(value: unknown): number {
  const normalized = normalizeIsoTimestamp(value);
  return normalized ? Date.parse(normalized) : Number.MIN_SAFE_INTEGER;
}
