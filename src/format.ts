/**
 * Number formatting shared by the map renderer and the browser app.
 */

/**
 * Compact form for large quantities: plain up to four digits, then k, m, b, t.
 *
 *     9999 -> 9999      10000 -> 10k      2000000 -> 2000k      20000000 -> 20m
 *
 * The unit changes only when the mantissa would reach five digits, which keeps four
 * significant figures rather than the one or two that SI-style notation leaves. That
 * matters here: `Intl.NumberFormat`'s compact notation would render 1200 and 1249 both
 * as "1.2K", and the difference between two armies that size decides the battle between
 * them. Rounds down, like every other quantity on screen.
 */
export function compact(n: number): string {
  const sign = n < 0 ? "-" : "";
  const units = ["", "k", "m", "b", "t"];
  let value = Math.floor(Math.abs(n));
  let unit = 0;
  while (value >= 10_000 && unit < units.length - 1) {
    value = Math.floor(value / 1000);
    unit++;
  }
  return `${sign}${value}${units[unit]}`;
}
