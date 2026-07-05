/* ═══════════════════════════════════════════════════════════════════
 *  TAX DEAL DASHBOARD (#tax-deals, link-only, no nav entry)
 *
 *  Generic, config-driven counterpart to #tax-partner. Where #tax-partner
 *  is Ireland-only (one shared data/tax/current_week.json, filtered by a
 *  flat password map), any bilateral deal defined in
 *  data/tax/deal_config.json gets its own daily log at
 *  data/tax/deal_logs/<id>.json (see deal_log.py + tax_engine.py).
 *
 *  Flow: pick the home country -> pick the deal (host country) -> enter
 *  that deal's password -> fetch and render ONLY that deal's log file.
 *  The country/deal list (names only, not their logged data) is public —
 *  the password gate is a UI convenience, not encryption, same documented
 *  model as js/irish-tax-partner.js: this is fully static hosting, so the
 *  log file itself is already fetchable by anyone who knows its URL. The
 *  gate just controls what the UI shows/links to.
 *
 *  Deal creation ("Propose a deal") posts to a repository_dispatch-backed
 *  Worker route, mirroring js/buddy-finder.js's waitlist-update pattern.
 *  Submissions always land disabled — see .github/workflows/
 *  deal-config-submit.yml — a human must flip them on after review.
 * ═══════════════════════════════════════════════════════════════════ */
