export function shanghaiLocalNowIso(): string {
  const now = new Date();
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(now.getTime() + shanghaiOffsetMs);
  return shifted.toISOString().replace("Z", "+08:00");
}
