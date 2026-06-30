/* ═══════════════════════════════════════════════════════════════════
 *  SKILL POINT ADVISOR — core allocation logic
 *
 *  All formulas below are confirmed against either the official wiki
 *  (warera.wiki/skills) or real in-game tooltips captured during this
 *  project (see chat record). None are guessed.
 *
 *  Confirmed facts:
 *   - Cost to reach level L (any of the 4 economic skills): L*(L+1)/2
 *     (triangular numbers; cost of the Nth point = N). Wiki-confirmed
 *     for Entrepreneurship/Energy/Production/Companies up to L=10;
 *     also confirmed via live tooltip for Management at L=1 and L=2.
 *   - Entrepreneurship value(L) = 30 + 5*L   (wiki)
 *   - Energy value(L)           = 30 + 10*L  (wiki; tooltip-confirmed L=7 -> 100)
 *   - Production value(L)       = 10 + 3*L   (wiki)
 *   - Companies cap(L)          = 2 + L       (wiki)
 *   - Management -> workers(L)  = 4 + 2*L     (live tooltips: L=0->4, L=1->6, L=2->8)
 *   - PP/hour = (EntrepreneurshipValue + EnergyValue) * ProductionValue / 100
 *     Derived by reverse-fitting the "Eco skill point distribution" source
 *     article's 11 published rows. Exact match on every row (see test file).
 *     NOT yet confirmed against a primary/live source — flagged as such.
 * ═══════════════════════════════════════════════════════════════════ */


/** Cumulative SP cost to reach a given level in any of the four
 *  triangular-cost skills (Entrepreneurship, Energy, Production,
 *  Companies, Management all share this cost curve). */
function costToReachLevel(level) {
  if (level <= 0) return 0;
  return (level * (level + 1)) / 2;
}

/** Inverse of costToReachLevel: given a SP budget, what's the highest
 *  level reachable? Used by the search/optimizer, not by the
 *  companies/workers back-calculation (those have their own exact
 *  inverses below since their value formulas are linear+invertible). */
function maxLevelForCost(spBudget) {
  if (spBudget <= 0) return 0;
  // L*(L+1)/2 <= spBudget  =>  L <= (-1 + sqrt(1 + 8*spBudget)) / 2
  return Math.floor((-1 + Math.sqrt(1 + 8 * spBudget)) / 2);
}

/* ── Value formulas (confirmed) ─────────────────────────────────── */
const entrepreneurshipValue = (L) => 30 + 5 * L;
const energyValue           = (L) => 30 + 10 * L;
const productionValue       = (L) => 10 + 3 * L;
const companiesCap          = (L) => 2 + L;
const managementWorkers     = (L) => 4 + 2 * L;

/* ── Back-calculation: companies/workers wanted -> level -> SP spent ─
 *  Companies is an exact 1:1 mapping (every integer >= 2 is achievable).
 *  Management only lands on 4,6,8,10... so any in-between value must
 *  round UP — per game rules, having 5 workers means at least the
 *  level-1 (6-worker) point has been spent. */
function companiesToLevel(numCompanies) {
  return Math.max(0, Math.ceil(numCompanies - 2));
}
function workersToLevel(numWorkers) {
  if (numWorkers <= 4) return 0;
  return Math.ceil((numWorkers - 4) / 2);
}

/* ── PP/hour formula (derived, see header note) ─────────────────── */
function ppPerHour(entL, eneL, prodL) {
  const ent = entrepreneurshipValue(entL);
  const ene = energyValue(eneL);
  const prod = productionValue(prodL);
  return ((ent + ene) * prod) / 100;
}

/* ── Optimizer ───────────────────────────────────────────────────
 *  Given a remaining SP budget (after Companies + Management have
 *  already been paid for), find the (entL, eneL, prodL) split that
 *  maximizes pp/h, spending AT MOST the budget (no requirement to
 *  spend every point, though in practice the optimum almost always
 *  does since more SP in any of the three never hurts pp/h).
 *
 *  Brute-force over entL and eneL, with prodL = whatever's left
 *  (greedy on the remainder is provably optimal here since prodL's
 *  marginal contribution at a fixed remainder is monotonic and the
 *  three skills don't interact beyond the linear formula above —
 *  confirmed empirically against the regression table below, not
 *  proven symbolically, so the brute force itself is the real
 *  guarantee of correctness, not this comment).
 *
 *  Budget sizes in this game are small enough (full max realistically
 *  caps out a few hundred SP) that an O(n^2) brute force over levels
 *  is effectively instant; no need for a cleverer search.
 */
function optimizeAllocation(remainingSP) {
  let best = { entL: 0, eneL: 0, prodL: 0, pph: 0, spentSP: 0 };

  const maxEntL = maxLevelForCost(remainingSP);
  for (let entL = 0; entL <= maxEntL; entL++) {
    const entCost = costToReachLevel(entL);
    const afterEnt = remainingSP - entCost;
    if (afterEnt < 0) break;

    const maxEneL = maxLevelForCost(afterEnt);
    for (let eneL = 0; eneL <= maxEneL; eneL++) {
      const eneCost = costToReachLevel(eneL);
      const afterEne = afterEnt - eneCost;
      if (afterEne < 0) break;

      const prodL = maxLevelForCost(afterEne);
      const prodCost = costToReachLevel(prodL);
      const spentSP = entCost + eneCost + prodCost;
      const pph = ppPerHour(entL, eneL, prodL);

      if (pph > best.pph) {
        best = { entL, eneL, prodL, pph, spentSP };
      }
    }
  }
  return best;
}

/* ── Top-level entry point ──────────────────────────────────────
 *  level: player level (total SP available = level * 4, per the
 *         "4 SP per level" rule confirmed by the maintainer)
 *  numCompanies, numWorkers: manual inputs (counts, not levels)
 */
function computeAdvice({ level, numCompanies, numWorkers }) {
  const totalSP = level * 4;

  const companiesLevel = companiesToLevel(numCompanies);
  const managementLevel = workersToLevel(numWorkers);
  const companiesSpent = costToReachLevel(companiesLevel);
  const managementSpent = costToReachLevel(managementLevel);
  const spentOnPrereqs = companiesSpent + managementSpent;

  const remainingSP = totalSP - spentOnPrereqs;

  if (remainingSP < 0) {
    return {
      error: `This level (${level}) only grants ${totalSP} SP total, but ${numCompanies} companies + ${numWorkers} workers requires ${spentOnPrereqs} SP. Not achievable yet.`,
    };
  }

  const allocation = optimizeAllocation(remainingSP);

  // No-resets recommendation: looked up from the published article's
  // table (see no-resets-table.js for why this isn't computed fresh —
  // the true monotonic optimum turned out to need a harder DP than
  // expected, so this uses already-verified, already-monotonic data
  // instead of an unverified algorithm). The table covers SP 30-165;
  // outside that range we say so explicitly rather than silently
  // falling back to the (non-monotonic) absolute optimum, which would
  // misrepresent it as a no-resets-safe answer.
  const noResets = lookupNoResetsTable(remainingSP);

  return {
    totalSP,
    companiesLevel,
    managementLevel,
    companiesSpent,
    managementSpent,
    spentOnPrereqs,
    remainingSP,
    leftoverSP: remainingSP - allocation.spentSP,
    allocation,
    noResets, // null if remainingSP is outside the article table's 30-165 coverage
  };
}