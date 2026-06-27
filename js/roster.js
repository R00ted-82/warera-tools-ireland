/* ═══════════════════════════════════════════════════════════════════
 *  ROSTER (#roster)
 *
 *  Country citizens list with build, pill (buff/debuff) status, health,
 *  hunger, MU and last-online time. Sortable columns + filters.
 *  Useful for war planning. Unlisted by design.
 *
 *  Loads automatically on open. Country is parametrised (default Ireland)
 *  so adding another country later is a CONFIG change, not a rewrite —
 *  see the COUNTRIES map below.
 *
 *  Data sources (all via the gateway your trpc() helper points at):
 *    - user.getUsersByCountry (paginated) → list of citizens (_id, username, mu)
 *    - user.getUserById       (per citizen) → FULL profile: skills, dates, buffs
 *    - mu.getById             (per unique MU) → MU names
 *
 *  Why getUserById and not getUserLite:
 *    getUserById is a superset of Lite and is the ONLY place the pill
 *    (buff/debuff) data lives. Confirmed from the official docs
 *    (api2.warera.io/docs → user.getUserById, input { userId }).
 *
 *  Field shapes below are all confirmed against REAL responses, not
 *  guessed. Citations are in the comments next to each reader.
 * ═══════════════════════════════════════════════════════════════════ */
