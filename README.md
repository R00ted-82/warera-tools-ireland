# War Era tools

An Irish player's toolkit for [War Era](https://app.warera.io/). Live at [tools.we-ie.com](https://tools.we-ie.com).

This is a static site: plain HTML, CSS, and vanilla JavaScript with no build step, no framework, and no bundler. You edit files, refresh the page, done. Everything runs in the browser. The only backend is a thin Cloudflare Worker that proxies the game's API and holds a couple of secrets.

## Quick start

Clone the repo and serve the folder over HTTP. You can't open `index.html` with `file://` because the tools use `fetch` and the Web Crypto API, both of which need a real origin.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, etc.). There is nothing to install and nothing to compile.

## How a contributor should think about this

The site is one HTML page with several hidden "views". A hash router shows one view at a time. Each tool is a self-contained script that the router switches on when its view becomes visible. Shared plumbing (the API client, formatting helpers, the loading-step UI) lives in one file that every tool depends on.

If you understand `shared.js` and the tool pattern below, you understand the whole codebase.

## File structure

```
index.html        All views live here as <section class="view"> blocks
styles.css        Main stylesheet (theme variables + every tool's styles)
community.css     Styles specific to the Community tools directory
js/
  shared.js       Loaded first. Data layer + helpers. Tools depend on this.
  toolkit.js      Home/landing shell + tab navigation
  advisor.js      Company Migration Advisor
  clockin.js      Employee Clock-In Monitor
  buddy-finder.js Buddy Finder (public)
  daily-profit.js Daily Profit calculator
  wealth.js       Wealth tracker
  donation-draw.js Ireland Donation Draw
  mu.js           Irish Military Units
  buddy.js        Buddy System Monitor (encrypted, MoE password)
  battle-orders.js Battle Orders (encrypted, MoD password)
  beer.js         Bunker monitor (encrypted, BEER password)
  router.js       Loaded last. Hash routing + view switching.
images/           Item icons used by the advisor and clock-in tools
```

Script load order in `index.html` matters and is fixed: `shared.js` first, then the tools, then `router.js` last. Shared helpers must exist before any tool runs, and the router must run after every tool global is defined.

## Architecture

### Views and routing

Every view is a `<section class="view" data-view="NAME">` inside `index.html`. Only one carries the `active` class at a time; the rest are hidden by CSS.

Routing is hash-based and deep-linkable. Parameters sit inside the hash after a literal `?`, so the whole route travels as one fragment and survives static hosting that doesn't rewrite query strings.

```
#home                 Irish tools landing (default)
#community            External community tools directory
#mu                   Irish Military Units
#mu?filter=open       MU tool with the "Has slots" filter applied
#advisor              Migration Advisor, empty
#advisor?u=toie       Migration Advisor pre-loaded for a user
#clockin?u=toie       Clock-In Monitor pre-loaded for a user
#buddy-finder?u=toie  Buddy Finder pre-loaded for a user
```

`router.js` parses the hash into `{ view, params }`, toggles the right section active, shows or hides the tab bar and back link, and calls the tool's `activate(params)`.

Two things to know about the router:

1. `activate(params)` runs **every time** a view becomes active, not just the first time. Tools must be idempotent. For example, MU kicks off its data load exactly once, and the advisor only re-runs if the `?u=` value changed. This is what lets a hash edit from `#advisor` to `#advisor?u=toie` pick up the new parameter without a full reload.
2. To register a new view you add it to the `VALID` set and the `tools` map in `router.js`. Landing pages (`home`, `community`) go in the `LANDING` set so they show the tab bar instead of the back link.

### The tool pattern

Every tool is an IIFE assigned to a global, returning an object with an `activate` method. That global is what `router.js` references.

```js
const MyTool = (() => {
  // grab DOM nodes, wire up event listeners, define the pipeline
  return {
    activate(params) {
      // called whenever this view opens; must be idempotent
    }
  };
})();
```

