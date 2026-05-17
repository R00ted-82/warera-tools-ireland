/* ═══════════════════════════════════════════════════════════════════
 *  IRISH MILITARY UNITS
 * ═══════════════════════════════════════════════════════════════════ */
const MUTool = (() => {
  const IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe';
  const PAGE_LIMIT = 100;

  const REQUIRE_IRISH_COUNTRY = true;
  const MU_COUNTRY_FIELDS = ['countryId', 'country', 'nationalityId', 'nationality'];
  const EXCLUDED_MU_IDS = [
    '6955c186b1fc6d0b7b00fadc',
  ];

  const FILTER_STATES = ['all', 'open', 'full'];

  // ── Skill classification ─────────────────────────────────────────
  // Skill names from https://warera.wiki/skills. Loot Chance is
  // "special" and doesn't belong in either bucket, so it's omitted.
  //
  // PURITY_THRESHOLD controls how skewed a player's allocation must
  // be to count as a pure eco or pure war specialist. Anything in
  // the middle band is tagged 'mixed'. At 0.6, the 40-60% range
  // counts as mixed; bump higher for stricter purity (fewer pure
  // labels, more mixed), lower for looser (more pure labels).
  //
  // The classifier reads user.skills off whatever user objects are
  // already coming back from getUsersByCountry / getUserLite. No
  // extra API calls. If those endpoints don't carry skills, the
  // classifier returns null and no tag renders (we log one sample
  // object the first time this happens so you can see the shape).
  const PURITY_THRESHOLD = 0.6;
  const ECO_SKILLS = new Set([
    'energy', 'companies', 'entrepreneurship', 'production',
  ]);
  const WAR_SKILLS = new Set([
    'health', 'hunger', 'attack', 'precision',
    'critChance', 'critDamage', 'armor', 'dodge',
  ]);

  function classifyUser(userData) {
    const skills = userData?.skills;
    if (!skills || typeof skills !== 'object') return null;

    let eco = 0, war = 0;
    for (const [key, val] of Object.entries(skills)) {
      // Accept either a raw number or a wrapper like {level: N}.
      let n;
      if (typeof val === 'number') n = val;
      else if (val && typeof val === 'object') {
        n = Number(val.level ?? val.value ?? val.points ?? 0);
      } else n = Number(val);
      if (!isFinite(n) || n <= 0) continue;

      if      (ECO_SKILLS.has(key)) eco += n;
      else if (WAR_SKILLS.has(key)) war += n;
      // lootChance and any unknown keys are ignored.
    }

    const total = eco + war;
    if (total === 0) return null;
    const ecoShare = eco / total;
    if (ecoShare >= PURITY_THRESHOLD)     return 'eco';
    if (ecoShare <= 1 - PURITY_THRESHOLD) return 'war';
    return 'mixed';
  }

  const $grid    = document.getElementById('mu-grid');
  const $filter  = document.getElementById('mu-filter');
  const $refresh = document.getElementById('mu-refresh');
  const steps    = makeSteps(document.getElementById('mu-steps'));
  const setStatus = makeStatus(document.getElementById('mu-status'));

  let allMUs = [];
  let irishIdsGlobal = new Set();
  const userNames = {};
  const userSkillType = {};   // id -> 'eco' | 'war' | 'mixed' | null
  let loadStarted = false;
  let filterState = 'all';

  // One-shot diagnostic. If the classifier returns null but the user
  // object actually had a skills field, the field shape is something
  // we didn't expect — log a sample so it's easy to inspect.
  let _unknownShapeLogged = false;
  function recordSkills(userId, userData) {
    if (!userId || !userData || userId in userSkillType) return;
    const verdict = classifyUser(userData);
    userSkillType[userId] = verdict;
    if (!_unknownShapeLogged && verdict === null && userData.skills) {
      console.log('[MU] unexpected user.skills shape — sample:', userData.skills);
      _unknownShapeLogged = true;
    }
  }

  const idOf          = m => m?._id ?? null;
  const nameOf        = m => m?.name ?? '(no name)';
  const avatarOf      = m => m?.avatarUrl ?? null;
  const dormsOf       = m => m?.activeUpgradeLevels?.dormitories ?? null;
  const hqOf          = m => m?.activeUpgradeLevels?.headquarters ?? null;
  const ownerOf       = m => m?.user ?? null;
  const membersOf     = m => Array.isArray(m?.members) ? m.members : null;
  const memberCountOf = m => membersOf(m)?.length ?? 0;
  const weeklyDmgOf   = m => m?.rankings?.muWeeklyDamages?.value ?? null;
  const wealthOf      = m => m?.rankings?.muWealth?.value ?? null;

  function countryOf(mu) {
    for (const f of MU_COUNTRY_FIELDS) {
      if (mu?.[f] != null) return mu[f];
    }
    return null;
  }
  const memberIdOf = u => typeof u === 'string' ? u : (u?._id ?? null);

  function countIrishMembers(mu, irishIds) {
    const members = membersOf(mu) || [];
    return members.filter(u => irishIds.has(memberIdOf(u))).length;
  }

  // MUs without dormitory data have unknown capacity, so they appear under
  // 'all' only. Neither 'open' nor 'full' can be claimed honestly.
  function filterMatch(mu) {
    if (filterState === 'all') return true;
    const cap = capacityOf(mu);
    if (cap == null) return false;
    const used = memberCountOf(mu);
    if (filterState === 'full') return used >= cap;
    if (filterState === 'open') return used <  cap;
    return true;
  }

  async function fetchAllMUs() {
    const out = [];
    const seen = new Set();
    let cursor;
    let safety = 0;
    while (safety++ < 200) {
      const input = { limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await trpc('mu.getManyPaginated', input, { timeoutMs: 20000 });
      const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      let added = 0;
      for (const item of items) {
        const id = idOf(item);
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(item);
          added++;
        }
      }
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || items.length === 0 || added === 0) break;
      cursor = next;
      steps.setStep(1, 'active', { sub: `${out.length} loaded so far…` });
    }
    return out;
  }

  async function fetchIrishUserIds() {
    const ids = new Set();
    let cursor;
    let safety = 0;
    while (safety++ < 200) {
      const input = { countryId: IRELAND_COUNTRY_ID, limit: PAGE_LIMIT };
      if (cursor) input.cursor = cursor;
      const page = await trpc('user.getUsersByCountry', input, { timeoutMs: 20000 });
      const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
      for (const u of items) {
        if (u?._id) {
          ids.add(u._id);
          if (u.username) userNames[u._id] = u.username;
          recordSkills(u._id, u);
        }
      }
      steps.setStep(2, 'active', { sub: `${ids.size} citizens found so far…` });
      const next = page?.nextCursor ?? page?.cursor ?? null;
      if (!next || items.length === 0) break;
      cursor = next;
    }
    return ids;
  }

  async function resolveUserNames(idArr) {
    const unknown = [...new Set(idArr)].filter(id => id && !userNames[id]);
    const concurrency = 20;
    for (let i = 0; i < unknown.length; i += concurrency) {
      const batch = unknown.slice(i, i + concurrency);
      await Promise.all(batch.map(async id => {
        try {
          const u = await trpc('user.getUserLite', { userId: id }, { timeoutMs: 20000 });
          if (u?.username) userNames[id] = u.username;
          recordSkills(id, u);
        } catch {}
      }));
      const done = Math.min(i + concurrency, unknown.length);
      steps.setStep(3, 'active', { sub: `${done} of ${unknown.length} resolved…` });
    }
  }

  function avatarEl(mu) {
    const src = avatarOf(mu);
    const initial = (nameOf(mu).slice(0,1) || '?').toUpperCase();
    if (src && /^https?:\/\//.test(src)) {
      return `<img class="mu-avatar" src="${escapeHtml(src)}" alt="" data-initial="${escapeHtml(initial)}" onerror="var d=document.createElement('div');d.className='mu-avatar';d.textContent=this.dataset.initial;this.replaceWith(d)">`;
    }
    return `<div class="mu-avatar">${escapeHtml(initial)}</div>`;
  }
  function capacityOf(mu) {
    const dorms = dormsOf(mu);
    return dorms != null ? dorms * 5 : null;
  }
  function capacityBadge(mu) {
    const cap = capacityOf(mu);
    if (cap == null) return '';
    const used = memberCountOf(mu);
    if (used >= cap) return `<span class="badge full">Full</span>`;
    return `<span class="badge">${cap - used} open</span>`;
  }
  function statsBlock(mu) {
    const total = memberCountOf(mu);
    const irish = mu._irishMembers ?? 0;
    const irishStr = total > 0 ? `${irish} / ${total}` : '—';
    const irishCls = (total > 0 && irish < total) ? ' warn' : '';

    const candidates = [
      ['Members',    capacityOf(mu) != null ? `${total} / ${capacityOf(mu)}` : total],
      ['Irish',      irishStr, irishCls],
      ['Dorms',      dormsOf(mu) ?? '—'],
      ['HQ',         hqOf(mu) ?? '—'],
      ['Weekly Dmg', fmtNum(weeklyDmgOf(mu)) ?? '—'],
      ['Wealth',     fmtNum(wealthOf(mu)) ?? '—'],
      ['Created',    formatDate(mu?.createdAt) ?? '—'],
    ];
    return `<div class="stats">${
      candidates.map(([k, v, cls = '']) =>
        `<div class="stat"><div class="k">${escapeHtml(k)}</div><div class="v${cls}">${escapeHtml(String(v))}</div></div>`
      ).join('')
    }</div>`;
  }
  function skillTagHtml(type) {
    if (!type) return '';
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    return `<span class="skill-tag skill-${type}" title="Skill allocation: ${label}">${label}</span>`;
  }
  function membersBlock(mu) {
    const arr = membersOf(mu);
    if (!arr || !arr.length) return '';
    const commanders = new Set(mu?.roles?.commanders || []);
    return `
      <div class="members" data-open="false">
        <div class="m-head" onclick="this.parentNode.dataset.open = this.parentNode.dataset.open === 'true' ? 'false' : 'true'">
          <span><span class="arrow">▶</span> Members (${arr.length})</span>
        </div>
        <ul>${arr.map(u => {
          const id = memberIdOf(u);
          const name = userNames[id] ?? id ?? '';
          const isIrish = irishIdsGlobal.has(id);
          const flagSpan = isIrish ? '<span class="flag" title="Irish">🇮🇪</span>' : '<span class="flag" title="Non-Irish">🌍</span>';
          const commanderTag = commanders.has(id) ? '<span class="role">Commander</span>' : '';
          const skillTag = skillTagHtml(userSkillType[id]);
          const cls = isIrish ? '' : ' class="foreign"';
          return `<li${cls}>${flagSpan}<span>${escapeHtml(String(name))}</span>${skillTag}${commanderTag}</li>`;
        }).join('')}</ul>
      </div>
    `;
  }
  function renderCard(mu) {
    const id = idOf(mu);
    const link = id
      ? `<a class="game-link" href="${GAME_BASE}/mu/${escapeHtml(id)}" target="_blank" rel="noopener" title="Open in game"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
      : '';
    return `
      <div class="mu-card">
        <div class="card-head">
          ${avatarEl(mu)}
          <div class="card-title">
            <h3>${escapeHtml(nameOf(mu))}${link}</h3>
            ${capacityBadge(mu)}
          </div>
        </div>
        ${statsBlock(mu)}
        ${membersBlock(mu)}
      </div>
    `;
  }

  function emptyMessage() {
    if (!allMUs.length) return 'No Irish MUs found.';
    if (filterState === 'open') return `None of the ${allMUs.length} Irish MUs have free slots right now.`;
    if (filterState === 'full') return `None of the ${allMUs.length} Irish MUs are currently full.`;
    return 'No Irish MUs found.';
  }
  function statusMessage(count) {
    if (filterState === 'open') return `${count} of ${allMUs.length} MUs have free slots`;
    if (filterState === 'full') return `${count} of ${allMUs.length} MUs are full`;
    return `${count} Irish MUs`;
  }

  function render() {
    const filtered = allMUs.filter(filterMatch);
    if (!filtered.length) {
      $grid.innerHTML = '';
      setStatus(emptyMessage());
      return;
    }
    filtered.sort((a, b) => {
      const wa = weeklyDmgOf(a) ?? 0;
      const wb = weeklyDmgOf(b) ?? 0;
      if (wa !== wb) return wb - wa;
      return memberCountOf(b) - memberCountOf(a);
    });
    $grid.innerHTML = filtered.map(renderCard).join('');
    setStatus(statusMessage(filtered.length));
  }

  function setFilter(state) {
    if (!FILTER_STATES.includes(state)) state = 'all';
    if (state === filterState) return;
    filterState = state;
    for (const btn of $filter.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('active', btn.dataset.muFilter === state);
    }
    if (allMUs.length) render();
  }

  async function load() {
    $refresh.disabled = true;
    $grid.innerHTML = '';
    setStatus('');
    steps.reset();
    try {
      steps.setStep(1, 'active', { sub: 'Starting…' });
      const muList = await fetchAllMUs();
      steps.setStep(1, 'done', { sub: '', count: `${muList.length} MUs` });

      steps.setStep(2, 'active', { sub: 'Starting…' });
      const irishIds = await fetchIrishUserIds();
      irishIdsGlobal = irishIds;

      let droppedCountry = 0, droppedMembers = 0, droppedExcluded = 0;
      const ownerIrish = muList.filter(mu => irishIds.has(ownerOf(mu)));
      allMUs = ownerIrish.filter(mu => {
        if (EXCLUDED_MU_IDS.includes(idOf(mu))) { droppedExcluded++; return false; }
        if (REQUIRE_IRISH_COUNTRY) {
          const c = countryOf(mu);
          if (c != null && c !== IRELAND_COUNTRY_ID) { droppedCountry++; return false; }
        }
        const members = membersOf(mu) || [];
        if (members.length > 0) {
          const irish = countIrishMembers(mu, irishIds);
          if ((irish / members.length) < 0.5) { droppedMembers++; return false; }
        }
        return true;
      }).map(mu => {
        mu._irishMembers = countIrishMembers(mu, irishIds);
        return mu;
      });

      console.log(
        `[filter] ${muList.length} total → ${ownerIrish.length} Irish-owned → ${allMUs.length} kept ` +
        `(dropped: ${droppedCountry} foreign country, ${droppedMembers} non-Irish membership, ${droppedExcluded} blacklisted)`
      );

      steps.setStep(2, 'done', { sub: '', count: `${irishIds.size} citizens · ${allMUs.length} Irish MUs` });

      const memberIds = new Set();
      for (const mu of allMUs) {
        const owner = ownerOf(mu);
        if (owner) memberIds.add(owner);
        (membersOf(mu) || []).forEach(u => {
          const id = memberIdOf(u);
          if (id) memberIds.add(id);
        });
      }
      if (memberIds.size > 0) {
        steps.setStep(3, 'active', { sub: `0 of ${memberIds.size} resolved…` });
        await resolveUserNames([...memberIds]);
        steps.setStep(3, 'done', { sub: '', count: `${memberIds.size} usernames` });
      } else {
        steps.setStep(3, 'done', { sub: '', count: 'no users to resolve' });
      }

      render();
      steps.fadeOut();
    } catch (e) {
      steps.markActiveAsError(e.message);
      setStatus(`Error: ${e.message}`, true);
    } finally {
      $refresh.disabled = false;
    }
  }

  $filter.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setFilter(btn.dataset.muFilter);
  });
  $refresh.addEventListener('click', load);

  return {
    /**
     * Called by the router every time this view becomes active. Idempotent:
     * the data load is kicked off exactly once. Later activations only
     * re-apply URL params (currently just ?filter=).
     * @param {URLSearchParams} [params]
     */
    activate(params) {
      const filterParam = params?.get('filter');
      if (filterParam) setFilter(filterParam);
      if (!loadStarted) {
        loadStarted = true;
        load();
      }
    }
  };
})();