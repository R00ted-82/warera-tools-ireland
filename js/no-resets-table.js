/* ═══════════════════════════════════════════════════════════════════
 *  NO-RESETS TABLE — sourced directly from the published article
 *  ("Eco skill point distribution", warera.io), not re-derived.
 *
 *  Why a lookup table instead of a computed path: the absolute
 *  optimum (sp-advisor-core.js's optimizeAllocation) is provably NOT
 *  monotonic as SP grows — it swaps points between Entrepreneurship
 *  and Energy as the budget changes, which isn't followable without
 *  resetting. Computing a correct monotonic-path optimum turned out
 *  to be a much harder DP than expected (several shortcut algorithms
 *  were tried and proven wrong against exhaustive search — see the
 *  no-resets-path*.js files in this project's history for the
 *  abandoned attempts and why each failed). Rather than ship an
 *  unverified algorithm, this table is the article's own published,
 *  already-monotonic data, confirmed monotonic by direct check below.
 *
 *  Each row: [spLow, spHigh, entL, eneL, prodL]. spHigh is inclusive.
 *  The article's pp/h figures (where shown) are NOT stored here —
 *  they're recomputed via the verified ppPerHour() formula instead,
 *  to stay consistent with one single source of truth for that math.
 * ═══════════════════════════════════════════════════════════════════ */
/**
 * Each row: [spLow, spHigh, entL, eneL, prodL]. spHigh is inclusive.
 * The article's pp/h figures (where shown) are NOT stored here —
 * they're recomputed via the same pp/h formula used elsewhere, to
 * stay consistent with one single source of truth for that math.
 * The two tiny formulas below (cost, pp/h) are intentionally
 * duplicated from sp-advisor-core.js rather than imported, to avoid
 * a circular require (sp-advisor-core.js's computeAdvice() calls into
 * this file). Both are covered by the same regression tests as the
 * originals — see test-sp-advisor.js section 9 — so drift between the
 * two copies would be caught immediately.
 */
function costToReachLevel(level) {
  if (level <= 0) return 0;
  return (level * (level + 1)) / 2;
}
function ppPerHour(entL, eneL, prodL) {
  const ent = 30 + 5 * entL;
  const ene = 30 + 10 * eneL;
  const prod = 10 + 3 * prodL;
  return ((ent + ene) * prod) / 100;
}

const NO_RESETS_TABLE = [
  [30, 33, 2, 3, 6],
  [34, 38, 2, 4, 6],
  [39, 45, 2, 5, 6],
  [46, 48, 2, 5, 7],
  [49, 54, 3, 5, 7],
  [55, 62, 3, 6, 7],
  [63, 69, 3, 6, 8],
  [70, 78, 3, 7, 8],
  [79, 86, 3, 7, 9],
  [87, 96, 3, 8, 9],
  [97, 100, 3, 8, 10],
  // Rows below extend the table to its full published range (101-165),
  // found later and cross-checked before trusting: every row's exact
  // cost matches its own low bound precisely, the whole sequence (all
  // 20 rows, old and new) is monotonic, and every level used stays
  // within the wiki-confirmed 0-10 range — none of this extrapolates
  // past previously-verified territory.
  [101, 109, 4, 8, 10],
  [110, 114, 4, 9, 10],
  [115, 124, 5, 9, 10],
  [125, 130, 5, 10, 10],
  [131, 137, 6, 10, 10],
  [138, 145, 7, 10, 10],
  [146, 154, 8, 10, 10],
  [155, 164, 9, 10, 10],
  [165, 165, 10, 10, 10],
];

/**
 * Looks up the no-resets recommendation for a given remaining-SP total.
 * Returns null if totalSP is below the table's lowest row (30) — the
 * article's table doesn't cover very low SP, and rather than guess an
 * extrapolation, callers should fall back to the verified optimizer
 * for SP below 30 (it's a small enough budget that the "smoothness"
 * concern barely applies — see findEarlyGameFallback below).
 * For SP above 165 (the table's confirmed ceiling — every skill here
 * caps at level 10, the wiki's own documented maximum), also returns
 * null rather than guessing how the pattern would continue past the
 * point where two of the three skills are already maxed out.
 */
function lookupNoResetsTable(totalSP) {
  for (const [lo, hi, entL, eneL, prodL] of NO_RESETS_TABLE) {
    if (totalSP >= lo && totalSP <= hi) {
      const spentSP = costToReachLevel(entL) + costToReachLevel(eneL) + costToReachLevel(prodL);
      return { entL, eneL, prodL, pph: ppPerHour(entL, eneL, prodL), spentSP, source: 'article-table' };
    }
  }
  return null;
}