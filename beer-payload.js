(function(){
  "use strict";

  // ── Inject the tool body into the portal mounts ───────────────────
  // Header and footer are dropped (the umbrella supplies them). The
  // last-updated note goes into the tool-header controls slot; the
  // controls + results + modal go into #beer-content.
  var mount = document.getElementById("beer-content");
  if(!mount) return;
  var ctrlSlot = document.getElementById("beer-controls");
  if(ctrlSlot){
    ctrlSlot.innerHTML = '<span id="last-updated" class="beer-updated"></span>';
  }
  mount.innerHTML = [
    '<div class="controls">',
      '<div class="row">',
        '<label class="search">',
          '<span class="mag">&#128269;</span>',
          '<input id="q" type="text" placeholder="Search a region or country (e.g. Southern Finland, Germany)" autocomplete="off" spellcheck="false" />',
        '</label>',
        '<select id="country-add"><option value="">+ Add country</option></select>',
      '</div>',
      '<div class="country-chips" id="country-chips"></div>',
      '<div class="toggles">',
        '<label class="chip"><input type="checkbox" id="f-bunker" /> Has bunker</label>',
        '<label class="chip"><input type="checkbox" id="f-online" /> Bunker online</label>',
        '<label class="chip"><input type="checkbox" id="f-occupied" /> Occupied</label>',
        '<label class="chip"><input type="checkbox" id="f-upcoming" /> Upcoming activation</label>',
        '<span class="chip seg" id="match-seg" title="Which country a region matches the filter on">',
          '<button data-match="either" class="on">Owner or holder</button>',
          '<button data-match="owner">Owner</button>',
          '<button data-match="holder">Holder</button>',
        '</span>',
      '</div>',
    '</div>',
    '<div id="loading" class="loading">Loading region data...</div>',
    '<div id="content" class="hidden">',
      '<div id="upcoming-wrap">',
        '<div class="panel-title">&#9203; Upcoming activations <span class="count" id="upcoming-count"></span></div>',
        '<div class="grid upcoming" id="upcoming"></div>',
      '</div>',
      '<div class="panel-title">&#128205; Regions <span class="count" id="results-count"></span></div>',
      '<div class="grid" id="results"></div>',
      '<div id="results-empty" class="empty hidden">',
        '<div class="big">&#128270;</div>',
        '<div>No regions match. Try a different search or clear the filters.</div>',
      '</div>',
    '</div>',
    '<div class="ov" id="ov"><div class="modal" id="modal"></div></div>'
  ].join("");

  // ── Original Bunker Monitor logic (unchanged) ─────────────────────

  // Where the committed data lives. Relative path resolves to the
  // umbrella repo's data/ folder.
  var DATA_BASE = "data/";
  // Base URL for in-game region links. Adjust if the live URL differs.
  var GAME_BASE = "https://app.warera.io";

  var FLAG_ALIAS = { uk:"gb" };
  var COUNTRY = {
    de:"Germany", no:"Norway", se:"Sweden", fi:"Finland", ie:"Ireland",
    uk:"United Kingdom", pt:"Portugal", dk:"Denmark", be:"Belgium", nl:"Netherlands",
    fr:"France", es:"Spain", it:"Italy", pl:"Poland", cz:"Czechia", at:"Austria",
    ch:"Switzerland", lu:"Luxembourg", ru:"Russia", ua:"Ukraine", by:"Belarus",
    md:"Moldova", ge:"Georgia", am:"Armenia", az:"Azerbaijan", tr:"Turkey",
    gr:"Greece", ro:"Romania", hu:"Hungary", sk:"Slovakia", lt:"Lithuania",
    lv:"Latvia", ee:"Estonia", is:"Iceland", mt:"Malta", cy:"Cyprus", ba:"Bosnia",
    hr:"Croatia", si:"Slovenia", rs:"Serbia", mk:"N. Macedonia", al:"Albania",
    bg:"Bulgaria", me:"Montenegro", xk:"Kosovo", ad:"Andorra", li:"Liechtenstein",
    va:"Vatican City", ma:"Morocco", tn:"Tunisia", ly:"Libya", dz:"Algeria",
    eg:"Egypt", sd:"Sudan", ss:"South Sudan", et:"Ethiopia", er:"Eritrea",
    dj:"Djibouti", so:"Somalia", ke:"Kenya", tz:"Tanzania", ug:"Uganda",
    rw:"Rwanda", bi:"Burundi", cd:"DR Congo", cg:"Congo", cf:"Central Africa",
    cm:"Cameroon", ga:"Gabon", gq:"Eq. Guinea", td:"Chad", ne:"Niger",
    ng:"Nigeria", ml:"Mali", mr:"Mauritania", sn:"Senegal", gm:"Gambia",
    gw:"Guinea-Bissau", gn:"Guinea", sl:"Sierra Leone", lr:"Liberia",
    ci:"Cote d Ivoire", gh:"Ghana", tg:"Togo", bj:"Benin", bf:"Burkina Faso",
    cv:"Cape Verde", st:"Sao Tome", za:"South Africa", na:"Namibia", bw:"Botswana",
    zw:"Zimbabwe", zm:"Zambia", mw:"Malawi", mz:"Mozambique", mg:"Madagascar",
    km:"Comoros", mu:"Mauritius", sz:"Eswatini", ls:"Lesotho", ao:"Angola",
    il:"Israel", ps:"Palestine", lb:"Lebanon", sy:"Syria", iq:"Iraq", ir:"Iran",
    sa:"Saudi Arabia", jo:"Jordan", kw:"Kuwait", qa:"Qatar", bh:"Bahrain",
    ae:"UAE", om:"Oman", ye:"Yemen", kz:"Kazakhstan", uz:"Uzbekistan",
    tm:"Turkmenistan", kg:"Kyrgyzstan", tj:"Tajikistan", af:"Afghanistan",
    pk:"Pakistan", in:"India", bd:"Bangladesh", bt:"Bhutan", np:"Nepal",
    lk:"Sri Lanka", mm:"Myanmar", th:"Thailand", vn:"Vietnam", kh:"Cambodia",
    la:"Laos", my:"Malaysia", sg:"Singapore", id:"Indonesia", ph:"Philippines",
    bn:"Brunei", tl:"Timor-Leste", kp:"North Korea", kr:"South Korea", jp:"Japan",
    cn:"China", tw:"Taiwan", mn:"Mongolia", au:"Australia", nz:"New Zealand",
    pg:"Papua New Guinea", sb:"Solomon Is.", vu:"Vanuatu", fj:"Fiji",
    us:"USA", ca:"Canada", mx:"Mexico", gl:"Greenland", cu:"Cuba", bs:"Bahamas",
    do:"Dominican Rep.", ht:"Haiti", jm:"Jamaica", pr:"Puerto Rico", tt:"Trinidad",
    br:"Brazil", ar:"Argentina", cl:"Chile", pe:"Peru", co:"Colombia",
    ec:"Ecuador", ve:"Venezuela", bo:"Bolivia", py:"Paraguay", uy:"Uruguay",
    gy:"Guyana", sr:"Suriname", cr:"Costa Rica", pa:"Panama", ni:"Nicaragua",
    sv:"El Salvador", hn:"Honduras", gt:"Guatemala", bz:"Belize"
  };

  function flag(cc){
    if(!cc) return "\uD83C\uDFF3\uFE0F";
    cc = String(cc).toLowerCase();
    var code = FLAG_ALIAS[cc] || cc;
    if(code.length !== 2 || !/^[a-z]{2}$/.test(code)) return "\uD83C\uDFF3\uFE0F";
    return code.split("").map(function(ch){
      return String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 97);
    }).join("");
  }
  function cname(cc){
    if(!cc) return "Unknown";
    return COUNTRY[String(cc).toLowerCase()] || String(cc).toUpperCase();
  }
  function clabel(cc){ return flag(cc) + " " + cname(cc); }
  function gameUrl(rid){ return GAME_BASE + "/region/" + rid; }
  function capStar(r){
    return r.is_capital ? ' <span title="Capital">&#11088;</span>' : "";
  }

  function parseT(s){ if(!s) return null; var d = new Date(s); return isNaN(d) ? null : d; }
  function fmtLocal(s){
    var d = parseT(s); if(!d) return "";
    return d.toLocaleString(undefined,{
      weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"
    });
  }
  function relTime(s){
    var d = parseT(s); if(!d) return "";
    var diff = d.getTime() - Date.now();
    var future = diff >= 0;
    var m = Math.abs(diff)/60000;
    var out;
    if(m < 1) return "just now";
    if(m < 60) out = Math.round(m) + "m";
    else if(m < 1440) out = Math.floor(m/60) + "h " + Math.round(m%60) + "m";
    else out = Math.floor(m/1440) + "d " + Math.floor((m%1440)/60) + "h";
    return future ? "in " + out : out + " ago";
  }
  function tzName(){
    try{
      var parts = new Intl.DateTimeFormat(undefined,{timeZoneName:"short"})
        .formatToParts(new Date());
      var p = parts.find(function(x){ return x.type === "timeZoneName"; });
      return p ? p.value : "";
    }catch(e){ return ""; }
  }

  var EV = {
    came_online:       {c:"var(--green2)", t:"Came online"},
    went_offline:      {c:"var(--danger)", t:"Went offline"},
    level_changed:     {c:"var(--warn)",   t:"Level changed"},
    built:             {c:"var(--blue)",   t:"Bunker built"},
    destroyed:         {c:"var(--gray)",   t:"Bunker destroyed"},
    status_changed:    {c:"var(--teal)",   t:"Status changed"},
    bunker_activating: {c:"var(--indigo)", t:"Activation scheduled"},
    ownership_changed: {c:"var(--orange2)",t:"Changed hands"},
    battle_started:    {c:"var(--pink)",   t:"Battle started"},
    battle_ended:      {c:"var(--teal)",   t:"Battle ended"},
    resistance_full:   {c:"var(--crimson)",t:"Resistance full"}
  };
  function evDesc(e){
    switch(e.type){
      case "came_online":   return "Bunker now running at L" + e.to;
      case "went_offline":  return "Stopped running (was L" + e["from"] + ")";
      case "level_changed": return "Running level L" + e["from"] + " to L" + e.to;
      case "built":         return "New bunker at L" + (e.level || "?");
      case "destroyed":     return "Bunker removed (was L" + (e.level || "?") + ")";
      case "status_changed":return "Status " + e["from"] + " to " + e.to;
      case "bunker_activating":
        return "Scheduled to activate " + fmtLocal(e.active_at) +
               " (" + relTime(e.active_at) + ")" + (e.level ? ", L" + e.level : "");
      case "ownership_changed":
        return "From " + clabel(e["from"]) + " to " + clabel(e.to);
      case "battle_started": return "A battle began here";
      case "battle_ended":   return "The active battle ended";
      case "resistance_full":
        return "Resistance " + e.val + "/" + e.max + ", liberation battle available";
      default: return "Region state changed";
    }
  }

  var STATE = {};
  var EVENTS = [];
  var BY_RID = {};
  var REGION_LIST = [];
  var matchMode = "either";
  var selectedCountries = [];

  function esc(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }
  function occupied(r){
    var o = r.initial_country_code, c = r.country_code;
    return !!(o && c && o !== c);
  }
  function bunkerPills(r){
    var b = r.bunker || {};
    var out = [];
    if(b.built_status == null){
      out.push('<span class="pill none">No bunker</span>');
    } else {
      if(typeof b.running_level === "number")
        out.push('<span class="pill on">Online L' + b.running_level + '</span>');
      else
        out.push('<span class="pill off">Offline</span>');
      if(b.built_status === "active")
        out.push('<span class="pill on">active</span>');
      else if(b.built_status === "disabled")
        out.push('<span class="pill dis">disabled</span>');
      else if(b.built_status === "pending")
        out.push('<span class="pill pend">pending</span>');
      if(typeof b.built_level === "number")
        out.push('<span class="pill">built L' + b.built_level + '</span>');
    }
    return out.join("");
  }
  function futureActivation(r){
    var up = r.bunker_upgrade;
    if(!up || !up.will_be_active_at) return null;
    var d = parseT(up.will_be_active_at);
    if(!d || d.getTime() <= Date.now()) return null;
    return up;
  }
  function ctryHtml(r){
    var o = r.initial_country_code, c = r.country_code;
    if(occupied(r)){
      return clabel(o) + ' <span class="arrow">&rarr;</span> ' + clabel(c) +
             '<span class="occ-pill">occupied</span>';
    }
    return clabel(c || o);
  }
  function resHtml(r){
    var rs = r.resistance || {};
    var v = rs.value, m = rs.max;
    if(typeof v !== "number" || typeof m !== "number" || m <= 0) return "";
    var pct = Math.min(100, Math.round(v / m * 100));
    var owned = !occupied(r);
    return [
      '<div class="res">',
        '<div class="res-bar', (owned ? " owned" : ""), '">',
          '<i style="width:', pct, '%"></i>',
        '</div>',
        '<div class="res-meta"><span>resistance</span>',
        '<span>', Math.round(v), ' / ', m, ' (', pct, '%)</span></div>',
      '</div>'
    ].join("");
  }
  function regionCard(r){
    var n = (BY_RID[r.rid] || []).length;
    var evtxt = n ? (n + " event" + (n === 1 ? "" : "s") + " in 30 days")
                  : "No events logged yet";
    return [
      '<div class="rcard" data-rid="', r.rid, '">',
        '<div class="top"><div>',
          '<div class="rname">', esc(r.name || r.code || r.rid), capStar(r), '</div>',
          '<div class="rcode">', esc(r.code || ""), '</div>',
        '</div>',
        '<a class="rgame" href="', gameUrl(r.rid), '" target="_blank" rel="noopener" title="Open in War Era">&#8599;</a>',
        '</div>',
        '<div class="ctry">', ctryHtml(r), '</div>',
        '<div class="status-line">', bunkerPills(r), '</div>',
        resHtml(r),
        '<div class="evcount">', evtxt, '</div>',
      '</div>'
    ].join("");
  }

  function matchesText(r, q){
    if(!q) return true;
    q = q.toLowerCase();
    var f;
    if(matchMode === "owner"){
      f = [r.initial_country_code, cname(r.initial_country_code)];
    } else if(matchMode === "holder"){
      f = [r.country_code, cname(r.country_code)];
    } else {
      f = [r.name, r.code, r.country_code, cname(r.country_code),
           r.initial_country_code, cname(r.initial_country_code)];
    }
    return f.join(" ").toLowerCase().indexOf(q) !== -1;
  }
  function matchesCountry(r){
    if(!selectedCountries.length) return true;
    var o = r.initial_country_code, c = r.country_code;
    return selectedCountries.some(function(cc){
      if(matchMode === "owner")  return o === cc;
      if(matchMode === "holder") return c === cc;
      return o === cc || c === cc;
    });
  }
  function anyFilterActive(){
    return !!(document.getElementById("q").value.trim() ||
              selectedCountries.length ||
              document.getElementById("f-bunker").checked ||
              document.getElementById("f-online").checked ||
              document.getElementById("f-occupied").checked ||
              document.getElementById("f-upcoming").checked);
  }
  function passesFilters(r){
    var q = document.getElementById("q").value.trim();
    if(!matchesText(r, q)) return false;
    if(!matchesCountry(r)) return false;
    var b = r.bunker || {};
    if(document.getElementById("f-bunker").checked && b.built_status == null) return false;
    if(document.getElementById("f-online").checked && typeof b.running_level !== "number") return false;
    if(document.getElementById("f-occupied").checked && !occupied(r)) return false;
    if(document.getElementById("f-upcoming").checked && !futureActivation(r)) return false;
    return true;
  }
  function applyFilters(){
    var list = REGION_LIST.filter(passesFilters);
    var filtered = anyFilterActive();
    list.sort(function(a, b){
      var ea = (BY_RID[a.rid] || []).length, eb = (BY_RID[b.rid] || []).length;
      if(eb !== ea) return eb - ea;
      return (a.name || "").localeCompare(b.name || "");
    });
    var capped = filtered ? list : list.slice(0, 60);
    document.getElementById("results").innerHTML = capped.map(regionCard).join("");
    document.getElementById("results-empty").classList.toggle("hidden", capped.length > 0);
    var cnt = document.getElementById("results-count");
    if(!filtered) cnt.textContent = "showing 60 of " + list.length + ", search or filter to narrow";
    else cnt.textContent = list.length + " match" + (list.length === 1 ? "" : "es");
    renderUpcoming();
  }

  function renderUpcoming(){
    var ups = REGION_LIST
      .map(function(r){ var up = futureActivation(r); return up ? {r:r, up:up} : null; })
      .filter(function(x){ return x && passesFilters(x.r); })
      .sort(function(a, b){
        return parseT(a.up.will_be_active_at) - parseT(b.up.will_be_active_at);
      });

    var wrap = document.getElementById("upcoming-wrap");
    if(!ups.length){ wrap.classList.add("hidden"); return; }
    wrap.classList.remove("hidden");
    document.getElementById("upcoming-count").textContent = ups.length + " scheduled";
    document.getElementById("upcoming").innerHTML = ups.slice(0, 12).map(function(x){
      var r = x.r, t = x.up.will_be_active_at;
      var lvl = x.up.level ? " &middot; L" + x.up.level : "";
      return [
        '<div class="ucard" data-rid="', r.rid, '">',
          '<div>',
            '<div class="rname">', esc(r.name), '</div>',
            '<div class="ctry" style="margin-top:5px">', ctryHtml(r), '</div>',
          '</div>',
          '<div class="when">',
            '<div class="rel">', relTime(t), '</div>',
            '<div class="abs">', fmtLocal(t), lvl, '</div>',
          '</div>',
        '</div>'
      ].join("");
    }).join("");
  }

  function habitHtml(evs){
    var rel = evs.filter(function(e){
      return e.type === "came_online" || e.type === "went_offline" ||
             e.type === "level_changed" || e.type === "status_changed" ||
             e.type === "bunker_activating";
    });
    if(!rel.length) return "";
    var on = new Array(24).fill(0), off = new Array(24).fill(0), oth = new Array(24).fill(0);
    rel.forEach(function(e){
      var d = parseT(e.at); if(!d) return;
      var h = d.getHours();
      if(e.type === "came_online") on[h]++;
      else if(e.type === "went_offline") off[h]++;
      else oth[h]++;
    });
    var max = 1;
    for(var i = 0; i < 24; i++) max = Math.max(max, on[i] + off[i] + oth[i]);
    var bars = [];
    for(var h = 0; h < 24; h++){
      var H = 78;
      var so = Math.round(on[h] / max * H);
      var sf = Math.round(off[h] / max * H);
      var sx = Math.round(oth[h] / max * H);
      var title = h + ":00  online " + on[h] + ", offline " + off[h] + ", other " + oth[h];
      bars.push('<div class="b" title="' + title + '">' +
        (sx ? '<div class="seg other" style="height:' + sx + 'px"></div>' : "") +
        (sf ? '<div class="seg off" style="height:' + sf + 'px"></div>' : "") +
        (so ? '<div class="seg on" style="height:' + so + 'px"></div>' : "") +
        '</div>');
    }
    var ax = [];
    for(var a = 0; a < 24; a += 3) ax.push('<span>' + a + '</span>');
    return [
      '<div class="sec"><h3>Activity by hour of day (', tzName(), ')</h3>',
      '<div class="hist">', bars.join(""), '</div>',
      '<div class="hist-ax">', ax.join(""), '</div>',
      '<div class="hist-leg">',
        '<span><i style="background:var(--green2)"></i>came online</span>',
        '<span><i style="background:var(--danger)"></i>went offline</span>',
        '<span><i style="background:var(--blue)"></i>level / status</span>',
      '</div></div>'
    ].join("");
  }
  function timelineHtml(evs){
    if(!evs.length){
      return '<div class="sec"><h3>Timeline</h3><div class="empty" style="padding:26px">' +
             'No events logged for this region in the last 30 days.</div></div>';
    }
    var sorted = evs.slice().sort(function(a, b){ return parseT(b.at) - parseT(a.at); });
    var rows = sorted.map(function(e){
      var meta = EV[e.type] || {c:"var(--gray)", t:e.type};
      var held = (e.cc && e.cc !== e.occ) ? " &middot; held by " + clabel(e.cc) : "";
      return [
        '<div class="ev"><span class="dot" style="background:', meta.c, '"></span>',
          '<div class="ebody"><div class="etop">',
            '<span class="etype">', meta.t, '</span>',
            '<span class="etime" title="', esc(e.at), '">',
              fmtLocal(e.at), ' (', relTime(e.at), ')</span>',
          '</div>',
          '<div class="edesc">', esc(evDesc(e)), '</div>',
          '<div class="ectry">', clabel(e.occ), held, '</div>',
        '</div></div>'
      ].join("");
    }).join("");
    return [
      '<div class="sec"><h3>Timeline &middot; ', evs.length,
      ' event', (evs.length === 1 ? "" : "s"), '</h3>',
      '<div class="tl">', rows, '</div></div>'
    ].join("");
  }
  function openDetail(rid){
    var r = STATE[rid]; if(!r) return;
    r.rid = rid;
    var evs = BY_RID[rid] || [];
    var up = futureActivation(r);

    var nextAct = "";
    if(up){
      var lvl = up.level ? "  &middot;  L" + up.level : "";
      nextAct = [
        '<div class="next-act"><div class="lbl">&#9203; Next scheduled activation</div>',
        '<div class="v">', fmtLocal(up.will_be_active_at), lvl, '</div>',
        '<div class="rel">', relTime(up.will_be_active_at),
        '  &middot;  shown in your local time (', tzName(), ')</div></div>'
      ].join("");
    }

    var occTag = occupied(r) ? ' <span class="occ-pill">occupied</span>' : "";
    var html = [
      '<div class="mhead"><button class="close" id="mclose">&times;</button>',
        '<h2>', esc(r.name || r.code), capStar(r), '</h2>',
        '<div class="mc-code">', esc(r.code || ""),
          (r.main_city ? " &middot; " + esc(r.main_city) : ""), '</div>',
        '<div class="mc-ctry">',
          '<span>Owner: ', clabel(r.initial_country_code), '</span>',
          '<span>Holder: ', clabel(r.country_code), occTag, '</span>',
        '</div>',
        '<a class="mgame" href="', gameUrl(rid), '" target="_blank" rel="noopener">Open in War Era &#8599;</a>',
      '</div><div class="mbody">',
        '<div class="status-line">', bunkerPills(r), '</div>',
        nextAct,
        resHtml(r),
        habitHtml(evs),
        timelineHtml(evs),
      '</div>'
    ].join("");

    document.getElementById("modal").innerHTML = html;
    document.getElementById("ov").classList.add("show");
    document.getElementById("mclose").onclick = closeDetail;
  }
  function closeDetail(){ document.getElementById("ov").classList.remove("show"); }

  function buildCountryDropdown(){
    var set = {};
    REGION_LIST.forEach(function(r){
      if(r.country_code) set[r.country_code] = true;
      if(r.initial_country_code) set[r.initial_country_code] = true;
    });
    var codes = Object.keys(set).sort(function(a, b){
      return cname(a).localeCompare(cname(b));
    });
    var sel = document.getElementById("country-add");
    codes.forEach(function(cc){
      var o = document.createElement("option");
      o.value = cc;
      o.textContent = cname(cc) + " (" + cc.toUpperCase() + ")";
      sel.appendChild(o);
    });
  }
  function renderCountryChips(){
    var box = document.getElementById("country-chips");
    box.innerHTML = selectedCountries.map(function(cc){
      return '<span class="cc-chip">' + flag(cc) + " " + esc(cname(cc)) +
             ' <button data-remove="' + cc + '" title="Remove">&times;</button></span>';
    }).join("");
    var sel = document.getElementById("country-add");
    Array.prototype.forEach.call(sel.options, function(o){
      if(o.value) o.disabled = selectedCountries.indexOf(o.value) !== -1;
    });
  }
  function addCountry(cc){
    if(cc && selectedCountries.indexOf(cc) === -1){
      selectedCountries.push(cc);
      renderCountryChips();
      applyFilters();
    }
  }
  function removeCountry(cc){
    var i = selectedCountries.indexOf(cc);
    if(i !== -1){
      selectedCountries.splice(i, 1);
      renderCountryChips();
      applyFilters();
    }
  }

  function wire(){
    document.getElementById("q").addEventListener("input", applyFilters);
    document.getElementById("country-add").addEventListener("change", function(){
      addCountry(this.value);
      this.value = "";
    });
    document.getElementById("country-chips").addEventListener("click", function(e){
      var btn = e.target.closest("button[data-remove]");
      if(btn) removeCountry(btn.getAttribute("data-remove"));
    });
    ["f-bunker","f-online","f-occupied","f-upcoming"].forEach(function(id){
      document.getElementById(id).addEventListener("change", applyFilters);
    });
    document.getElementById("match-seg").addEventListener("click", function(e){
      var btn = e.target.closest("button[data-match]"); if(!btn) return;
      matchMode = btn.getAttribute("data-match");
      this.querySelectorAll("button").forEach(function(b){
        b.classList.toggle("on", b === btn);
      });
      applyFilters();
    });
    document.addEventListener("click", function(e){
      if(e.target.closest("a")) return; // let in-game links work normally
      var card = e.target.closest("[data-rid]");
      if(card){ openDetail(card.getAttribute("data-rid")); return; }
      if(e.target.id === "ov") closeDetail();
    });
    document.addEventListener("keydown", function(e){
      if(e.key === "Escape") closeDetail();
    });
  }
  function indexEvents(){
    BY_RID = {};
    EVENTS.forEach(function(e){
      (BY_RID[e.rid] = BY_RID[e.rid] || []).push(e);
    });
  }
  function showLastUpdated(){
    var el = document.getElementById("last-updated");
    if(!el) return;
    var when = REGION_LIST.length ? REGION_LIST[0].observed_at : null;
    if(!when){ el.textContent = ""; return; }
    el.innerHTML = "Data last updated " + fmtLocal(when) +
      " (" + relTime(when) + ", " + tzName() + ")";
  }
  function start(){
    REGION_LIST = Object.keys(STATE).map(function(rid){
      var r = STATE[rid]; r.rid = rid; return r;
    });
    indexEvents();
    buildCountryDropdown();
    wire();
    showLastUpdated();
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("content").classList.remove("hidden");
    applyFilters();
  }
  function loadJSON(url){
    return fetch(url, {cache:"no-store"}).then(function(res){
      if(!res.ok) throw new Error(url + " " + res.status);
      return res.json();
    });
  }

  loadJSON(DATA_BASE + "state.json").then(function(state){
    STATE = state || {};
    return loadJSON(DATA_BASE + "events.json").catch(function(){ return []; });
  }).then(function(events){
    EVENTS = Array.isArray(events) ? events : [];
    start();
  }).catch(function(err){
    document.getElementById("loading").innerHTML =
      "Could not load region data.<br><span style='color:var(--faint);font-size:13px'>" +
      esc(String(err)) + "</span>";
  });

})();