const RosterTool = (() => {
  const PAGE_LIMIT = 100;

  /* ── Country config ───────────────────────────────────────────────
   * Full list extracted from a real country.getAllCountries response
   * (DevTools capture on warera.io). Validated against the existing
   * IRELAND_COUNTRY_ID global — match confirmed exact, so this data is
   * trustworthy. `code` is the 2-letter country code, used to derive the
   * flag emoji (see flagEmoji()) — never hand-picked per country.
   * The roster reads the active country from the route
   * (#roster?country=<key>); default below. */
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
  // Official display names (exactly as the game shows them), keyed by
  // the same key used above. Kept separate from COUNTRIES_RAW purely for
  // readability — this list is what users actually see/search.
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
  const DEFAULT_COUNTRY = 'ireland';

  // Converts a 2-letter country code (e.g. "ie") into its flag emoji
  // (🇮🇪) — mechanical Unicode conversion (each letter maps to a
  // "regional indicator symbol"), not a per-country lookup table, so it
  // can't drift out of sync with the code list. Tested against every
  // code actually in COUNTRIES_RAW, including "uk" and "xk" (Kosovo,
  // no strict ISO-3166 entry) — both render correctly via this scheme.
  // Fallback only fires for malformed/missing input.
  function flagEmoji(code) {
    if (!code || code.length !== 2) return '🏳️';
    const cc = code.toUpperCase();
    const base = 0x1F1E6; // regional indicator 'A'
    const chars = [...cc].map(c => {
      const off = c.charCodeAt(0) - 65; // 'A' = 0
      if (off < 0 || off > 25) return null;
      return String.fromCodePoint(base + off);
    });
    if (chars.includes(null)) return '🏳️';
    return chars.join('');
  }

  // Skill buckets — same definitions as the war detector bot, so the
  // build labels on the roster agree with what the bot uses internally.
  const COMBAT_SKILLS = ['attack','precision','dodge','armor','lootChance',
                          'criticalChance','criticalDamages','health'];
  const ECO_SKILLS    = ['companies','entrepreneurship','production','management'];

  const COMBAT_THRESHOLD = 70;   // combat % of (combat+economy) skill levels
  const ECO_THRESHOLD    = 30;
  // Sort ordering for the Build column (higher = more combat-leaning).
  const BUILD_ORDER = { combat: 3, mixed: 2, economy: 1, unknown: 0 };

  const ONLINE_FRESH = 24;   // < 24h ago → fresh (green, table cell colour)
  const ONLINE_STALE = 72;   // < 72h ago → stale (amber), else dead (red)

  // Last-online FILTER buckets — separate from the colour bands above,
  // since the filter uses finer/different cutoffs than the cell colouring.
  // Four exclusive bands covering everyone, including never-connected
  // players (who fall into 'over10').
  const ONLINE_FILTER_BANDS = [
    { key: 'under1',  label: '< 1 hour',  maxHours: 1 },
    { key: 'under4',  label: '< 4 hours', maxHours: 4 },
    { key: 'under10', label: '< 10 hours', maxHours: 10 },
    { key: 'over10',  label: '> 10 hours', maxHours: Infinity },
  ];
  function onlineFilterBucket(hoursAgo) {
    if (hoursAgo == null) return 'over10';
    for (const band of ONLINE_FILTER_BANDS) {
      if (hoursAgo < band.maxHours) return band.key;
    }
    return 'over10';
  }

  const BAR_LOW  = 50;       // health/hunger % bands for colour
  const BAR_CRIT = 25;

  /* ── DOM ──────────────────────────────────────────────────────────
   * #roster-content and #roster-status are the existing required hooks.
   * #roster-country-search / #roster-country-dropdown are the new
   * country picker (replaces the old dead #roster-username/#roster-load).
   * #roster-title is the per-country <h2> ("🇮🇪 Irish Roster" etc.) that
   * this file now updates dynamically — it sits BELOW the static
   * "Battle Intel Ireland" <h1> banner, which this file never touches. */
  const $status   = document.getElementById('roster-status');
  const $content  = document.getElementById('roster-content');
  const $search   = document.getElementById('roster-country-search');
  const $dropdown = document.getElementById('roster-country-dropdown');
  const $title    = document.getElementById('roster-title');

  /* ── State ────────────────────────────────────────────────────────── */
  let countryKey = DEFAULT_COUNTRY;
  let allRows    = [];        // built once per load, then filtered/sorted in place
  let muInfo     = {};
  let sortKey    = 'level';
  let sortDir    = 'desc';
  let filters    = freshFilters();
  let running    = false;

  /* ═══════════════════════════════════════════════════════════════════
   *  COUNTRY PICKER
   *  Typeahead over the 180-country list. Search matches the official
   *  display name (case-insensitive substring) — typing "bra" matches
   *  "Brazil". Selecting a result updates the URL (same #roster?country=
   *  pattern the old single-country version already used), updates the
   *  page title, and reloads the roster for that country.
   * ═══════════════════════════════════════════════════════════════════ */
  function updateTitle(key) {
    if (!$title) return;
    const c = COUNTRIES[key] || COUNTRIES[DEFAULT_COUNTRY];
    $title.textContent = `${flagEmoji(c.code)} ${c.label} Roster`;
  }

  function searchCountries(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.entries(COUNTRIES)
      .filter(([, c]) => c.label.toLowerCase().includes(q))
      .sort((a, b) => a[1].label.localeCompare(b[1].label))
      .slice(0, 8); // cap the dropdown so it never grows unwieldy
  }

  function renderDropdown(matches) {
    if (!$dropdown) return;
    if (!matches.length) { $dropdown.classList.add('hidden'); $dropdown.innerHTML = ''; return; }
    $dropdown.innerHTML = matches.map(([key, c]) => `
      <div class="rs-country-opt" data-key="${escapeHtml(key)}">
        <span class="rs-country-flag">${flagEmoji(c.code)}</span>
        <span>${escapeHtml(c.label)}</span>
      </div>`).join('');
    $dropdown.classList.remove('hidden');
  }

  function selectCountry(key) {
    if (!COUNTRIES[key] || key === countryKey) {
      // Still close the dropdown even if re-picking the same country —
      // otherwise it looks like the click did nothing.
      if ($dropdown) { $dropdown.classList.add('hidden'); $dropdown.innerHTML = ''; }
      if ($search) $search.value = '';
      return;
    }
    countryKey = key;
    try { history.replaceState(null, '', `#roster?country=${encodeURIComponent(countryKey)}`); } catch {}
    updateTitle(countryKey);
    if ($search) $search.value = '';
    if ($dropdown) { $dropdown.classList.add('hidden'); $dropdown.innerHTML = ''; }
    run();
  }

  function wireCountryPicker() {
    if (!$search) return; // HTML not updated yet on this page — degrade silently
    $search.addEventListener('input', () => {
      renderDropdown(searchCountries($search.value));
    });
    $search.addEventListener('focus', () => {
      if ($search.value.trim()) renderDropdown(searchCountries($search.value));
    });
    document.addEventListener('click', (e) => {
      if ($dropdown && !$dropdown.contains(e.target) && e.target !== $search) {
        $dropdown.classList.add('hidden');
      }
    });
    if ($dropdown) {
      $dropdown.addEventListener('click', (e) => {
        const opt = e.target.closest('.rs-country-opt');
        if (opt) selectCountry(opt.dataset.key);
      });
    }
    $search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { $dropdown?.classList.add('hidden'); $search.blur(); }
    });
  }

  function freshFilters() {
    return { mu: 'all', build: 'all', pill: 'all',
             healthBelow: 'all', hungerBelow: 'all', online: 'all' };
  }

  const rs_trpc = (ep, input) => trpc(ep, input, { retry: true });

  /* ── Status helper ────────────────────────────────────────────────── */
  function setStatus(text, isError = false) {
    if (!$status) return;
    if (!text) { $status.classList.add('hidden'); return; }
    $status.textContent = text;
    $status.classList.toggle('error', isError);
    $status.classList.remove('hidden');
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  PURE LOGIC  (no DOM, no globals — unit-tested against real captures)
   * ═══════════════════════════════════════════════════════════════════ */

  // Skill level = skills.<name>.level (confirmed: getUserLite/getUserById
  // example responses). Read ONLY .level — the old code read .total first,
  // which on skills.health is the health *bar* total (e.g. 100), wrongly
  // inflating the combat score so everyone classified as combat.
  function skillLevel(user, skill) {
    const lvl = user?.skills?.[skill]?.level;
    return (typeof lvl === 'number' && isFinite(lvl)) ? lvl : 0;
  }

  function classifyBuild(user) {
    const combat = COMBAT_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    const eco    = ECO_SKILLS.reduce((s, k) => s + skillLevel(user, k), 0);
    if (combat + eco === 0) return { kind: 'unknown', ratio: null };
    const ratio = (combat / (combat + eco)) * 100;
    if (ratio >= COMBAT_THRESHOLD) return { kind: 'combat',  ratio };
    if (ratio <= ECO_THRESHOLD)    return { kind: 'economy', ratio };
    return { kind: 'mixed', ratio };
  }

  // Health / hunger live UNDER skills as { currentBarValue, total }
  // (confirmed: getUserLite/getUserById responses). Returns
  // { pct, cur, label } or null if absent. `cur` (raw points) is kept
  // separate from `pct` because each player's `total` (cap) differs with
  // their hunger/health skill level — sorting by % would rank a small-cap
  // player who's "full" (e.g. 4/4) above a bigger-cap player who isn't
  // (e.g. 6/7), which is backwards for war-planning purposes. Sort by
  // raw points (`cur`); use `pct` only for the bar's visual fill width.
  function statBar(user, key) {
    const s = user?.skills?.[key];
    if (!s || typeof s !== 'object') return null;
    const cur = s.currentBarValue, max = s.total;
    if (typeof cur !== 'number' || typeof max !== 'number' || max <= 0) return null;
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    return { pct, cur, label: `${Math.round(cur)} / ${Math.round(max)}` };
  }

  // Buffs and debuffs are SEPARATE named fields inside the `buffs` object:
  //   buff   → buffs.buffCodes  (array) + buffs.buffEndAt   (ISO)
  //            confirmed from KyleTheTank's getUserById response
  //   debuff → buffs.debuffCodes(array) + buffs.debuffEndAt (ISO)
  //            confirmed from RevanEire's  getUserById response
  // NB: the same code (e.g. "cocain") can be a buff OR a debuff depending
  // which field it's in — so good/bad comes from the FIELD, never the code.
  // We return the raw timestamp; "is it active right now" is decided at
  // render time against the current clock (keeps this function deterministic).
  function parseEffects(user) {
    const b = user?.buffs;
    const grab = (codesKey, endKey) => {
      if (!b) return null;
      const codes = b[codesKey];
      const endStr = b[endKey];
      if (!Array.isArray(codes) || codes.length === 0 || !endStr) return null;
      const until = new Date(endStr).getTime();
      if (!isFinite(until)) return null;
      return { codes, until };
    };
    return {
      buff:   grab('buffCodes',   'buffEndAt'),
      debuff: grab('debuffCodes', 'debuffEndAt'),
    };
  }

  function effectActive(eff, now) {
    return !!eff && eff.until > now;
  }

  function onlineKind(hoursAgo) {
    if (hoursAgo == null) return 'dead';
    if (hoursAgo < ONLINE_FRESH) return 'fresh';
    if (hoursAgo < ONLINE_STALE) return 'stale';
    return 'dead';
  }

  // Turn a raw (list + full profile merged) citizen into a display row.
  // Computes everything once so filter/sort never recompute classify/parse.
  function buildRow(c) {
    const lastIso = c?.dates?.lastConnectionAt;          // confirmed: dates.lastConnectionAt
    const lastMs  = lastIso ? new Date(lastIso).getTime() : null;
    // rankings.weeklyUserDamages.value confirmed against RA3BURN's real
    // getUserById response (3,496,461 → matched the in-game "3.5M" card
    // exactly, including the #984 rank). Daily damage isn't a thing the
    // game tracks/shows, so weekly is the figure we're using.
    const weeklyDmg = c?.rankings?.weeklyUserDamages?.value;
    return {
      raw:          c,
      _id:          c._id,
      username:     c.username || c._id,
      avatarUrl:    c.avatarUrl || null,                   // confirmed: RA3BURN's getUserById capture
      mu:           c.mu || null,                          // from getUsersByCountry
      level:        c?.leveling?.level ?? null,            // confirmed: leveling.level
      build:        classifyBuild(c),
      health:       statBar(c, 'health'),
      hunger:       statBar(c, 'hunger'),
      effects:      parseEffects(c),
      weeklyDamage: (typeof weeklyDmg === 'number' && isFinite(weeklyDmg)) ? weeklyDmg : null,
      lastConnMs:   (lastMs != null && isFinite(lastMs)) ? lastMs : null,
    };
  }

  // Pill column has its own comparator (not a simple numeric key) because
  // buff and debuff must stay as two separate, non-interleaved groups:
  //
  //   asc  -> all BUFFED  (high time left -> low),
  //           then all DEBUFFED (low time left -> high)
  //   desc -> all DEBUFFED (high time left -> low),
  //           then all BUFFED  (low time left -> high)
  //   un-pilled players always last, in both directions.
  //
  // A single numeric key can't express "group A counts down, then group B
  // counts back up", so this compares rows directly instead of going
  // through the generic compareRows() number-flip path.
  function pillGroup(effects, now) {
    if (effectActive(effects.buff, now))   return 'buff';
    if (effectActive(effects.debuff, now)) return 'debuff';
    return 'none';
  }
  function pillRemainingMs(effects, now) {
    if (effectActive(effects.buff, now))   return effects.buff.until - now;
    if (effectActive(effects.debuff, now)) return effects.debuff.until - now;
    return null;
  }
  function comparePill(a, b, dir, now) {
    const ga = pillGroup(a.effects, now), gb = pillGroup(b.effects, now);
    if (ga === 'none' && gb === 'none') return 0;
    if (ga === 'none') return 1;     // un-pilled always sinks to the bottom
    if (gb === 'none') return -1;

    const leadGroup = dir === 'asc' ? 'buff' : 'debuff'; // which group goes first
    if (ga !== gb) return ga === leadGroup ? -1 : 1;

    // Same group: leading group counts DOWN (high->low), trailing group
    // counts back UP (low->high).
    const ra = pillRemainingMs(a.effects, now), rb = pillRemainingMs(b.effects, now);
    return ga === leadGroup ? (rb - ra) : (ra - rb);
  }

  const SORTERS = {
    name:    (r) => (r.username || '').toLowerCase(),
    level:   (r) => r.level ?? -1,
    build:   (r) => BUILD_ORDER[r.build.kind] ?? -1,
    health:  (r) => r.health ? r.health.cur : -1,
    hunger:  (r) => r.hunger ? r.hunger.cur : -1,
    weekly:  (r) => r.weeklyDamage ?? -1,
    online:  (r) => r.lastConnMs ?? -Infinity,
    mu:      (r, ctx) => (ctx.muInfo[r.mu]?.name || '').toLowerCase(),
  };

  function compareRows(a, b, key, dir, ctx) {
    if (key === 'pill') return comparePill(a, b, dir, ctx.now);   // bespoke: see comparePill
    const va = SORTERS[key](a, ctx), vb = SORTERS[key](b, ctx);
    let c;
    if (typeof va === 'string' || typeof vb === 'string') {
      c = String(va).localeCompare(String(vb));
    } else {
      c = va < vb ? -1 : va > vb ? 1 : 0;
    }
    return dir === 'asc' ? c : -c;
  }

  // All filters AND together. now is needed for pill/online (time-based).
  function matchesFilters(row, f, now) {
    if (f.mu !== 'all' && row.mu !== f.mu) return false;

    if (f.build !== 'all' && row.build.kind !== f.build) return false;

    if (f.pill !== 'all') {
      const hasBuff   = effectActive(row.effects.buff, now);
      const hasDebuff = effectActive(row.effects.debuff, now);
      if (f.pill === 'buffed'   && !hasBuff)               return false;
      if (f.pill === 'debuffed' && !hasDebuff)             return false;
      if (f.pill === 'clean'    && (hasBuff || hasDebuff)) return false;
    }

    if (f.healthBelow !== 'all') {
      const thr = Number(f.healthBelow);
      if (!row.health || row.health.pct >= thr) return false;
    }
    if (f.hungerBelow !== 'all') {
      const thr = Number(f.hungerBelow);
      if (!row.hunger || row.hunger.pct >= thr) return false;
    }

    if (f.online !== 'all') {
      const hoursAgo = row.lastConnMs == null ? null : (now - row.lastConnMs) / 3600000;
      if (onlineFilterBucket(hoursAgo) !== f.online) return false;
    }
    return true;
  }

  /* ── Formatting helpers ───────────────────────────────────────────── */
  function fmtAgoHours(hoursAgo) {
    if (hoursAgo == null || !isFinite(hoursAgo)) return 'never';
    if (hoursAgo < 1) return 'just now';
    if (hoursAgo < 24) return `${Math.floor(hoursAgo)}h ago`;
    return `${Math.floor(hoursAgo / 24)}d ago`;
  }

  function fmtRemaining(ms) {
    if (ms <= 0) return '0m';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  CONCURRENCY + DATA FETCHERS
   * ═══════════════════════════════════════════════════════════════════ */
  async function mapConcurrent(items, worker, concurrency = 20) {
    const out = new Array(items.length); let i = 0;
    async function pump() {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); }
        catch { out[idx] = null; }
      }
    }
    await Promise.all(Array(Math.min(concurrency, items.length || 1)).fill(0).map(pump));
    return out;
  }

  async function fetchAllCitizens(countryId) {
    const items = [];
    let cursor = null, safety = 0;
    while (safety++ < 200) {
      const input = { countryId, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await rs_trpc('user.getUsersByCountry', input);
      const arr = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      items.push(...arr);
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || arr.length === 0) break;
      cursor = next;
    }
    return items;
  }

  // Hydrate each citizen with the FULL profile (getUserById). The gateway
  // batches these (400ms window) and caches them (~5 min), so repeated
  // loads in a short window mostly don't hit the game API at all.
  async function fetchFullProfiles(citizens) {
    return mapConcurrent(citizens, async (c) => {
      try {
        const full = await rs_trpc('user.getUserById', { userId: c._id });
        return full ? { ...c, ...full } : c;
      } catch { return c; }
    });
  }

  async function fetchMuNames(citizens) {
    const muIds = [...new Set(citizens.map(c => c.mu).filter(Boolean))];
    const info = {};
    await mapConcurrent(muIds, async (id) => {
      try {
        const mu = await rs_trpc('mu.getById', { muId: id });
        // avatarUrl confirmed: same field name as users, also present on
        // mu.getById per the MU tool's avatarOf(). Same call as before —
        // we were already fetching this object just to read .name.
        if (mu?.name) info[id] = { name: mu.name, avatarUrl: mu.avatarUrl || null };
      } catch {}
    }, 10);
    return info;
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  ICONS
   *  Small inline SVGs (no icon font / CDN dependency — none is loaded
   *  on the site, so these are hand-sized to match: 12-13px, 1.6 stroke,
   *  currentColor so they pick up the surrounding chip's text colour
   *  (which is already a CSS variable, so dark/light both just work).
   * ═══════════════════════════════════════════════════════════════════ */
  const ICONS = {
    // Real game icons — captured via Inspect Element directly off WarEra's
    // own profile pages (not redrawn/approximated). buff = mdi-pill,
    // debuff = mdi-pill-off (same base shape + a diagonal strike). Both use
    // fill="currentColor" with a solid path, matching the source exactly —
    // unlike our other hand-drawn stroke icons. Colour still comes from the
    // surrounding .rs-buff/.rs-debuff CSS class, same as before.
    arrowUp:  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M4.22,11.29L11.29,4.22C13.64,1.88 17.43,1.88 19.78,4.22C22.12,6.56 22.12,10.36 19.78,12.71L12.71,19.78C10.36,22.12 6.56,22.12 4.22,19.78C1.88,17.43 1.88,13.64 4.22,11.29M5.64,12.71C4.59,13.75 4.24,15.24 4.6,16.57L10.59,10.59L14.83,14.83L18.36,11.29C19.93,9.73 19.93,7.2 18.36,5.64C16.8,4.07 14.27,4.07 12.71,5.64L5.64,12.71Z"/></svg>',
    arrowDown:'<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M22.11 21.46L2.39 1.73L1.11 3L6.81 8.7L4.22 11.29C1.88 13.64 1.88 17.43 4.22 19.78C6.56 22.12 10.36 22.12 12.71 19.78L15.39 17.19L20.84 22.73L22.11 21.46M4.6 16.57C4.24 15.24 4.59 13.5 5.64 12.71L8.23 10.12L9.64 11.53L4.6 16.57M10.78 7.58L9.36 6.16L11.29 4.22C13.64 1.88 17.43 1.88 19.78 4.22C22.12 6.56 22.12 10.36 19.78 12.71L17.85 14.65L16.43 13.23L18.36 11.29C19.93 7.2 18.36 5.64C16.8 4.07 14.27 4.07 12.71 5.64L10.78 7.58Z"/></svg>',
    sword:    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="19" x2="19" y2="5"/><polyline points="13 5 19 5 19 11"/><line x1="19" y1="19" x2="5" y2="5"/><polyline points="11 5 5 5 5 11"/></svg>',
    coin:     '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M9.5 9.5c0-1.2 1-2 2.5-2s2.5.8 2.5 2-1 1.6-2.5 2.5-2.5 1.3-2.5 2.5 1 2 2.5 2 2.5-.8 2.5-2"/></svg>',
    overlap:  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="12" r="6.5"/><circle cx="14.5" cy="12" r="6.5"/></svg>',
  };

  /* ═══════════════════════════════════════════════════════════════════
   *  RENDERING
   * ═══════════════════════════════════════════════════════════════════ */
  function renderBar(stat) {
    if (!stat) return '<span class="rs-bar-val">–</span>';
    let cls = '';
    if (stat.pct <= BAR_CRIT) cls = 'crit';
    else if (stat.pct <= BAR_LOW) cls = 'low';
    return `<span class="rs-bar ${cls}"><i style="width:${stat.pct.toFixed(0)}%"></i></span>
            <span class="rs-bar-val">${escapeHtml(stat.label)}</span>`;
  }

  function renderBuild(build) {
    const labels = { combat: 'War Mode', economy: 'Economy', mixed: 'Mixed', unknown: '–' };
    const icon   = { combat: ICONS.sword, economy: ICONS.coin, mixed: ICONS.overlap, unknown: '' };
    const tooltip = build.ratio != null
      ? `${build.ratio.toFixed(0)}% combat skills`
      : 'Too few skill points to classify';
    return `<span class="rs-build ${build.kind}" title="${tooltip}">${icon[build.kind]}${labels[build.kind]}</span>`;
  }

  // Pill cell shows any ACTIVE buff and/or debuff with time left. Labelled
  // generically ("Pill" / "Debuff") rather than the raw code (e.g. "cocain")
  // per request — the underlying code is still in the title tooltip in case
  // it's ever useful, just not in the visible chip text.
  // A player can never hold both at once (confirmed), but the buff/debuff
  // branches stay independent rather than else-if, since that's a true
  // fact about the GAME, not something to hardcode as a code invariant.
  function renderPill(effects, now) {
    const out = [];
    if (effectActive(effects.buff, now)) {
      const codes = effects.buff.codes.map(escapeHtml).join(', ');
      out.push(`<span class="rs-eff rs-buff" title="${codes}">${ICONS.arrowUp}Pill · ${fmtRemaining(effects.buff.until - now)}</span>`);
    }
    if (effectActive(effects.debuff, now)) {
      const codes = effects.debuff.codes.map(escapeHtml).join(', ');
      out.push(`<span class="rs-eff rs-debuff" title="${codes}">${ICONS.arrowDown}Debuff · ${fmtRemaining(effects.debuff.until - now)}</span>`);
    }
    if (!out.length) return `<span class="rs-eff rs-none">–</span>`;
    return out.join(' ');
  }

  // Mirrors the MU tool's own avatarEl() exactly: validate the URL, fall
  // back to the MU's first initial. Uses the swap-to-sibling-div pattern
  // (rather than the buddy finder's textContent-swap) since that's how
  // the MU tool itself — the actual authority on MU avatars — handles it.
  function renderMuAvatar(name, avatarUrl) {
    const initial = (name || '?').slice(0, 1).toUpperCase();
    if (avatarUrl && /^https?:\/\//.test(avatarUrl)) {
      return `<img class="rs-mu-avatar" src="${escapeHtml(avatarUrl)}" alt="" data-initial="${escapeHtml(initial)}" onerror="var d=document.createElement('span');d.className='rs-mu-avatar';d.textContent=this.dataset.initial;this.replaceWith(d)">`;
    }
    return `<span class="rs-mu-avatar">${escapeHtml(initial)}</span>`;
  }

  function renderMu(row) {
    if (!row.mu) return `<span class="rs-mu rs-none">none</span>`;
    const info = muInfo[row.mu];
    const name = info?.name || 'unit';
    return `<span class="rs-mu">${renderMuAvatar(name, info?.avatarUrl)}<a href="${GAME_BASE}/mu/${escapeHtml(row.mu)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></span>`;
  }

  function renderOnline(row) {
    if (row.lastConnMs == null) return `<span class="rs-online dead">never</span>`;
    const hoursAgo = (Date.now() - row.lastConnMs) / 3600000;
    return `<span class="rs-online ${onlineKind(hoursAgo)}">${escapeHtml(fmtAgoHours(hoursAgo))}</span>`;
  }

  // Abbreviates like the game's own UI cards do. Confirmed against two real
  // captures: 3,496,461 -> game showed "3.5M"; 9,439,967 -> game showed
  // "9.44M". Both round to 3 significant figures with trailing zeros
  // trimmed (3.5 not 3.50; 9.44 not 9.440) — that's the rule this matches,
  // rather than a fixed decimal count, since the two examples have
  // different decimal lengths.
  function fmtAbbrev(n) {
    if (n == null || !isFinite(n)) return '–';
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    const round3sf = (v) => {
      if (v === 0) return '0';
      const digits = Math.max(0, 2 - Math.floor(Math.log10(v)));
      return (Math.round(v * 10 ** digits) / 10 ** digits).toString();
    };
    if (n >= 1e6) return sign + round3sf(n / 1e6) + 'M';
    if (n >= 1e3) return sign + round3sf(n / 1e3) + 'K';
    return sign + Math.round(n).toString();
  }

  // Number only, abbreviated to match the game's own display style
  // (e.g. "3.5M", "684K", "920") — no tier/rank badge, per request.
  function renderWeekly(row) {
    if (row.weeklyDamage == null) return `<span class="rs-online dead">–</span>`;
    return `<span title="${row.weeklyDamage.toLocaleString()}">${fmtAbbrev(row.weeklyDamage)}</span>`;
  }

  // Column definitions drive both the header (with sort arrows) and which
  // SORTERS key each click uses.
  const COLUMNS = [
    { key: 'name',   label: 'Player' },
    { key: 'level',  label: 'Lvl' },
    { key: 'build',  label: 'Build' },
    { key: 'pill',   label: 'Pill' },
    { key: 'health', label: 'Health' },
    { key: 'hunger', label: 'Hunger' },
    { key: 'weekly', label: 'Weekly dmg' },
    { key: 'mu',     label: 'MU' },
    { key: 'online', label: 'Last online' },
  ];

  function renderHeader() {
    return COLUMNS.map(col => {
      const active = col.key === sortKey;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
      return `<th class="rs-th${active ? ' active' : ''}" data-sort="${col.key}"
                  role="button" tabindex="0" aria-sort="${ariaSort}">${escapeHtml(col.label)}${arrow}</th>`;
    }).join('');
  }

  function renderSummary(shownRows, now) {
    let combat = 0, economy = 0, mixed = 0, unknown = 0, buffed = 0, debuffed = 0;
    let healthSum = 0, healthN = 0, hungerSum = 0, hungerN = 0;
    for (const r of shownRows) {
      if (r.build.kind === 'combat') combat++;
      else if (r.build.kind === 'economy') economy++;
      else if (r.build.kind === 'mixed') mixed++;
      else unknown++;
      if (effectActive(r.effects.buff, now)) buffed++;
      if (effectActive(r.effects.debuff, now)) debuffed++;
      // Average is over players who HAVE a health/hunger reading — not
      // shownRows.length — so a few missing/unparseable profiles don't
      // silently drag the average down.
      if (r.health) { healthSum += r.health.pct; healthN++; }
      if (r.hunger) { hungerSum += r.hunger.pct; hungerN++; }
    }
    const filtered = shownRows.length !== allRows.length;
    const avgHealth = healthN ? Math.round(healthSum / healthN) : null;
    const avgHunger = hungerN ? Math.round(hungerSum / hungerN) : null;
    return `
      <div class="rs-summary">
        <span><strong>${shownRows.length}</strong>${filtered ? ` of ${allRows.length}` : ''} shown</span>
        <span><strong>${combat}</strong> war mode</span>
        <span><strong>${economy}</strong> economy</span>
        <span><strong>${mixed}</strong> mixed</span>
        ${unknown ? `<span><strong>${unknown}</strong> too new</span>` : ''}
        <span><strong>${buffed}</strong> buffed</span>
        <span><strong>${debuffed}</strong> debuffed</span>
        <span>avg health <strong>${avgHealth != null ? avgHealth + '%' : '–'}</strong></span>
        <span>avg hunger <strong>${avgHunger != null ? avgHunger + '%' : '–'}</strong></span>
      </div>`;
  }

  // Mirrors the buddy finder's renderPlayer avatar pattern exactly:
  // validate avatarUrl looks like a real http(s) URL, fall back to the
  // player's first initial in a coloured box if it's missing or 404s.
  function renderAvatar(row) {
    const initial = (row.username || '?').slice(0, 1).toUpperCase();
    const src = row.avatarUrl;
    if (src && /^https?:\/\//.test(src)) {
      return `<span class="rs-avatar"><img src="${escapeHtml(src)}" alt="" onerror="this.parentElement.textContent='${escapeHtml(initial)}'"></span>`;
    }
    return `<span class="rs-avatar">${escapeHtml(initial)}</span>`;
  }

  function renderRows(rows, now) {
    if (!rows.length) {
      return `<tr><td colspan="${COLUMNS.length}" class="rs-empty">No players match these filters.</td></tr>`;
    }
    return rows.map(r => `
      <tr>
        <td class="rs-name">${renderAvatar(r)}<a href="${GAME_BASE}/user/${escapeHtml(r._id)}" target="_blank" rel="noopener">${escapeHtml(r.username)}</a></td>
        <td class="rs-lvl">${r.level ?? '–'}</td>
        <td>${renderBuild(r.build)}</td>
        <td>${renderPill(r.effects, now)}</td>
        <td>${renderBar(r.health)}</td>
        <td>${renderBar(r.hunger)}</td>
        <td>${renderWeekly(r)}</td>
        <td>${renderMu(r)}</td>
        <td>${renderOnline(r)}</td>
      </tr>`).join('');
  }

  // Build the filter controls (rendered ONCE per load; values reflect state).
  function renderControls() {
    const muOptions = Object.keys(muInfo)
      .map(id => ({ id, name: muInfo[id].name }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(o => `<option value="${escapeHtml(o.id)}"${filters.mu === o.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`)
      .join('');

    const sel = (cur, val) => cur === val ? ' selected' : '';

    return `
      <div class="rs-controls">
        <label class="rs-filter">MU
          <select data-filter="mu">
            <option value="all"${sel(filters.mu,'all')}>All</option>
            ${muOptions}
          </select>
        </label>
        <label class="rs-filter">Build
          <select data-filter="build">
            <option value="all"${sel(filters.build,'all')}>All</option>
            <option value="combat"${sel(filters.build,'combat')}>War Mode</option>
            <option value="economy"${sel(filters.build,'economy')}>Economy</option>
            <option value="mixed"${sel(filters.build,'mixed')}>Mixed</option>
          </select>
        </label>
        <label class="rs-filter">Pill
          <select data-filter="pill">
            <option value="all"${sel(filters.pill,'all')}>All</option>
            <option value="buffed"${sel(filters.pill,'buffed')}>Buffed</option>
            <option value="debuffed"${sel(filters.pill,'debuffed')}>Debuffed</option>
            <option value="clean"${sel(filters.pill,'clean')}>No pill</option>
          </select>
        </label>
        <label class="rs-filter">Health
          <select data-filter="healthBelow">
            <option value="all"${sel(filters.healthBelow,'all')}>Any</option>
            <option value="50"${sel(filters.healthBelow,'50')}>Below 50%</option>
            <option value="25"${sel(filters.healthBelow,'25')}>Below 25%</option>
          </select>
        </label>
        <label class="rs-filter">Hunger
          <select data-filter="hungerBelow">
            <option value="all"${sel(filters.hungerBelow,'all')}>Any</option>
            <option value="50"${sel(filters.hungerBelow,'50')}>Below 50%</option>
            <option value="25"${sel(filters.hungerBelow,'25')}>Below 25%</option>
          </select>
        </label>
        <label class="rs-filter">Online
          <select data-filter="online">
            <option value="all"${sel(filters.online,'all')}>Any</option>
            ${ONLINE_FILTER_BANDS.map(b =>
              `<option value="${b.key}"${sel(filters.online,b.key)}>${escapeHtml(b.label)}</option>`
            ).join('')}
          </select>
        </label>
        <button type="button" class="rs-clear" data-clear>Clear filters</button>
      </div>
      <div class="rs-summary-host"></div>
      <div class="rs-table-host"></div>`;
  }

  // Re-render summary + table for the current filters/sort. Controls are
  // left untouched so dropdowns keep focus/value.
  function applyView() {
    const now = Date.now();
    const ctx = { now, muInfo };
    const shown = allRows.filter(r => matchesFilters(r, filters, now));
    shown.sort((a, b) => compareRows(a, b, sortKey, sortDir, ctx));

    const summaryHost = $content.querySelector('.rs-summary-host');
    const tableHost   = $content.querySelector('.rs-table-host');
    if (summaryHost) summaryHost.innerHTML = renderSummary(shown, now);
    if (tableHost) {
      tableHost.innerHTML = `
        <div class="rs-table-wrap">
          <table class="rs-table">
            <thead><tr>${renderHeader()}</tr></thead>
            <tbody>${renderRows(shown, now)}</tbody>
          </table>
        </div>`;
    }
  }

  /* ── Event wiring (delegated; bound once per load) ────────────────── */
  function wireControls() {
    // Filter dropdowns.
    $content.querySelectorAll('[data-filter]').forEach(el => {
      el.addEventListener('change', () => {
        filters[el.dataset.filter] = el.value;
        applyView();
      });
    });
    // Clear button.
    const clear = $content.querySelector('[data-clear]');
    if (clear) clear.addEventListener('click', () => {
      filters = freshFilters();
      $content.querySelectorAll('[data-filter]').forEach(el => { el.value = 'all'; });
      applyView();
    });
    // Sort headers (delegated on the table host, since the table re-renders).
    const tableHost = $content.querySelector('.rs-table-host');
    if (tableHost) {
      const onSort = (key) => {
        if (!key) return;
        if (key === sortKey) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortKey = key; sortDir = (key === 'name' || key === 'mu') ? 'asc' : 'desc'; }
        applyView();
      };
      tableHost.addEventListener('click', (e) => {
        const th = e.target.closest('[data-sort]');
        if (th) onSort(th.dataset.sort);
      });
      tableHost.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const th = e.target.closest('[data-sort]');
        if (th) { e.preventDefault(); onSort(th.dataset.sort); }
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   *  ORCHESTRATION
   * ═══════════════════════════════════════════════════════════════════ */
  async function run() {
    if (running) return;
    const country = COUNTRIES[countryKey] || COUNTRIES[DEFAULT_COUNTRY];
    updateTitle(countryKey);

    running = true;
    setStatus('');
    $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading ${escapeHtml(country.label)} citizens…</div>`;

    try {
      const citizens = await fetchAllCitizens(country.id);
      if (!citizens.length) {
        $content.innerHTML = `<div class="rs-empty">No citizens returned. The data service may be down — try again in a minute.</div>`;
        return;
      }

      $content.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span>Loading ${citizens.length} player profiles…</div>`;
      const hydrated = await fetchFullProfiles(citizens);

      muInfo = await fetchMuNames(hydrated);
      allRows = hydrated.map(buildRow);

      // Reset view state for the fresh dataset.
      filters = freshFilters();
      sortKey = 'level'; sortDir = 'desc';

      $content.innerHTML = renderControls();
      wireControls();
      applyView();
    } catch (e) {
      $content.innerHTML = '';
      const friendly = (typeof isTransientError === 'function' && isTransientError(e))
        ? `The data server is having a moment (${e.message}). Wait a few seconds and try again.`
        : e.message;
      setStatus(friendly, true);
    } finally {
      running = false;
    }
  }

  /* ── Public API ───────────────────────────────────────────────────── */
  let pickerWired = false;
  return {
    // Loads on open. Reads #roster?country=<key>; defaults to Ireland.
    activate(params) {
      if (!pickerWired) { wireCountryPicker(); pickerWired = true; }
      const get = (k) => (params && params.get && params.get(k))
        || new URLSearchParams(location.search).get(k);
      const c = (get('country') || DEFAULT_COUNTRY).toLowerCase();
      countryKey = COUNTRIES[c] ? c : DEFAULT_COUNTRY;
      try { history.replaceState(null, '', `#roster?country=${encodeURIComponent(countryKey)}`); } catch {}
      run();
    },
  };
})();