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

/**
 * Whole people, grouped in thousands: 18500 reads 18,500.
 *
 * Grouped rather than compacted, because population is the victory metric (§1.3) and
 * the standings are read by comparing them — "2,412,077" against "2,411,962" is a
 * different fact from both of them reading "2412k". Commas explicitly rather than
 * `toLocaleString`, which would put full stops in for half the world.
 */
export function grouped(n: number): string {
  const sign = n < 0 ? "-" : "";
  const whole = String(Math.floor(Math.abs(n)));
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