Tools never touch each other. They share state only through the URL and through helpers in `shared.js`.

### shared.js (read this first)

`shared.js` is the contract every tool relies on. The important pieces:

**Constants**

```js
API_BASE         = 'https://warera-proxy.r00ted82.workers.dev/trpc'
WARERASTATS_BASE = 'https://warera-proxy.r00ted82.workers.dev/warerastats'
GAME_BASE        = 'https://app.warera.io'
IRELAND_COUNTRY_ID = '6813b6d446e731854c7ac7fe'
```

**`trpc(endpoint, inputOrInputs, { batch, retry, timeoutMs, fresh })`** is the only way to call the game API. It builds the proxied URL, unwraps the tRPC response shape, and optionally retries transient errors. With `batch: true`, pass an array of inputs for the same endpoint; the result uses `Promise.allSettled`'s shape. `fresh: true` bypasses the resolved-value cache. Always use `trpc` rather than calling `fetch` against the gateway directly.

**`enforceIrishOnly(country, username)`** throws unless the user is an Irish citizen or the `bypass=1` URL flag is set. Personal tools call this right after resolving a username, before any expensive loading. A `null` country passes through (the resolution path reports its own error).

**`makeSteps(rootEl)`** returns `{ setStep, reset, markActiveAsError, fadeOut, hide }` for driving the multi-step loading panel (the spinner-and-checkmark list you see while a tool works). The matching markup is the `.steps` block inside each view.

**`makeStatus(el)`** returns a `setStatus(text, isError)` function for the single-line status message under a tool header.

**Formatting helpers:** `escapeHtml`, `fmtNum`, `fmt`, `flag`, `formatDuration`, `formatDate`. Always run any user-supplied or API string through `escapeHtml` before putting it in `innerHTML`.

**`isTransientError(err)`** classifies retryable failures (HTTP 502/503/504, timeouts, network errors). Use it to decide between a friendly "try again in a moment" message and a hard error.

### Username resolution

Several tools need to turn a typed username into a user ID. The game's `search.searchAnything` is fuzzy and relevance-ranked, so the first result is not guaranteed to be an exact match. The shared pattern, used in advisor, clock-in, and buddy-finder, is:

1. Search for the text.
2. Fetch lite profiles for the top results.
3. Keep the one whose username matches exactly, case-insensitive.
4. Never silently fall back to the top hit. If nothing matches, tell the user what came back.

If you write a tool that resolves usernames, copy this behaviour. Falling back to an unverified result causes "wrong user" bugs during API hiccups.

## The tools

Each tool is described below: what it does, the selection or computation rules that matter, and the gotchas worth knowing before you touch it. The two encrypted tools are covered under Access control above.

### Irish Military Units (`mu.js`)

Lists every MU owned by an Irish citizen, located in Ireland, with a majority-Irish roster.

Three checks decide whether an MU appears: the owner is currently an Irish citizen (founders who migrated away are dropped); the MU's own country, if it exposes one, is Ireland (MUs with no country field skip this check rather than being dropped, so missing data doesn't wipe the list); and at least half the members are Irish. There's also a hardcoded `EXCLUDED_MU_IDS` blacklist for manual removals.

Each member gets an eco / war / mixed tag based on how they've spent skill points. The classifier reads each skill's `level` (points spent), not `value` (the derived stat), because allocation is what reveals playstyle. `ECO_SKILLS` and `WAR_SKILLS` are the buckets; `PURITY_THRESHOLD` (0.6) sets how skewed an allocation must be to count as pure, and `MIN_POINTS_TO_CLASSIFY` (5) suppresses tags for players who've barely started.

Capacity is `dormitories * 5`. MUs with no dormitory data have unknown capacity and show only under the "All" filter, never "Has slots" or "Full".

### Company Migration Advisor (`advisor.js`)

For each of a user's companies, works out whether a different country or region would produce more, and by how much.

