export const TICKS_PER_SECOND = 254_016_000_000n;
export function ticks(seconds: number): number {
  const whole = BigInt(Math.trunc(seconds));
  const frac = seconds - Math.trunc(seconds);
  const fracTicks = BigInt(Math.round(frac * Number(TICKS_PER_SECOND)));
  return Number(whole * TICKS_PER_SECOND + fracTicks);
}
