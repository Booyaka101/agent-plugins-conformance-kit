/** Node timers clamp values above this limit to 1 ms. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function isPositiveInteger(value: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
