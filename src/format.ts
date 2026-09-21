/**
 * Number formatting shared by the map renderer and the browser app.
 */

/**
 * Compact form: plain up to four digits, then k, m, b, t.
 *
 *     9999 -> 9999      10000 -> 10k      2000000 -> 2000k      20000000 -> 20m
 *
 * Four significant figures, not the one or two SI-style notation leaves — 1200 and
 * 1249 both reading "1.2K" would hide which of two armies wins. Rounds down.
 */
export function compact(n: number, decimals = 0): string {
  const sign = n < 0 ? "-" : "";
  const units = ["", "k", "m", "b", "t"];
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 10_000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // Decimals belong to the unit change and nowhere else. Every quantity in the game is
  // a whole number of things, so 12 tons of iron is 12 and not 12.87; the digits in
  // 10.43k are thousands, not fractions of a ton.
  const places = unit === 0 ? 0 : decimals;
  // Truncated, not rounded: 456,999 is 456.99k, never 457.00k. Everything on screen
  // rounds down, so that a number never claims more than the nation actually has.
  const scale = 10 ** places;
  const shown = (Math.floor(value * scale) / scale)
    .toFixed(places)
    // No decimal point on a whole number: 26, not 26.00, and 999.4, not 999.40. The
    // digits are there to carry information, and a run of zeros carries none.
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return `${sign}${shown}${units[unit]}`;
}

/**
 * Whole people, grouped in thousands. Grouped rather than compacted because the
 * standings are read by comparing them (§1.3), and commas explicitly rather than
 * `toLocaleString`, which would put full stops in for half the world.
 */
export function grouped(n: number): string {
  const sign = n < 0 ? "-" : "";
  const whole = String(Math.floor(Math.abs(n)));
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Whether a tonnage reads as short or spare, judged on the floored figure the player
 * sees rather than the raw one — or -0.3 displays as "-1" and is not highlighted.
 */
export function standing(tons: number): "short" | "spare" | "" {
  const shown = Math.floor(tons);
  return shown < 0 ? "short" : shown > 0 ? "spare" : "";
}