This is the most intricate tool in the project. The production bonus is computed locally from four components: strategic resources, a +30% industrialism bonus on the specialised item, a regional deposit bonus, and a +30% industrialism bonus on deposits. Which ones fire depends on the country's industrialism lean (a signed integer from warerastats, where only the sign matters) and on the item category. The gating is asymmetric and stacks in some combinations but not others.

The whole model was reverse-engineered and verified against in-game tooltips. The file header lists the verified cases and an explicit "bugs to NOT repeat" list. Do not change the bonus logic without re-verifying against live tooltips. In particular, `AGRARIAN_ITEMS` is misnamed: it's the set of items the industrialism bonus does NOT cover (food, plants, pills), not just agrarian goods.

Income tax only affects the ranking on companies the user actually works in. If they just own it, raw output is ranked instead. If warerastats is unreachable, industrialism defaults to 0 and the +30% bonuses simply don't fire, which under-counts rather than mis-counts.

### Employee Clock-In Monitor (`clockin.js`)

Shows when each of an employer's workers last clocked in, on a 48-hour timeline, plus a payroll projection.

Wage transactions are the source of truth. A clock-in is inferred from a wage payment, because every work cycle pays a timestamped wage. Wages are modelled as trades: `sellerId` is the worker (sold their labour), `buyerId` is the employer (bought it). Two filters are applied to each transaction and both matter: the worker must be the seller (drops their own outgoing payroll if they also employ people), and the employer must be the buyer (drops wages from other employers, since a worker can now hold multiple contracts).

Cycles within 4 minutes of each other are grouped into one "episode" to keep the timeline readable. Status is Active (clocked in within 24h), Slowing (24 to 48h), or Idle (none in 48h).

The payroll projection shows three figures. Next 3h and Next 6h are pace-based: last 24h of wages divided by 24, times the window. Next 10h "if maxed" is the worst case where every worker's energy bar is full and gets drained completely. Ten hours is used because energy regenerates at 10% per hour, so that's exactly one full refill from empty.

### Buddy Finder (`buddy-finder.js`)

A self-service tool for Irish citizens to find a buddy-system partner, or join a waiting list. Distinct from the MoE-only Buddy System Monitor, which is an admin oversight dashboard.

Matching pipeline: resolve the user, pull all Irish citizens and their skill profiles, pull worker rosters to detect who already employs whom, classify each mutual pair as balanced or imbalanced, then rank candidates in three tiers (waitlist members first, then members of imbalanced pairs, then everyone unpaired), sorted by skill closeness within each tier. People in balanced pairs are skipped, since pairing them would break a working arrangement.

A player's max daily output is estimated as `production * energy * 0.343`, where 0.343 is an empirical constant (roughly 10% energy regen per hour times about 7 energy per work action). Two players are a "close match" if their daily outputs are within 15% of each other.

#### The waiting list

