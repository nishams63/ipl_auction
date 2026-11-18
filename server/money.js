// Exact money arithmetic for the auction.
//
// Amounts are stored and broadcast as ₹ Crore numbers (e.g. 10.5), as before. All arithmetic
// is done in INTEGER LAKHS (1 Cr = 100 lakh): every amount in the catalogue, config, bid ladder
// and purse is a whole number of lakhs, so integer arithmetic is exact. Values convert back with
// lakh / 100, which yields the same double as the decimal literal (e.g. 1045 / 100 === 10.45).

export const LAKH_PER_CRORE = 100;

/** ₹ Cr → integer lakhs. Throws for non-finite input. */
export function toLakh(crore) {
  if (typeof crore !== 'number' || !Number.isFinite(crore)) throw new TypeError(`invalid money amount: ${crore}`);
  return Math.round(crore * LAKH_PER_CRORE);
}

/** True when a ₹ Cr number is a whole number of lakhs (at most 2 decimals). */
export function isWholeLakh(crore) {
  return typeof crore === 'number' && Number.isFinite(crore) && Math.abs(crore * LAKH_PER_CRORE - Math.round(crore * LAKH_PER_CRORE)) < 1e-6;
}

export const fromLakh = lakh => lakh / LAKH_PER_CRORE;

/**
 * Bid increment for the CURRENT highest bid (approved ladder):
 *   below ₹10 Cr          → +₹0.25 Cr   (… 4.75→5, 5→5.25, 9.75→10)
 *   ₹10 Cr up to < ₹15 Cr → +₹0.50 Cr   (10→10.5, 14.5→15)
 *   ₹15 Cr and above      → +₹1 Cr      (15→16, 20→21)
 */
export function bidIncrementLakh(currentLakh) {
  if (currentLakh < 1000) return 25;
  if (currentLakh < 1500) return 50;
  return 100;
}

/** Next valid bid in lakhs: the base price for the first bid, then the ladder. */
export function nextBidLakh(currentLakh, basePriceLakh) {
  if (!currentLakh || currentLakh <= 0) return basePriceLakh;
  return currentLakh + bidIncrementLakh(currentLakh);
}