const TaxDealDashboardTool = (() => {
  const money = (v) => (v == null || !isFinite(v)) ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const flagOf = (code) => (code && code.length === 2) ? flag(code) : '🏳️';

  // Same 180-country reference table as js/roster.js (Battle Intel's country
  // picker) — kept as its own copy here rather than a shared import, matching
  // this project's convention of small self-contained per-tool data. Used for
  // the "Propose a deal" typeahead so partners pick by name, not ISO code.
  const COUNTRIES_RAW = [
    ['ireland','6813b6d446e731854c7ac7fe','ie'],
    ['bolivia','6813b6d546e731854c7ac85c','bo'],
    ['singapore','6813b6d546e731854c7ac871','sg'],
    ['switzerland','6813b6d446e731854c7ac7a6','ch'],
    ['taiwan','6813b6d546e731854c7ac826','tw'],
    ['trinidadandtobago','6813b6d546e731854c7ac8a3','tt'],
    ['panama','6813b6d546e731854c7ac8ac','pa'],
    ['belize','6813b6d546e731854c7ac8bb','bz'],
    ['haiti','6813b6d546e731854c7ac896','ht'],
    ['bangladesh','683ddd2c24b5a2e114af15b9','bd'],
    ['jordan','683ddd2c24b5a2e114af15c7','jo'],
    ['iceland','683ddd2c24b5a2e114af15c5','is'],
    ['madagascar','683ddd2c24b5a2e114af15d3','mg'],
    ['namibia','683ddd2c24b5a2e114af15f7','na'],
    ['czechia','6813b6d446e731854c7ac7b0','cz'],
    ['slovenia','6813b6d446e731854c7ac7b4','si'],
    ['bulgaria','6813b6d446e731854c7ac7be','bg'],
    ['bosnia','6813b6d446e731854c7ac80e','ba'],
    ['venezuela','6813b6d546e731854c7ac858','ve'],
    ['greenland','6813b6d546e731854c7ac890','gl'],
    ['uzbekistan','6813b6d546e731854c7ac8c1','uz'],
    ['qatar','6813b6d546e731854c7ac8dd','qa'],
    ['indonesia','6813b6d546e731854c7ac829','id'],
    ['algeria','6813b6d546e731854c7ac84b','dz'],
    ['paraguay','6813b6d546e731854c7ac838','py'],
    ['angola','683ddd2c24b5a2e114af15b7','ao'],
    ['lebanon','683ddd2c24b5a2e114af15cf','lb'],
    ['srilanka','683ddd2c24b5a2e114af15d1','lk'],
    ['myanmar','683ddd2c24b5a2e114af15d5','mm'],
    ['unitedkorea','683ddd2c24b5a2e114af15cb','kp'],
    ['gambia','6873d0ea1758b40e712b5ee7','gm'],
    ['equatorialguinea','6873d0ea1758b40e712b5f31','gq'],
    ['capeverde','6873d0ea1758b40e712b5f49','cv'],
    ['brunei','6873d0ea1758b40e712b5f4f','bn'],
    ['easttimor','6873d0ea1758b40e712b5f56','tl'],
    ['colombia','6813b6d546e731854c7ac85f','co'],
    ['unitedstates','6813b6d446e731854c7ac7e5','us'],
    ['chile','6813b6d546e731854c7ac83c','cl'],
    ['libya','6813b6d546e731854c7ac852','ly'],
    ['honduras','6813b6d546e731854c7ac8b5','hn'],
    ['guatemala','6813b6d546e731854c7ac8b8','gt'],
    ['malta','6873d0ea1758b40e712b5f3d','mt'],
    ['rwanda','6873d0ea1758b40e712b5f40','rw'],
    ['luxembourg','6813b6d446e731854c7ac7fb','lu'],
    ['mexico','6813b6d446e731854c7ac7f8','mx'],
    ['uruguay','6813b6d546e731854c7ac835','uy'],
    ['moldova','6813b6d546e731854c7ac86b','md'],
    ['southsudan','6813b6d546e731854c7ac877','ss'],
    ['fiji','6813b6d546e731854c7ac883','fj'],
    ['vietnam','683ddd2c24b5a2e114af160c','vn'],
    ['uganda','6873d0ea1758b40e712b5ef3','ug'],
    ['burkinafaso','6873d0ea1758b40e712b5f37','bf'],
    ['tanzania','6873d0ea1758b40e712b5f3a','tz'],
    ['burundi','6873d0ea1758b40e712b5f43','bi'],
    ['papuanewguinea','6873d0ea1758b40e712b5f67','pg'],
    ['canada','6813b6d446e731854c7ac808','ca'],
    ['peru','6813b6d546e731854c7ac83f','pe'],
    ['cuba','6813b6d546e731854c7ac886','cu'],
    ['costarica','6813b6d546e731854c7ac8a9','cr'],
    ['egypt','6813b6d546e731854c7ac845','eg'],
    ['kyrgyzstan','6813b6d546e731854c7ac8c4','kg'],
    ['laos','683ddd2c24b5a2e114af15cd','la'],
    ['benin','6873d0ea1758b40e712b5f25','bj'],
    ['ivorycoast','6873d0ea1758b40e712b5f34','ci'],
    ['zambia','6873d0ea1758b40e712b5f73','zm'],
    ['italy','6813b6d446e731854c7ac7a2','it'],
    ['poland','6813b6d446e731854c7ac7ae','pl'],
    ['lithuania','6813b6d446e731854c7ac7b8','lt'],
    ['finland','6813b6d446e731854c7ac80b','fi'],
    ['southkorea','6813b6d546e731854c7ac823','kr'],
    ['greece','6813b6d446e731854c7ac7e8','gr'],
    ['sudan','6813b6d546e731854c7ac874','sd'],
    ['guyana','6813b6d546e731854c7ac893','gy'],
    ['iran','6813b6d546e731854c7ac8a6','ir'],
    ['slovakia','6813b6d446e731854c7ac805','sk'],
    ['iraq','683ddd2c24b5a2e114af15c3','iq'],
    ['mongolia','683ddd2c24b5a2e114af15d7','mn'],
    ['southafrica','683ddd2c24b5a2e114af1612','za'],
    ['senegal','6873d0ea1758b40e712b5eef','sn'],
    ['ghana','6873d0ea1758b40e712b5eeb','gh'],
    ['niger','6873d0ea1758b40e712b5ef1','ne'],
    ['botswana','6873d0ea1758b40e712b5f70','bw'],
    ['morocco','6813b6d546e731854c7ac848','ma'],
    ['latvia','6813b6d446e731854c7ac7c0','lv'],
    ['portugal','6813b6d446e731854c7ac7aa','pt'],
    ['denmark','6813b6d446e731854c7ac7ef','dk'],
    ['norway','6813b6d446e731854c7ac802','no'],
    ['northmacedonia','6813b6d546e731854c7ac811','mk'],
    ['kosovo','6813b6d546e731854c7ac817','xk'],
    ['belarus','6813b6d546e731854c7ac87a','by'],
    ['newzealand','6813b6d546e731854c7ac880','nz'],
    ['armenia','6813b6d546e731854c7ac8d4','am'],
    ['saudiarabia','6813b6d546e731854c7ac8cb','sa'],
    ['tajikistan','6813b6d546e731854c7ac8c8','tj'],
    ['kuwait','6813b6d546e731854c7ac8e0','kw'],
    ['nicaragua','6813b6d546e731854c7ac8af','ni'],
    ['georgia','683ddd2c24b5a2e114af15bf','ge'],
    ['cambodia','683ddd2c24b5a2e114af15c9','kh'],
    ['malaysia','683ddd2c24b5a2e114af15d9','my'],
    ['oman','683ddd2c24b5a2e114af15fd','om'],
    ['mali','6873d0ea1758b40e712b5ee9','ml'],
    ['gabon','6873d0ea1758b40e712b5ef7','ga'],
    ['centralafrica','6873d0ea1758b40e712b5f2e','cf'],
    ['zimbabwe','6873d0ea1758b40e712b5f6d','zw'],
    ['drcongo','6873d0ea1758b40e712b5f28','cd'],
    ['france','6813b6d446e731854c7ac79a','fr'],
    ['japan','6813b6d546e731854c7ac81d','jp'],
    ['kazakhstan','6813b6d546e731854c7ac8ce','kz'],
    ['albania','6813b6d446e731854c7ac7f5','al'],
    ['argentina','6813b6d546e731854c7ac832','ar'],
    ['suriname','6813b6d546e731854c7ac8a0','sr'],
    ['eritrea','6873d0ea1758b40e712b5f19','er'],
    ['djibouti','6873d0ea1758b40e712b5f16','dj'],
    ['congo','6873d0ea1758b40e712b5f4c','cg'],
    ['liberia','6873d0ea1758b40e712b5f79','lr'],
    ['chad','6873d0ea1758b40e712b5f7c','td'],
    ['spain','6813b6d446e731854c7ac7a8','es'],
    ['croatia','6813b6d446e731854c7ac7bc','hr'],
    ['sweden','6813b6d446e731854c7ac7f2','se'],
    ['ecuador','6813b6d546e731854c7ac855','ec'],
    ['australia','6813b6d546e731854c7ac87d','au'],
    ['puertorico','6813b6d546e731854c7ac89c','pr'],
    ['turkmenistan','6813b6d546e731854c7ac8be','tm'],
    ['azerbaijan','6813b6d546e731854c7ac8d1','az'],
    ['montenegro','6813b6d546e731854c7ac814','me'],
    ['unitedarabemirates','683ddd2c24b5a2e114af15b5','ae'],
    ['somalia','683ddd2c24b5a2e114af1603','so'],
    ['mauritania','6873d0ea1758b40e712b5eed','mr'],
    ['sierraleone','6873d0ea1758b40e712b5f1f','sl'],
    ['andorra','687eab339142f76907295e4e','ad'],
    ['india','6813b6d546e731854c7ac862','in'],
    ['hungary','6813b6d446e731854c7ac7b2','hu'],
    ['romania','6813b6d446e731854c7ac7b6','ro'],
    ['brazil','6813b6d546e731854c7ac82f','br'],
    ['philippines','6813b6d546e731854c7ac82c','ph'],
    ['cyprus','6813b6d546e731854c7ac842','cy'],
    ['kenya','6813b6d546e731854c7ac86e','ke'],
    ['pakistan','6813b6d546e731854c7ac8da','pk'],
    ['mozambique','683ddd2c24b5a2e114af15db','mz'],
    ['nigeria','683ddd2c24b5a2e114af15fa','ng'],
    ['syria','683ddd2c24b5a2e114af1606','sy'],
    ['thailand','683ddd2c24b5a2e114af1609','th'],
    ['malawi','6873d0ea1758b40e712b5f46','mw'],
    ['unitedkingdom','6813b6d446e731854c7ac79e','uk'],
    ['bahamas','6813b6d546e731854c7ac889','bs'],
    ['serbia','6813b6d446e731854c7ac7ba','rs'],
    ['china','6813b6d546e731854c7ac820','cn'],
    ['russia','6813b6d546e731854c7ac868','ru'],
    ['jamaica','6813b6d546e731854c7ac899','jm'],
    ['elsalvador','6813b6d546e731854c7ac8b2','sv'],
    ['afghanistan','6813b6d546e731854c7ac8d7','af'],
    ['austria','6813b6d446e731854c7ac7ac','at'],
    ['ethiopia','683ddd2c24b5a2e114af15bd','et'],
    ['bhutan','683ddd2c24b5a2e114af15bb','bt'],
    ['israel','683ddd2c24b5a2e114af15c1','il'],
    ['palestine','683ddd2c24b5a2e114af1600','ps'],
    ['yemen','683ddd2c24b5a2e114af160f','ye'],
    ['cameroon','6873d0ea1758b40e712b5ef5','cm'],
    ['guinea','6873d0ea1758b40e712b5f2b','gn'],
    ['lesotho','6873d0ea1758b40e712b5f5c','ls'],
    ['eswatini','6873d0ea1758b40e712b5f59','sz'],
    ['vanuatu','6873d0ea1758b40e712b5f63','vu'],
    ['solomonislands','6873d0ea1758b40e712b5f60','sb'],
    ['nepal','6873d0ea1758b40e712b5f6a','np'],
    ['saotomeandprincipe','6873d0ea1758b40e712b5f76','st'],
    ['togo','6873d0ea1758b40e712b5f22','tg'],
    ['bahrain','687eab339142f76907295e50','bh'],
    ['netherlands','6813b6d446e731854c7ac7a0','nl'],
    ['belgium','6813b6d446e731854c7ac7a4','be'],
    ['estonia','6813b6d446e731854c7ac7e2','ee'],
    ['dominicanrepublic','6813b6d546e731854c7ac88d','do'],
    ['germany','6813b6d446e731854c7ac79c','de'],
    ['turkiye','6813b6d446e731854c7ac7eb','tr'],
    ['tunisia','6813b6d546e731854c7ac84e','tn'],
    ['ukraine','6813b6d546e731854c7ac865','ua'],
    ['guineabissau','6873d0ea1758b40e712b5f1c','gw'],
    ['vatican','69614d0e5d798a861630c58e','va'],
    ['comoros','696a81da63e2489f47e5a28a','km'],
    ['liechtenstein','696a81da63e2489f47e5a28c','li'],
    ['mauritius','696a81da63e2489f47e5a28e','mu'],
  ];
  const COUNTRY_NAMES = {
    ireland:'Ireland', bolivia:'Bolivia', singapore:'Singapore', switzerland:'Switzerland',
    taiwan:'Taiwan', trinidadandtobago:'Trinidad and Tobago', panama:'Panama', belize:'Belize',
    haiti:'Haiti', bangladesh:'Bangladesh', jordan:'Jordan', iceland:'Iceland',
    madagascar:'Madagascar', namibia:'Namibia', czechia:'Czechia', slovenia:'Slovenia',
    bulgaria:'Bulgaria', bosnia:'Bosnia', venezuela:'Venezuela', greenland:'Greenland',
    uzbekistan:'Uzbekistan', qatar:'Qatar', indonesia:'Indonesia', algeria:'Algeria',
    paraguay:'Paraguay', angola:'Angola', lebanon:'Lebanon', srilanka:'Sri Lanka',
    myanmar:'Myanmar', unitedkorea:'United Korea', gambia:'Gambia',
    equatorialguinea:'Equatorial Guinea', capeverde:'Cape Verde', brunei:'Brunei',
    easttimor:'East Timor', colombia:'Colombia', unitedstates:'United States', chile:'Chile',
    libya:'Libya', honduras:'Honduras', guatemala:'Guatemala', malta:'Malta', rwanda:'Rwanda',
    luxembourg:'Luxembourg', mexico:'Mexico', uruguay:'Uruguay', moldova:'Moldova',
    southsudan:'South Sudan', fiji:'Fiji', vietnam:'Vietnam', uganda:'Uganda',
    burkinafaso:'Burkina Faso', tanzania:'Tanzania', burundi:'Burundi',
    papuanewguinea:'Papua New Guinea', canada:'Canada', peru:'Peru', cuba:'Cuba',
    costarica:'Costa Rica', egypt:'Egypt', kyrgyzstan:'Kyrgyzstan', laos:'Laos',
    benin:'Benin', ivorycoast:'Ivory Coast', zambia:'Zambia', italy:'Italy', poland:'Poland',
    lithuania:'Lithuania', finland:'Finland', southkorea:'South Korea', greece:'Greece',
    sudan:'Sudan', guyana:'Guyana', iran:'Iran', slovakia:'Slovakia', iraq:'Iraq',
    mongolia:'Mongolia', southafrica:'South Africa', senegal:'Senegal', ghana:'Ghana',
    niger:'Niger', botswana:'Botswana', morocco:'Morocco', latvia:'Latvia',
    portugal:'Portugal', denmark:'Denmark', norway:'Norway', northmacedonia:'North Macedonia',
    kosovo:'Kosovo', belarus:'Belarus', newzealand:'New Zealand', armenia:'Armenia',
    saudiarabia:'Saudi Arabia', tajikistan:'Tajikistan', kuwait:'Kuwait',
    nicaragua:'Nicaragua', georgia:'Georgia', cambodia:'Cambodia', malaysia:'Malaysia',
    oman:'Oman', mali:'Mali', gabon:'Gabon', centralafrica:'Central Africa',
    zimbabwe:'Zimbabwe', drcongo:'DR Congo', france:'France', japan:'Japan',
    kazakhstan:'Kazakhstan', albania:'Albania', argentina:'Argentina', suriname:'Suriname',
    eritrea:'Eritrea', djibouti:'Djibouti', congo:'Congo', liberia:'Liberia', chad:'Chad',
    spain:'Spain', croatia:'Croatia', sweden:'Sweden', ecuador:'Ecuador',
    australia:'Australia', puertorico:'Puerto Rico', turkmenistan:'Turkmenistan',
    azerbaijan:'Azerbaijan', montenegro:'Montenegro',
    unitedarabemirates:'United Arab Emirates', somalia:'Somalia', mauritania:'Mauritania',
    sierraleone:'Sierra Leone', andorra:'Andorra', india:'India', hungary:'Hungary',
    romania:'Romania', brazil:'Brazil', philippines:'Philippines', cyprus:'Cyprus',
    kenya:'Kenya', pakistan:'Pakistan', mozambique:'Mozambique', nigeria:'Nigeria',
    syria:'Syria', thailand:'Thailand', malawi:'Malawi', unitedkingdom:'United Kingdom',
    bahamas:'Bahamas', serbia:'Serbia', china:'China', russia:'Russia', jamaica:'Jamaica',
    elsalvador:'El Salvador', afghanistan:'Afghanistan', austria:'Austria',
    ethiopia:'Ethiopia', bhutan:'Bhutan', israel:'Israel', palestine:'Palestine',
    yemen:'Yemen', cameroon:'Cameroon', guinea:'Guinea', lesotho:'Lesotho',
    eswatini:'Eswatini', vanuatu:'Vanuatu', solomonislands:'Solomon Islands', nepal:'Nepal',
    saotomeandprincipe:'São Tomé and Príncipe', togo:'Togo', bahrain:'Bahrain',
    netherlands:'Netherlands', belgium:'Belgium', estonia:'Estonia',
    dominicanrepublic:'Dominican Republic', germany:'Germany', turkiye:'Turkiye',
    tunisia:'Tunisia', ukraine:'Ukraine', guineabissau:'Guinea-Bissau', vatican:'Vatican',
    comoros:'Comoros', liechtenstein:'Liechtenstein', mauritius:'Mauritius',
  };
  const COUNTRIES = {};
  for (const [key, id, code] of COUNTRIES_RAW) {
    COUNTRIES[key] = { id, code, label: COUNTRY_NAMES[key] || key };
  }

  // Worker route that fires repository_dispatch (type: deal-config-submit)
  // with the GitHub PAT attached server-side. This route does not exist yet
  // on the warera-proxy Worker — it needs to be added there (mirroring the
  // existing /waitlist-update route) before "Propose a deal" will work.
  const DEAL_SUBMIT_URL = 'https://warera-proxy.r00ted82.workers.dev/deal-config-submit';

  // Paper "Send money to country" transfer tax — 50% (paper units) to
  // allies, 100% to everyone else. Same rule + lightweight live lookups
  // (ally list + paper market price) as js/irish-tax-partner.js; this is
  // NOT the heavy citizen/factory scan the "no live scanning" rule is
  // about, just two small calls, so it's fine on this static dashboard.
  const PAPER_RATE = { ally: 0.5, other: 1.0 };
  const td_trpc = (ep, inp) => trpc(ep, inp, { retry: true, timeoutMs: 20000 });

  async function loadPaper(homeCountryId) {
    const [home, ob] = await Promise.all([
      td_trpc('country.getCountryById', { countryId: homeCountryId }).catch(() => null),
      td_trpc('tradingOrder.getTopOrders', { itemCode: 'paper' }).catch(() => null),
    ]);
    const allies = new Set(Array.isArray(home?.allies) ? home.allies : []);
    let ask = Infinity;
    for (const o of (ob?.sellOrders || [])) if (typeof o.price === 'number' && o.price < ask) ask = o.price;
    return { allies, paperPrice: isFinite(ask) ? ask : null };
  }

  function paperFor(hostCountryId, amount, paper) {
    const ally = !!hostCountryId && paper.allies.has(hostCountryId);
    const rate = ally ? PAPER_RATE.ally : PAPER_RATE.other;
    const units = (amount || 0) * rate;
    const cost = paper.paperPrice != null ? units * paper.paperPrice : null;
    const net = cost != null ? (amount || 0) - cost : null;
    return { ally, rate, units, price: paper.paperPrice, cost, net };
  }

  const $gate       = document.getElementById('taxdeals-gate');
  const $gateForm   = document.getElementById('taxdeals-gate-form');
  const $homeSelect = document.getElementById('taxdeals-home-select');
  const $dealSelect = document.getElementById('taxdeals-deal-select');
  const $gatePw     = document.getElementById('taxdeals-gate-pw');
  const $gateError  = document.getElementById('taxdeals-gate-error');
  const $gateBtn    = document.getElementById('taxdeals-gate-submit');
  const $content    = document.getElementById('taxdeals-content');

  const $proposeToggle  = document.getElementById('taxdeals-propose-toggle');
  const $proposeForm    = document.getElementById('taxdeals-propose-form');
  const $proposeStatus  = document.getElementById('taxdeals-propose-status');
  const $proposeSubmit  = document.getElementById('taxdeals-propose-submit');

  let dealConfig = null;    // { version, deals: [...] } — fetched once
  let partnerAccess = null; // { version, passwords: { CODE: password } } — fetched once
  let unlockedDeal = null;  // the deal entry once unlocked

  /* ── One-time CSS (selects/number/date inputs inside .bo-gate-form don't
     get the input[type=password] styling, so match it explicitly) ──── */
  if (!document.getElementById('taxdeals-injected-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'taxdeals-injected-styles';
    styleEl.textContent = `
.bo-gate-form select,
.bo-gate-form input[type="text"],
.bo-gate-form input[type="number"],
.bo-gate-form input[type="date"] {
  width: 100%; text-align: center; font-size: 14px; padding: 10px 12px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); font-family: inherit;
}
.bo-gate-form select:disabled { opacity: 0.5; }
.taxdeals-propose { max-width: 420px; margin: 8px auto 24px; text-align: center; }
#taxdeals-propose-form.hidden { display: none; }
.taxdeals-country-field { position: relative; }
.taxdeals-report { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; margin-top: 14px; }
.taxdeals-report pre { font-family: inherit; font-size: 12.5px; white-space: pre-wrap;
  color: var(--text); margin: 0 0 10px; line-height: 1.6; }
.taxdeals-split { display: flex; gap: 10px; }
.taxdeals-split > div { flex: 1; }
`;
    document.head.appendChild(styleEl);
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(`${url}?t=${Math.floor(Date.now() / 30000)}`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /* ── Populate the two selects from deal_config.json ─────────────── */
  async function loadDealConfig() {
    if (dealConfig) return dealConfig;
    dealConfig = await fetchJson('data/tax/deal_config.json');
    return dealConfig;
  }

  // One password per HOST country (data/tax/partner_access.json) — the same
  // password that authorizes proposing a deal for that country also unlocks
  // viewing every deal where it's the host. No per-deal password anymore.
  async function loadPartnerAccess() {
    if (partnerAccess) return partnerAccess;
    partnerAccess = await fetchJson('data/tax/partner_access.json');
    return partnerAccess;
  }

  function countryPasswordFor(hostCode) {
    return partnerAccess?.passwords?.[hostCode];
  }

  function enabledDeals() {
    return (dealConfig?.deals || []).filter(d => d.enabled);
  }

  function populateHomeSelect() {
    const homes = new Map(); // code -> name
    for (const d of enabledDeals()) homes.set(d.homeCountry.code, d.homeCountry.name);
    $homeSelect.innerHTML = `<option value="" disabled selected>Home country…</option>` +
      [...homes.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => `<option value="${escapeHtml(code)}">${flagOf(code)} ${escapeHtml(name)}</option>`)
        .join('');
  }

  function populateDealSelect(homeCode) {
    const deals = enabledDeals().filter(d => d.homeCountry.code === homeCode);
    $dealSelect.disabled = deals.length === 0;
    $dealSelect.innerHTML = `<option value="" disabled selected>Deal…</option>` +
      deals.map(d => `<option value="${escapeHtml(d.id)}">${flagOf(d.hostCountry.code)} ${escapeHtml(d.name)}</option>`).join('');
  }

  $homeSelect.addEventListener('change', () => populateDealSelect($homeSelect.value));

  /* ── Settlement report text (copy-button target) ─────────────────── */
  function periodLabel(weekStart) {
    const start = new Date(`${weekStart}T00:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  function buildReport(dealLog) {
    const totals = dealLog.current_week?.totals || {};
    const home = dealLog.home_country.name;
    const host = dealLog.host_country.name;
    return [
      `${host} → ${home} Tax Rebate Settlement`,
      `Period: ${periodLabel(dealLog.current_week.week_start)}`,
      '',
      `Gross tax generated: ₿${money(totals.gross_tax)}`,
      `Manual rebate owed to ${home}: ₿${money(totals.manual_rebate_due)}`,
      `Automatic citizenship tax already handled by game: ₿${money(totals.auto_remit_tax)}`,
      `${host} retained: ₿${money(totals.host_retained)}`,
      '',
      `Please transfer: ₿${money(totals.manual_rebate_due)}`,
    ].join('\n');
  }

  /* ── Render ───────────────────────────────────────────────────────── */
  function renderDeal(dealLog, paper) {
    const days = dealLog.current_week?.days || [];
    const today = days.length ? days[days.length - 1].row : null;
    const weekTotals = dealLog.current_week?.totals || {};
    const prevTotals = dealLog.previous_week?.totals || null;
    const report = buildReport(dealLog);

    // Paper transfer tax on paying this week's rebate (see PAPER_RATE).
    // host_country.id is only present for "country" coverage deals logged
    // after this feature shipped — older/partial logs simply skip the block.
    const pWeek = dealLog.host_country.id
      ? paperFor(dealLog.host_country.id, weekTotals.manual_rebate_due, paper)
      : null;
    const paperBlock = pWeek ? `
      <div class="tax-audit-tot">
        <div class="tax-audit-h">📄 Paper transfer tax <span class="tax-ally ${pWeek.ally ? 'yes' : ''}">${pWeek.ally ? 'ally · 50%' : 'non-ally · 100%'}</span></div>
        <div class="tax-audit-row"><span>Paper price</span><b>${pWeek.price != null ? '₿' + money(pWeek.price) + '/unit' : '—'}</b></div>
        <div class="tax-audit-row"><span>Paper cost (this week)</span><b>${pWeek.cost != null ? '−₿' + money(pWeek.cost) : '—'}</b></div>
        <div class="tax-audit-row"><span>Paper required (this week)</span><b>${money(pWeek.units)} 📄</b></div>
        <div class="tax-audit-row big"><span>Net this week (after paper)</span><b>${pWeek.net != null ? '₿' + money(pWeek.net) : '—'}</b></div>
      </div>` : '';

    $content.innerHTML = `
      <div class="tax-src">📅 <span>Showing <strong>${escapeHtml(dealLog.host_country.name)}</strong> → <strong>${escapeHtml(dealLog.home_country.name)}</strong> under deal v${dealLog.deal_version}. Nothing about any other deal is shown here.</span></div>

      <div class="tax-cards">
        <div class="tax-card ok">
          <div class="tax-card-v">₿${money(today?.manual_rebate_due)}</div>
          <div class="tax-card-l">Today's rebate due<span>${days.length ? escapeHtml(days[days.length - 1].date) : 'no data yet'}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(weekTotals.manual_rebate_due)}</div>
          <div class="tax-card-l">This week's rebate due<span>since ${escapeHtml(dealLog.current_week.week_start)}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">${prevTotals ? '₿' + money(prevTotals.manual_rebate_due) : '—'}</div>
          <div class="tax-card-l">Previous week's rebate due<span>${dealLog.previous_week ? escapeHtml(dealLog.previous_week.week_start) : 'no prior week logged'}</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">₿${money(weekTotals.gross_tax)}</div>
          <div class="tax-card-l">Gross tax generated<span>this week</span></div>
        </div>
        <div class="tax-card">
          <div class="tax-card-v">${today?.workers ?? 0}</div>
          <div class="tax-card-l">Workers<span>${escapeHtml(dealLog.host_country.name)} factories, today</span></div>
        </div>
      </div>

      <div class="taxdeals-split">
        <div class="tax-audit-cat">
          <div class="tax-audit-h">${flagOf(dealLog.home_country.code)} ${escapeHtml(dealLog.home_country.name)} citizens <span class="tax-audit-rate">rebate ${(dealLog.home_citizen_rebate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${today?.home_workers ?? 0}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(today?.home_worker_tax)}</b></div>
        </div>
        <div class="tax-audit-cat">
          <div class="tax-audit-h">🌍 Non-${escapeHtml(dealLog.home_country.name)} citizens <span class="tax-audit-rate">rebate ${(dealLog.non_home_citizen_rebate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span></div>
          <div class="tax-audit-row"><span>Workers</span><b>${today?.partner_workers ?? 0}</b></div>
          <div class="tax-audit-row"><span>Gross tax</span><b>₿${money(today?.partner_worker_tax)}</b></div>
        </div>
      </div>

      ${paperBlock}

      <div class="taxdeals-report">
        <pre id="taxdeals-report-text">${escapeHtml(report)}</pre>
        <button id="taxdeals-report-copy" class="btn-primary">Copy settlement report</button>
        <span id="taxdeals-report-copied" class="tax-dim" style="margin-left:8px;"></span>
      </div>`;

    const $copyBtn = document.getElementById('taxdeals-report-copy');
    const $copied = document.getElementById('taxdeals-report-copied');
    $copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(report);
        $copied.textContent = 'Copied!';
      } catch {
        $copied.textContent = 'Copy failed — select the text above manually.';
      }
      setTimeout(() => { $copied.textContent = ''; }, 3000);
    });
  }

  async function renderUnlockedDeal() {
    $content.innerHTML = `<div class="status">Loading…</div>`;
    const dealLog = await fetchJson(`data/tax/deal_logs/${encodeURIComponent(unlockedDeal.id)}.json`);
    if (!dealLog) {
      $content.innerHTML = `<div class="status">No settlement data logged yet for this deal.</div>`;
      return;
    }
    // Best-effort: if the game API is unreachable, loadPaper() still
    // resolves (paperFor() just shows units with no cost/net).
    const paper = await loadPaper(dealLog.home_country.id);
    renderDeal(dealLog, paper);
  }

  /* ── Gate ─────────────────────────────────────────────────────────── */
  async function tryUnlock() {
    $gateBtn.disabled = true;
    $gateError.textContent = '';
    const dealId = $dealSelect.value;
    const pw = $gatePw.value;
    const deal = enabledDeals().find(d => d.id === dealId);
    const expectedPw = deal && countryPasswordFor(deal.hostCountry.code);
    if (!deal || !pw || !expectedPw || expectedPw !== pw) {
      $gateError.textContent = 'Incorrect selection or password.';
      $gatePw.select();
      $gateBtn.disabled = false;
      return;
    }
    unlockedDeal = deal;
    $gate.style.display = 'none';
    $gateBtn.disabled = false;
    await renderUnlockedDeal();
  }

  $gateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    tryUnlock();
  });

  /* ── Country name typeahead (same pattern as js/roster.js's Battle Intel
     country picker) — search matches the display name, pick from a
     dropdown, so partners never have to know/type an ISO code. ────── */
  function makeCountryPicker($search, $dropdown) {
    let selected = null;

    function search(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return Object.entries(COUNTRIES)
        .filter(([, c]) => c.label.toLowerCase().includes(q))
        .sort((a, b) => a[1].label.localeCompare(b[1].label))
        .slice(0, 8); // cap the dropdown so it never grows unwieldy
    }

    function render(matches) {
      if (!matches.length) { $dropdown.classList.add('hidden'); $dropdown.innerHTML = ''; return; }
      $dropdown.innerHTML = matches.map(([key, c]) => `
        <div class="rs-country-opt" data-key="${escapeHtml(key)}">
          <span class="rs-country-flag">${flagOf(c.code)}</span>
          <span>${escapeHtml(c.label)}</span>
        </div>`).join('');
      $dropdown.classList.remove('hidden');
    }

    $search.addEventListener('input', () => {
      selected = null; // typing again invalidates whatever was picked before
      render(search($search.value));
    });
    $search.addEventListener('focus', () => {
      if ($search.value.trim()) render(search($search.value));
    });
    $dropdown.addEventListener('click', (e) => {
      const opt = e.target.closest('.rs-country-opt');
      if (!opt) return;
      selected = COUNTRIES[opt.dataset.key];
      $search.value = selected.label;
      $dropdown.classList.add('hidden');
      $dropdown.innerHTML = '';
    });
    document.addEventListener('click', (e) => {
      if (!$dropdown.contains(e.target) && e.target !== $search) $dropdown.classList.add('hidden');
    });
    $search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $dropdown.classList.add('hidden'); $search.blur(); }
    });

    return {
      get selected() { return selected; },
      reset() { selected = null; $search.value = ''; $dropdown.classList.add('hidden'); $dropdown.innerHTML = ''; },
    };
  }

  const homePicker = makeCountryPicker(
    document.getElementById('taxdeals-propose-home-search'),
    document.getElementById('taxdeals-propose-home-dropdown'),
  );
  const hostPicker = makeCountryPicker(
    document.getElementById('taxdeals-propose-host-search'),
    document.getElementById('taxdeals-propose-host-dropdown'),
  );

  /* ── Propose a deal ───────────────────────────────────────────────── */
  $proposeToggle.addEventListener('click', () => {
    $proposeForm.classList.toggle('hidden');
  });

  $proposeForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!homePicker.selected || !hostPicker.selected) {
      $proposeStatus.style.color = 'var(--danger)';
      $proposeStatus.textContent = 'Pick both countries from the dropdown list.';
      return;
    }
    if (homePicker.selected.code === hostPicker.selected.code) {
      $proposeStatus.style.color = 'var(--danger)';
      $proposeStatus.textContent = 'Home and host country must be different.';
      return;
    }

    $proposeSubmit.disabled = true;
    $proposeStatus.textContent = 'Submitting…';
    $proposeStatus.style.color = '';

    const payload = {
      name: document.getElementById('taxdeals-propose-name').value.trim(),
      homeCountryCode: homePicker.selected.code.toUpperCase(),
      hostCountryCode: hostPicker.selected.code.toUpperCase(),
      // The host country's ONE password — proves the submitter actually
      // represents it (checked against data/tax/partner_access.json
      // server-side, deal-config-submit.yml). This same password is what
      // later unlocks viewing every deal for that country on this
      // dashboard; there's no separate per-deal password anymore.
      countryPassword: document.getElementById('taxdeals-propose-country-password').value,
      homeCitizenRebatePct: Number(document.getElementById('taxdeals-propose-home-rebate').value),
      nonHomeCitizenRebatePct: Number(document.getElementById('taxdeals-propose-non-rebate').value),
      startDate: document.getElementById('taxdeals-propose-start').value,
    };

    try {
      // Flat payload — same convention as js/buddy-finder.js's
      // dispatchWaitlistUpdate(). The Worker wraps this into GitHub's
      // { event_type, client_payload } shape server-side before firing the
      // repository_dispatch; the client never touches that envelope.
      const res = await fetch(DEAL_SUBMIT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      $proposeStatus.style.color = 'var(--accent)';
      $proposeStatus.textContent = 'Submitted — pending manual review before it starts logging.';
      $proposeForm.reset();
      homePicker.reset();
      hostPicker.reset();
    } catch (err) {
      $proposeStatus.textContent = `Could not submit (${err.message}). Try again later.`;
    } finally {
      $proposeSubmit.disabled = false;
    }
  });

  return {
    async activate() {
      await Promise.all([loadDealConfig(), loadPartnerAccess()]);
      populateHomeSelect();
      if (unlockedDeal) { renderUnlockedDeal(); return; } // DOM persists across nav; just refresh.
      $gate.style.display = '';
      $dealSelect.innerHTML = `<option value="" disabled selected>Deal…</option>`;
      $dealSelect.disabled = true;
      $gatePw.value = '';
      $gateError.textContent = '';
    },
  };
})();