The waiting list is backed by a `waitlist.json` file in the [`R00ted-82/warera-tools-ireland`](https://github.com/R00ted-82/warera-tools-ireland) GitHub repo.

Reads hit the GitHub contents API with a cache-buster. This endpoint refreshes within seconds of a commit, unlike the raw or jsDelivr endpoints which cache for hours. Writes POST to the Worker's `/waitlist-update` route, which fires a `repository_dispatch` with the PAT attached server-side, and a GitHub Action then edits the file.

That Action introduces roughly a one-minute lag between a submit and the name appearing. This is intentional and free; the UI warns users about it. Don't write to GitHub directly from the client; that would leak the token.

### Ireland Donation Draw (`donation-draw.js`)

Aggregates money donated to Ireland over an exact, shareable date-time period and selects uniformly from unique donors who are current Irish citizens and meet the operator's aggregate minimum. Periods are half-open (`start <= createdAt < end`), limited to a 31-day lookback, and default to the previous seven days with a ₿1 minimum. Donation totals and counts never weight the draw: each eligible user has one entry.

Donation transaction field names are counterintuitive and were verified against the game UI. For `transactionType: 'donation'`, `buyerId` is the user who donated and `sellerCountryId === IRELAND_COUNTRY_ID` means Ireland received it. Do not reverse this mapping based on the trade-oriented buyer/seller names. Non-money, non-positive, item-only, userless, other-country, and other transaction records are excluded; unexpected donation-shaped records are surfaced as warnings.

The tool incrementally caches only the required public transaction fields in versioned `localStorage`, deduplicated by transaction ID and evicted after 31 days. It still fetches the newest API page every time it opens or refreshes. Current citizenship is reloaded separately and revalidated before the first roll or after it becomes stale; unresolved profiles and incomplete pagination disable selection rather than silently shrinking the pool.

Winner history is also versioned in `localStorage` and keyed by the exact normalized start, end, and minimum. Winners cannot repeat for that filter set until the operator explicitly resets the draw. Search, sorting, row expansion, and the ineligible-donor toggle affect only the audit table, never the random pool. Selection uses `crypto.getRandomValues()` with rejection sampling rather than `Math.random()`.

### Buddy System Monitor (`buddy.js`) and Battle Orders (`battle-orders.js`)

Both are password-encrypted (see Access control). Buddy System Monitor is the MoE-facing oversight version of Buddy Finder: it tracks every reciprocal employment pair across the Irish economy and flags strays and mismatches. Battle Orders is an MoD-facing live battle tracker with MU order compliance and a Discord push for commanders. Their gate code is public; the tool logic lives inside the encrypted payload.

### Daily Profit (`daily-profit.js`)

Estimates a player's daily profit across their companies and employees: engine vs staff throughput, wages, fidelity, daily/weekly missions, case sales, and per-product net margins (with country tax and production-bonus lookups). The economic model was validated formula-by-formula against Adro's spreadsheet — direct questions about the model go to Adro.

### Wealth tracker (`wealth.js`)

Charts any Irish citizen's wealth over time. A scheduled GitHub Action (`wealth_log.py`) snapshots every citizen's public wealth once a day into `data/wealth/<userId>.json`; the page fetches only the one file for the player being viewed, so it scales to hundreds of citizens. The wealth breakdown (companies, items, money, equipment, weapons) is the same public figure shown on an in-game profile.

### Bunker monitor (`beer.js`)

A searchable, timezone-aware log of region bunker activity for the BEER alliance block. A scheduled GitHub Action (`bunker_log.py`) snapshots every region every few hours, diffs it, and records came-online / went-offline / level-changed / built events into `data/events.json` (rolling 30-day window), with `data/state.json` as the previous-snapshot baseline. Password-encrypted like the other two gated tools (BEER password).

## Data layer

All game data comes through one Cloudflare Worker at `warera-proxy.r00ted82.workers.dev`. It exposes these routes:

- `/trpc/*` proxies the War Era Gateway (tRPC).
- `/warerastats` proxies Hattorius's warerastats data (used for country industrialism in the advisor).
- `/waitlist-update` mutates the Buddy Finder waiting list (see below).
- `/notify-discord` forwards a message to the Battle Orders Discord webhook (held as a Worker secret).
- `/monitored-update` is wired for a wealth-monitor watch-list but is currently unused — nothing calls it and there is no receiving workflow.

The Worker holds the secrets (the GitHub PAT for the waitlist). The browser never sees them. The whole site otherwise runs client-side and stores nothing about users, except the username and user ID of people who opt into the waiting list.

Endpoints currently in use, for reference:

```
search.searchAnything
user.getUserLite, user.getById (+ fallbacks), user.getUsersByCountry
company.getCompanies, company.getById
worker.getWorkers
transaction.getPaginatedTransactions
mu.getManyPaginated
region.getRegionsObject
country.getCountryById, country.getAllCountries
gameConfig.getGameConfig
warerastats /countries  (industrialism, via WARERASTATS_BASE)
```

## Access control

There are two separate mechanisms. Don't confuse them.

**Irish-only gate.** Personal tools (advisor, clock-in, buddy-finder) call `enforceIrishOnly` to block non-Irish users. Append `?bypass=1` to the hash for admin or debugging. The MU tool doesn't gate; it filters MUs down to Irish ones instead.

**Password-encrypted tools.** Buddy System Monitor (`#buddy`, MoE), Battle Orders (`#battle-orders`, MoD), and the Bunker monitor (`#beer`, BEER) ship their entire tool (CSS, HTML, JS) as an AES-encrypted blob in the source. The page is useless without the password, so the sensitive logic never reaches an unauthorised browser in readable form. (Caveat: the plaintext payload sources — `bo-payload.js`, `buddy-payload.js`, `beer-payload.js` — are also committed, so this only holds if the repo is private; see `.gitignore`.)

### How the encrypted tools work

- Blob format: base64 of `salt(16) || iv(12) || AES-GCM-256 ciphertext`.
- Key derivation: PBKDF2-SHA-256, 200000 iterations.
- On correct password, the gate decrypts the blob and injects it as a `<script>` tag, which mounts the real tool.
- The blob lives in the `BO_ENCRYPTED_PAYLOAD` / `BUDDY_ENCRYPTED_PAYLOAD` / `BEER_ENCRYPTED_PAYLOAD` constant at the top of the respective gate file.

To set up or rotate a password: encrypt the tool's payload file with the standalone `encrypt.html` generator (it is payload-agnostic and works for all three tools), then paste the resulting base64 string as the constant value. Until the constant is filled in, the gate shows "payload not configured yet" and does nothing.

The gate code itself (`buddy.js`, `battle-orders.js`, `beer.js`) is plain and public. Only the payload is secret.

## Styling conventions

`styles.css` defines the dark theme through CSS custom properties in `:root` (`--bg`, `--panel`, `--accent`, `--warn`, `--danger`, `--link`, `--muted`, `--text`, `--border`, and a few more). Use these variables. Don't hardcode colours. Add a new variable only when the existing palette genuinely can't express what you need (the one precedent is `--bf-orange` for the "mismatched" badge, where green, yellow, and red were already taken).

Other rules:

- **Scope every tool's classes with a prefix** (`clockin-`, `bf-`, and so on) so styles can't collide across tools sharing one stylesheet.
- **Reuse shared components** where they exist: `.steps` for loading, `.status` for the status line, `details.howto` for the "how this works" disclosure, `.icon-box` for item icons.
- **Mobile breakpoints** are at 720px, 640px, 600px, and 380px. Keep each tool's responsive overrides together so the file stays scannable.

## Adding a new tool

The process is build-standalone, then merge, and design must survive the merge.

**1. Build it standalone.** Make a throwaway page with its own HTML, CSS, and JS and get the tool fully working in isolation. This keeps experiments out of the main site until they're ready.

**2. Merge it in.** Five steps, in order:

1. Add a `<section class="view" data-view="yourtool">` to `index.html`.
2. Add a card for it on the home view so people can find it.
3. Fold its CSS into `styles.css`, renaming classes to a unique prefix and swapping any hardcoded colours for the theme variables.
4. Add `js/yourtool.js` following the IIFE-plus-`activate` pattern. Use `trpc`, `makeSteps`, `makeStatus`, `escapeHtml`, and `enforceIrishOnly` from `shared.js` rather than reinventing them.
5. Register it in `router.js` (add the name to `VALID` and map it in `tools`), and add its `<script>` tag in `index.html` before `router.js`.

**3. Preserve the look.** A merged tool should be indistinguishable in style from the existing ones. Same loading panel, same status line, same card and disclosure patterns, same spacing. If it looks like a different site, the merge isn't finished.

## Credit

By toie. Live data via the [War Era Gateway](https://gateway.warerastats.io/). Industrialism data from [warerastats.io](https://warerastats.io/).
