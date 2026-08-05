const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** All operational schedules are ordered from 09:00 through the next 09:00. */
export const BUSINESS_DAY_START_MINUTE = 9 * 60;
const MINUTES_PER_DAY = 24 * 60;

export interface BusinessDayWindow {
  startLocal: string;
  endLocal: string;
}

function fail(code: string): never {
  throw new Error(`NBJ_DECISION_${code}`);
}

export function localMinute(value: string): number {
  if (!TIME_PATTERN.test(value)) fail("INVALID_LOCAL_TIME");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** Minutes elapsed since 09:00 in the current business-day cycle. */
export function businessDayMinute(value: string): number {
  return (localMinute(value) - BUSINESS_DAY_START_MINUTE + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Keep the caller's original schedule order, while selecting only meals that
 * are still ahead of the observed time on the 09:00 business-day axis.
 */
export function remainingBusinessDayTimes(times: string[], observedLocal: string): string[] {
  const observed = businessDayMinute(observedLocal);
  return times.filter((time) => businessDayMinute(time) > observed);
}

interface Interval {
  start: number;
  end: number;
}

function intervalsFor(window: BusinessDayWindow): Interval[] {
  const startLocal = localMinute(window.startLocal);
  const endLocal = localMinute(window.endLocal);
  if (startLocal === endLocal) fail("FREE_WINDOW_ZERO_DURATION");

  const duration = (endLocal - startLocal + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const start = businessDayMinute(window.startLocal);
  const end = start + duration;
  if (end <= MINUTES_PER_DAY) return [{ start, end }];
  return [
    { start, end: MINUTES_PER_DAY },
    { start: 0, end: end - MINUTES_PER_DAY },
  ];
}

/**
 * Validates recurring windows after projecting them onto the 09:00 business
 * day. Cross-midnight windows are split at the business-day boundary so that
 * overlap checks remain correct for windows such as 23:00–02:00.
 */
export function assertNonOverlappingBusinessDayWindows(
  windows: BusinessDayWindow[],
): void {
  const intervals = windows.flatMap(intervalsFor).sort((left, right) =>
    left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]!.start < intervals[index - 1]!.end) {
      fail("FREE_WINDOWS_OVERLAP");
    }
  }
}
