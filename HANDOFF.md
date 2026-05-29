# HEMS Tracker — Handoff v.3 for the next session

This document brings a fresh Claude Code session up to speed quickly. Read it
end-to-end before making changes. The companion `CLAUDE.md` is the tight
architectural quick-reference focused on the data-fetch path; this file is
the broad onboarding. Memory files in `~/.claude/projects/.../memory/` also
auto-load and reinforce the conventions below.

> **What changed since v.2 (was v.0058):**
> - **v.0059 — Shared live snapshot.** Browsers no longer hit adsb.lol
>   directly every 3 s. They now poll the worker's `/live` route, which
>   serves the DO's already-existing bbox poll. Upstream call rate is now
>   flat at 1 per 3 s regardless of visitor count. Snapshot persists to
>   Durable Storage for cold-start resilience. 429 handling honors
>   `Retry-After`. UI surfaces stale / backoff via an amber status dot.
> - **v.0060 → v.0061 — Multi-source ADS-B merge.** The DO now polls
>   adsb.lol + airplanes.live in parallel each cycle (initially also
>   adsb.fi — pulled after we confirmed an IP/ASN block on Cloudflare
>   Worker egress). Merge dedupes by lowercased hex, freshest `seen` wins
>   position, missing fields backfill from the other sources. Server-side
>   outlier filter on `distance_nm` accumulation mirrors the browser's
>   ingestFleetSample logic. Per-source backoff so one source 429'ing
>   doesn't blank the others. `/live` envelope adds per-source health.
>
> **Current live version: v.0061.**

---

## 1. About the user

- **GitHub:** `RiskfreeDraenor` — repo at https://github.com/RiskfreeDraenor/HEMS-tracker
- **Cloudflare account:** `deltasteelfox92@gmail.com`'s account
  (account ID `6c4492af8a0afd7932369b4b7a997bc7`)
- **Email:** `deltasteelfox92@gmail.com`
- **Domain owned:** `hemsnj.com` (GoDaddy DNS → GitHub Pages, HTTPS via Let's Encrypt)
- **Tech comfort:** comfortable editing HTML and config values; newer to git,
  CLI tooling, Cloudflare/wrangler. Walks through dashboard UI well when steps
  are broken down small.
- **Communication style:** casual, lowercase, typos. Mirror that energy — keep
  responses friendly and concrete, avoid jargon. Don't lecture.
- **Personal context:** owner/operator and an actual pilot — when they describe
  flight behavior (jumping markers, weird trails) take their report at face
  value, don't second-guess with hover-noise theories.

## 2. What the user wants

A **single-pane HEMS dispatch tracker** for helicopters in NJ and nearby
states. Eventually 15–20 aircraft across multiple operators. Priorities, in order:

1. **Precise tracking** of fleet aircraft — accurate takeoff/landing times and
   locations. 3-second polling cadence is the baseline; never accept slower.
2. **Smooth visual movement** — markers should glide between samples, not
   teleport every 3 s. Trails should be clean lines, not starbursts.
3. **Awareness of nearby traffic** around whichever fleet aircraft is currently
   focused — distance, altitude (when close), clock position relative to nose.
4. **Flight history** — every flight every aircraft ever took, with route
   (airport → airport), duration, max alt, max speed, distance, replayable
   track, and an altitude profile.
5. **Multi-aircraft, multi-company** layout — no aircraft is "the center";
   the user picks who's focused by clicking a fleet card.
6. **Visual polish per aircraft** — automatic Planespotters photos on the
   fleet cards and popups (with photographer credit), plus per-aircraft
   custom map icons, glow tuning, etc.
7. **First-class mobile experience** — map-first layout with everything
   else tucked behind a hamburger drawer.

Things explicitly **not** important to the user:
- Emergency squawk highlighting (cool but not a priority)
- Receiver-side decoding / self-hosted ADS-B (data from adsb.lol is enough)

## 3. Current architecture

```
                       Cloudflare (Workers Paid, ~$5/mo)
                       ─────────────────────────────────
   browser ─ /live   ─────────────► TrackerDO snapshot (default live path)
   browser ─ /v2/*   ─────────────► fetchAdsb() ──► api.adsb.lol
                                                    (gated fallback for views
                                                     outside the DO bbox)
   browser ─ /log/state ──────────► hemstracker worker ──► D1 (cached state)
   browser ─ /log/flights ────────► hemstracker worker ──► D1 (flight history)
   browser ─ /log/flight/<id>/track ► hemstracker worker ──► D1 (track points)
   browser ─ /log/airport ────────► hemstracker worker ──► D1 (nearest airport)
   browser ─ /log/airports/bbox ──► hemstracker worker ──► D1 (airport overlay)
   browser ─ /log/photo ──────────► hemstracker worker ──► api.planespotters.net
                                       │  (CF cacheTtl 24h on photo proxy)
                                       │
                                       ▼ TrackerDO (Durable Object)
                                       self-scheduled alarm every 3 s
                                       + cron heartbeat * * * * *
                                       state-machines fleet aircraft → D1
                                       ┌────────────────────────────────┐
                                       │ alarm() — Promise.allSettled:  │
                                       │  ─► api.adsb.lol     /v2/lat   │
                                       │  ─► api.airplanes.live /v2/point│
                                       │  (adsb.fi tried + pulled —     │
                                       │   blocks CF Worker egress IPs) │
                                       │ → mergeAircraft() dedupes by   │
                                       │   lowercase hex                │
                                       │ → this.snapshot (in-mem +      │
                                       │   Durable Storage)             │
                                       │ → processAircraft × FLEET_REGS │
                                       └────────────────────────────────┘
```

- **Browser** (GitHub Pages, hemsnj.com): polls the worker's `/live` route
  every 3 s — that serves the DO's shared snapshot, no upstream call.
  Browser splits the merged list into fleet (by registration) vs traffic.
  Falls through to a direct adsb.lol `/v2/lat/.../dist/...` call only when
  the view extends outside the DO's NJ bbox.
- **TrackerDO**: self-schedules a 3-sec alarm. Each alarm polls all active
  ADS-B sources in parallel via `Promise.allSettled`, merges the responses
  into one deduplicated aircraft list (lowercased hex key, freshest `seen`
  wins position, missing fields backfilled), stores the merged snapshot
  (in-memory + Durable Storage), and runs the flight state machine off the
  merged list. Currently 2 active sources (adsb.lol + airplanes.live).
- **D1 `hemstracker-logs`**: 5 tables — `aircraft_state`, `flights`,
  `track_points`, `airports` (~25k US heliports/airports from OurAirports).
- **Sprite system**: `icons.webp` (the public adsbx aircraft sprite, 575×791,
  ~8 cols × 11 rows of ~72×72 cells). Per-category cells mapped in
  `CATEGORY_SPRITE` near the top of `index.html`. **1-indexed.**
- **Per-aircraft custom icons**: `map-icons/*.png` files override the sprite
  cell for specific FLEET entries.
- **Aircraft photos**: Planespotters Pub Photo API proxied through the
  worker (24-hour edge cache). Powers the auto-photo on fleet cards and the
  photo at the top of every aircraft popup. See Section 7-C.

### State-machine knobs (cloudflare-worker.js)

| Constant | Value | Purpose |
|---|---|---|
| `POLL_INTERVAL_MS` | 3000 | DO alarm cadence |
| `CONFIRMATIONS_NEEDED` | 3 | Hysteresis ticks before state transition (~9 s) |
| `GROUND_ALT_FT` / `GROUND_GS_KT` | 100 / 30 | Threshold for "on ground" if `alt_baro != "ground"` |
| `BBOX_CENTER` / `BBOX_RADIUS_NM` | 40.6/-74.3 / 150 nm | Polling area covering NJ + adjacent states |
| `AIRPORT_MAX_NM` | **2.5 nm** | Tolerance for "took off / landed at this airport" *(bumped from 0.5 in v.0044)* |
| `AIRPORT_BBOX_DEG` | 0.05 | Pre-filter bbox before haversine sort |

### Browser fetch knobs

| Constant | Value | Purpose |
|---|---|---|
| `FETCH_TIMEOUT_MS` | **8000** | AbortController timeout per strategy attempt *(was 5000)* |
| `consecutiveFails ≥ 3` | — | Threshold before flashing the ERR badge in the status bar (suppresses transient blips) |

### Precision notes
- Takeoff/landing time + position recorded from the **first** tick where the
  new candidate state was observed (not from confirmation). Removed a 6–9 sec
  systematic offset.
- Fleet polling is one bbox call per tick that returns every aircraft in
  range; we split it into `state.fleet` (by reg) and `state.traffic` (the
  rest). Was N+1 per-reg calls before v.0043.
- Markers smoothly glide between samples via a `requestAnimationFrame`
  animation loop that dead-reckons each aircraft forward from its last
  confirmed fix. Projection capped at 10 s so backgrounded tabs don't drift.

## 4. File map

| Path | What it is |
|---|---|
| `index.html` | The entire frontend. Single page. Leaflet for the main map + a second Leaflet instance for the history overlay. |
| `cloudflare-worker.js` | Worker code (proxy + DO + `/log/*` endpoints + Planespotters photo proxy). |
| `wrangler.toml` | wrangler deploy config — bindings, migrations, cron. |
| `populate-airports.mjs` | One-off (safe to re-run) Node script that fetches OurAirports CSV and bulk-imports US airports into D1 via `wrangler d1 execute`. |
| `icons.webp` | Aircraft sprite (adsbx public icons). Sprite math: 256×352 scaled, each cell 32×32. |
| `map-icons/` | Per-aircraft PNG icons that override the sprite cell. Currently: `ec135.png`, `ec135LifeFlight.png`, `AW139Trooper.png`. |
| `pictures/` | Per-aircraft photos that render as a faded background on each fleet card. Manual `image:` overrides the auto-photo. Currently: `732hm.png`, `511HU.png`, `n456mt.png`. |
| `CNAME` | Just `hemsnj.com` for GitHub Pages. |
| `SETUP-cloudflare.md` | Original end-user worker setup walkthrough — outdated (predates DO + photo proxy). Doesn't hurt anything. |
| `HANDOFF.md` | This document — broad onboarding. |
| `CLAUDE.md` | Tight architectural quick-reference focused on the data-fetch path (v.0059+: shared snapshot, multi-source merge, gated fallback). Auto-loaded by Claude Code on session start. |
| `.claude/launch.json` | Local preview-server config (Python http.server on port 8765) — gitignored. Use with the `mcp__Claude_Preview__*` tools to load the page at any viewport. |

Memory files (auto-loaded by Claude) live in
`C:\Users\ddt19\.claude\projects\C--Users-ddt19-Documents-tracker-files\memory\`.

## 5. Key conventions the user has reinforced

These are sticky. Honor them by default — they have memory notes backing them.

| Convention | Memory note |
|---|---|
| **Bump VERSION (in index.html) before every commit.** Format `v.NNNN`. Single literal in the HTML, marked with comment. User uses it to verify the deployed build. | `feedback_version_bumping.md` |
| **One color per company.** All aircraft from a company share a hex. New company → new distinct color. Current palette below. | `feedback_company_color.md` |
| **No addresses in the UI.** Base addresses are positioning input only. Never render them in cards or popups. The airport DB name wins over `FLEET[i].base.name` when both match (`resolveLocation` handles this). | `feedback_no_address_in_ui.md` |
| **Grid coordinates are 1-indexed.** When user says "row 6 col 7", that's the 6th row down and 7th col from left, both starting at 1. | `feedback_one_indexed_grids.md` |

### Company → color (current)

| Company | Hex | Aircraft |
|---|---|---|
| Hackensack | `#0080ff` (blue) | N732HM, N551HU |
| RWJ Life Flight | `#E63946` (red) | N456MT |
| JeffStat | `#B388FF` (purple) | N135TJ |
| Cooper | `#00E5A0` (teal-mint) | N137MH |
| STAR (NJ State Police) | `#FF8A4C` (orange) | N3NJ, N5NJ, N9NJ |

## 6. Per-aircraft FLEET fields (full reference)

Every aircraft entry in the `FLEET` array in `index.html` can carry these
fields. Required ones are starred. Defaults shown in parentheses.

| Field | Example | Notes |
|---|---|---|
| `registration`* | `"N732HM"` | Tail number. Also key in worker's `FLEET_REGS`. |
| `label`* | `"Hackensack 2"` | Short callsign shown on map + cards. |
| `color`* | `"#0080ff"` | Company color (one per company). |
| `kind`* | `"helicopter"` | Or `"fixed-wing"`. Drives sprite category fallback. |
| `company`* | `"Hackensack"` | Groups cards in the right panel. |
| `isPrimary` | `true` | At most one. Sets initial focused aircraft on page load. |
| `base`* | `{ lat, lon, name }` | lat/lon required. `name` is internal data; never shown. |
| `image` | `"pictures/732hm.png"` | Manual override — shown as a faded background on the fleet card. **Wins over the auto Planespotters photo.** |
| `mapIcon` | `"map-icons/ec135.png"` | Per-aircraft PNG marker, overrides sprite cell. Optional. |
| `mapIconRotation` (0) | `-90` | Degrees added to track. Use when the icon's "front" isn't drawn pointing up. |
| `mapIconSize` (32) | `75` | Wrap size in px. Bigger = more detailed icon. |
| `mapIconAnchorY` (0) | `0` | Vertical pixel offset of the marker's geo anchor. Trail connects here. |
| `mapGlowOpacity` (0.85) | `0.16` | 0 to disable the halo, 1 for full. |
| `mapGlowSize` (6) | `0` | Pixels outward beyond the wrap. 0 = halo flush with the icon. |
| `mapGlowColor` (`color`) | `"#0767f8"` | Halo color; falls back to the company color. |

The **icon tester** in DEV TOOLS (bottom-left button) produces a paste-able
snippet of these icon/glow fields — see Section 13.

## 7. The major systems

### 7-A. Smooth tracking pipeline (v.0043)

Three pieces in `index.html`, all near each other and labelled with comments:

1. **`ingestFleetSample(reg, ac, now, opts)`** — receives a new sample from
   the bbox response. Rejects it if the implied speed is impossible vs the
   previous fix (cap at `max(prev.gs, new.gs, 200) × 1.6`, 0.25 nm slack).
   Passes go into `fleetFix` (Map keyed by uppercase reg) and the trail.
2. **`projectFromFix(fix, now)`** — given a confirmed fix, dead-reckons where
   the aircraft *should* be using its last known speed + heading. Caps the
   extrapolation at 10 s so a backgrounded tab can't drift minutes ahead.
3. **`animationFrame()`** — `requestAnimationFrame` loop. Each frame, eases
   `fleetDisplay[reg]` toward the dead-reckoned target with a 0.18 lerp.
   `render()` reads from `fleetDisplay` (not raw `ac.lat/lon`) when placing
   fleet markers.

Net effect: markers glide between samples instead of teleporting every 3 s.
Outlier filter kills the starburst-trail problem (stale Planespotters fixes
mixed into real ones during a flight).

### 7-B. HISTORY full-viewport overlay (v.0045–v.0048)

Opened via the **📋 HISTORY** button in the topbar (desktop) or the drawer
(mobile). Per-card buttons no longer exist (v.0046 removed them).

Layout (desktop): 3 columns —

- **LEFT** (300 px): flights list, takes full viewport height, scrolls cleanly
  (the old `max-height: 200px` on `.flight-log` is gone — see v.0048).
- **CENTER**: stats strip (route, duration, distance, max alt/spd) → its own
  dedicated Leaflet map showing the selected flight track → SVG altitude
  profile chart underneath.
- **RIGHT** (260 px): aircraft picker — same fleet-card style as the main
  panel, click to filter the flights list to that aircraft.

Mobile stacks vertically: bar → fleet → flights → main (map + chart).

Flight tracks **only** render on the overlay's map. The main map no longer
has a `flightTrackLayer` — that whole layer is gone.

Closes via ✕ button or ESC.

### 7-C. AircraftPhoto module (v.0051–v.0053)

**Self-contained, isolated.** Has its own cache + inflight-dedup Maps, never
touches `state`. If anything inside this module throws, the rest of the app
keeps working — cards just don't get auto-photos.

- **Worker side**: `GET /log/photo?hex=<icao24>|reg=<tail>` proxies the
  Planespotters Pub Photo API (`api.planespotters.net/pub/photos/(hex|reg)/X`).
  Cloudflare caches the response for 24 h via `cf.cacheTtl`. Failures return
  `{photos: []}` so the browser falls back gracefully.
- **Browser side**: IIFE-wrapped `AircraftPhoto` object with five methods:
  - `fetchPhoto({hex|reg})` — async, deduped, populates cache.
  - `getCached({hex|reg})` — sync lookup. Returns photo record or null.
  - `inlineMarkup({hex|reg})` — returns `{cls, style, creditHtml}` to embed
    into a fleet-card's HTML template at render time. **Used for the no-flicker
    pattern: cards re-render every tick, and sync embed from cache means the
    photo is present in the freshly-built DOM from the very first paint.**
  - `popupMarkup({hex|reg})` — returns a `<div class="pop-photo">...</div>`
    snippet for Leaflet popups (with photographer credit).
  - `decorateCard(cardEl, opts)` — async fallback path. Used for first-time
    decoration when cache is cold. Short-circuits if the card already has
    `has-photo` (synchronously rendered from cache).

Integration points (all just call those public methods, never touch the
internals):
- `renderPanel()` → embeds via `inlineMarkup` at card-build, then calls
  `decorateCard` async for cards whose cache was cold.
- `renderHistoryFleetCards()` → same pattern for the overlay's aircraft picker.
- `popupHtml()` → embeds via `popupMarkup` from sync cache.
- Marker creation in `render()` → registers a `popupopen` handler **once per
  marker** (closure captures the hex). If the photo wasn't cached when the
  user clicked, the handler fetches it and injects into the open popup.

Manual `cfg.image` always wins — `has-img` short-circuits both `decorateCard`
and `inlineMarkup`, so N732HM / N551HU / N456MT keep their hand-picked photos.

Photographer credit: small italic text bottom-right of each card (`.fc-photo-credit`)
and bottom-right of each popup photo (`.pop-credit`). Required by Planespotters'
attribution terms.

### 7-D. ADS-B feed — shared snapshot + multi-source merge (v.0059–v.0061)

Two related changes that together cut upstream call volume to flat ~1/3 s
and added redundancy:

**The shared snapshot (v.0059).** Every browser used to hit
`/v2/lat/.../dist/...` every 3 s through the worker as a passthrough — fine
at one visitor, would have rate-limited as traffic grew. Now:
- The DO's `alarm()` writes the parsed bbox response into `this.snapshot`
  in-memory AND persists it via `this.state.storage.put("snapshot", ...)`.
- The DO constructor uses `state.blockConcurrencyWhile()` to hydrate
  snapshot + per-source backoff state from Durable Storage before serving
  any requests. Cold start / re-deploy doesn't dump visitors onto the
  fallback path.
- New `/live` route on the worker → DO singleton → returns envelope
  `{ ts, ageMs, stale, bbox, ac, sources, backoffUntil }` with
  `Cache-Control: no-store`.
- Browser default polling path is `Api.live(focus, requestedRadius)` (in
  `index.html`). It does a containment check
  `distFromCenter + requestedRadius <= NJ_DO_BBOX.radius (150 nm)` — if the
  visitor's view fits, it uses `/live` (zero upstream calls). Otherwise it
  falls through to the gated direct adsb.lol path via
  `Api.trafficNear` → worker `/v2/*` → `fetchAdsb()`. Rare in practice.

**Multi-source merge (v.0060–v.0061).** The DO's alarm now polls multiple
community sources in parallel each cycle:
- `SOURCES` table at the top of `cloudflare-worker.js` — each entry has
  its own `pathFor()` because **path shape differs between sources**:
  - `adsb.lol`: `/v2/lat/{lat}/lon/{lon}/dist/{nm}`
  - `airplanes.live`: `/v2/point/{lat}/{lon}/{nm}` *(NOT lat/lon/dist!)*
  - adsb.fi was tried (`/api/v3/lat/{lat}/lon/{lon}/dist/{nm}`) — see below.
- `pollSource(source, sourceState)` — never throws, returns a tagged
  result `{ name, status, ac?, count?, backoffMs?, error? }`. Mutates
  per-source backoff on 429 (`Retry-After` honored, capped 5 min,
  default 30 s).
- `mergeAircraft(okResults)` — the merge rules:
  1. **Lowercase the hex** before keying. The browser uses `ac.hex`
     verbatim as a `Map` key with no case normalization — different cases
     across sources would produce duplicate markers.
  2. **Freshest sample wins position** (lowest `ac.seen`). Do not average.
  3. **Backfill missing fields** (flight, squawk, t, category, desc,
     ownOp, year, …) from the older record when the freshest one lacks
     them. Empty arrays / empty strings are valid data, not "missing".
  4. Aircraft in only one source pass through unchanged. That's the win.
- **One `processAircraft()` call per fleet aircraft per tick** from the
  merged list. Calling per-source would break the hysteresis state
  machine (audit §8-E in the read-only audit conversation).
- **Server-side outlier filter** on the distance_nm accumulation in
  `processAircraft()` — mirrors the browser's `ingestFleetSample()` cap
  `max(prev gs, new gs, 200 kt) × 1.6` scaled by elapsed time, 0.25 nm
  slack. Protects `distance_nm` from multi-source jitter. Position itself
  still flows into `aircraft_state` so hysteresis isn't disrupted.
- **Per-source backoff state** (`this.sourceState`) replaces the single
  `this.backoffUntil`. One source 429'ing doesn't disable the others. The
  `/live` envelope only surfaces `backoffUntil` to the browser when EVERY
  source is currently in backoff (= upstream truly delayed).
- **`/live` envelope adds `sources[]`** — per-source health per cycle.
  Used both for verification (`curl '.../live'` to see per-source counts)
  and so the browser can ever expose multi-source UI later if wanted.

**Adsb.fi was tried in v.0060 and pulled in v.0061** because it blocks
Cloudflare Worker egress IPs. Diagnostic process is captured in Section 10
("Things learned this session"). Add it back when their CF block lifts or
when we route through a non-CF host.

**The browser's `/v2/*` gated fallback** uses the existing `fetchAdsb()`
helper which stays adsb.lol-only. That path is rare (outside-NJ views) and
doesn't need multi-source coverage.

**Adsbexchange experiment is fully gone (v.0055→v.0058 archive).** The
`ADSBX_API_KEY` Cloudflare secret may still exist — harmless if so. Run
`npx wrangler secret delete ADSBX_API_KEY` if you want to clean it up.

### 7-E. Status UI — feed-state surfacing

`tick()` reads the `/live` envelope into `state.feedStale`,
`state.feedBackoffUntil`, `state.feedAgeMs`. The status-dot block in
`renderPanel()` has a priority chain:

`ERR > BACKOFF (countdown) > DELAYED (age) > LIVE > CONNECTING`

Amber `.status-dot.warn` distinguishes "data delayed" from "data live" so
frozen positions never look fresh during a backoff. CSS rule lives next to
the existing `.status-dot.ok` / `.status-dot.err` colors.

### 7-F. Mobile UX (v.0049, v.0054)

Map-first layout. Topbar = **☰ + brand + LIVE dot** only (the OPTIONS /
TRAFFIC / HISTORY buttons that live in the topbar on desktop are hidden on
mobile).

Tapping the ☰ slides a side drawer in from the **left**, dimming the map
behind it with a backdrop. Drawer contents:
- **Action buttons** row: ⚙ OPTIONS / 📋 HISTORY / 📡 TRAFFIC (with live
  count badge). Tapping any of these closes the drawer first, then opens
  the corresponding floating panel / overlay.
- **Fleet cards** below: same cards as desktop, click to focus an aircraft —
  drawer auto-closes so the focus shows on the map.

Backdrop tap closes the drawer. `body.drawer-open` is the state class.

iOS-specific fixes:
- `html, body { touch-action: manipulation; }` — prevents accidental
  browser-level pinch-zoom on the chrome (which was pushing the topbar
  above the visible viewport on iOS Safari). Leaflet's map container has
  its own touch handlers, so map pinch-zoom still works.
- `#app { height: 100vh; height: 100dvh; }` — `dvh` follows the dynamic
  URL bar height on iOS, `vh` is the fallback for older browsers. Same
  treatment on the floating-panel `max-height` calcs.

## 8. Process timeline (high-level)

1. **Initial setup** — Cloudflare Worker proxy for adsb.lol, GitHub repo,
   GitHub Pages, custom domain hemsnj.com with HTTPS.
2. **First feature pass (v.0001 → v.0011)** — helicopter icon, fading
   trails, altitude / clock-position on traffic, max-altitude slider, sim
   panel, multi-aircraft restructure, click-to-focus, EC135 photo icon.
3. **Sprite icons (v.0012–0017)** — switched to the adsbx sprite, anchor
   recentered so trails connect at the visual middle.
4. **Flight logging via D1 + DO (v.0019)** — Workers Paid, D1 database,
   TrackerDO. FLIGHT LOG panel reading `/log/flights`.
5. **Precision pass (v.0020–0021)** — click-to-focus re-anchors the
   traffic query; warm-start from `/log/state`; first-observation
   timestamps; OurAirports bulk-imported into D1.
6. **Per-category sprites (v.0022)** — every traffic marker picks a sprite
   cell from its ADS-B category.
7. **Stability + UX (v.0023–0027)** — hard radius clip, 9-second marker
   grace, dropped sticky-fallback bug, parallel `warmStart` + `tick`,
   3000 ft default max altitude.
8. **Per-aircraft visual layer (v.0028–0030)** — `image:` field rendered
   dim behind each fleet card; `mapIcon` + tuning fields.
9. **Floating DEV TOOLS panel (v.0031–0033)** — ⚙ DEV TOOLS opens an
   overlay with sim mode + icon tester (size / rotation / anchor / glow).
10. **Tuned EC135 + N456MT (v.0034–0035)** — final Hackensack EC135 tuning,
    new aircraft RWJB1 with company `"RWJ Life Flight"`.
11. **Airport overlay (v.0036–0039)** — `/log/airports/bbox` endpoint + UI
    dropdown (OFF / AIRPORTS / HELIPORTS / MAJOR / ALL) + SHOW NAMES toggle.
12. **Right panel slim + floating panels (v.0040–v.0042)** — right sidebar
    dropped to just fleet cards. OPTIONS + TRAFFIC + HISTORY moved into the
    topbar (with a small floating-panel slot below them). Mobile compact
    mode (icon-only buttons, shorter brand, taller bottom panel).
13. **Smooth live tracking (v.0043)** — replaced N+1 per-reg fetches with
    a single bbox query. Outlier rejection on each new fleet sample.
    Dead-reckoning animation loop. Fetch timeout 5 → 8 s + ERR suppression
    until 3 consecutive failures. **The "starburst trail" problem is fixed
    here.**
14. **Airport-match buffer (v.0044)** — `AIRPORT_MAX_NM` 0.5 → 2.5 (worker
    + client). Catches the right helipad when the last ADS-B fix before
    landing is a few hundred meters off.
15. **Full-viewport HISTORY (v.0045–v.0048)** — moved HISTORY to its own
    overlay with a dedicated Leaflet map and SVG altitude chart. Initially
    a single LEFT sidebar (fleet + flights stacked), then rearranged to
    3 columns: flights LEFT, map+chart CENTER, fleet picker RIGHT.
    Per-card 📋 button removed (now topbar-only).
16. **Mobile rework (v.0049)** — bottom-curtain drawer scrapped, replaced
    with a left-side drawer + hamburger trigger. Action buttons live
    inside the drawer on mobile. Map fills almost the whole screen.
17. **Five new aircraft (v.0050)** — N135TJ (JeffSTAT-1), N137MH
    (Cooper-1), N3NJ (CentralSTAR), N5NJ (NorthSTAR), N9NJ (SouthSTAR).
    Worker `FLEET_REGS` updated, DO started polling them.
18. **Planespotters photo integration (v.0051–v.0053)** — `/log/photo`
    worker endpoint, self-contained `AircraftPhoto` module. Cards get
    auto-photos. Per-tick "blink" fixed by embedding photo HTML inline
    from cache. Popups also show photos (sync embed + async fetch on
    popupopen).
19. **iOS topbar fix (v.0054)** — `touch-action: manipulation` to prevent
    accidental browser pinch-zoom on the chrome (the disappearing-topbar
    bug). `100dvh` for layout heights so iOS Safari's URL bar dynamics
    don't break things.
20. **Dual-feed ADS-B experiment (v.0055–v.0058)** — added a worker-side
    `fetchAdsb()` helper that tried adsbexchange (RapidAPI) as fallback,
    briefly flipped adsbexchange to primary in v.0056, reverted same day
    in v.0057 (user is on $10 Basic — 10k/mo cap), then removed the
    entire fallback in v.0058. adsb.lol-only at that point.
21. **Shared live snapshot (v.0059)** — new `/live` route on the worker
    served from the DO's in-memory + Durable Storage snapshot. Browser
    polls `/live` instead of `/v2/*`, so upstream call rate to adsb.lol
    becomes flat 1/3 s regardless of visitor count. 429 backoff honors
    `Retry-After`. UI surfaces stale + backoff via amber `.status-dot.warn`.
22. **3-source merge attempted, 1 source pulled (v.0060–v.0061)** —
    parallel `Promise.allSettled` poll of adsb.lol + airplanes.live +
    adsb.fi inside `alarm()`. Merge dedupes by lowercased hex, freshest
    `seen` wins position, missing fields backfilled. Single
    `processAircraft()` call per fleet aircraft per tick from the merged
    list (per the architecture-audit guidance). Server-side outlier
    filter on `distance_nm`. Per-source backoff state. adsb.fi pulled
    after confirming an IP/ASN block on Cloudflare Worker egress (same UA
    returns 200 from a home IP, 403 from inside the worker — see Section
    10). Currently 2 active sources, ~15-20 union-gain aircraft per cycle.

## 9. Current state

- **Live at hemsnj.com**, version **v.0061**.
- **Fleet: 8 aircraft, 5 companies** (see Section 5 for the colors):
  - `N732HM` — "Hackensack 2" — Brick (40.0783 / -74.1321), `pictures/732hm.png`, custom EC135 icon
  - `N551HU` — "Hackensack 1" — West Milford (41.1328 / -74.3406), `pictures/511HU.png`, custom EC135 icon
  - `N456MT` — "RWJB1" — KMJX Ocean County (39.9288 / -74.2954), `pictures/n456mt.png`, custom LifeFlight EC135 icon
  - `N135TJ` — "JeffSTAT-1" — Jefferson Washington Twp Hospital (39.7351 / -75.0656). **No manual photo yet — auto-photos via Planespotters if available.**
  - `N137MH` — "Cooper-1" — Flying W Airport (N14) Medford (39.9339 / -74.8080). Auto-photos.
  - `N3NJ` — "CentralSTAR" — Waretown approx (39.7939 / -74.2232). **Base coords are approximate** — "200 Volunteer Way" wasn't in OSM; replace with exact lat/lon if the user provides one.
  - `N5NJ` — "NorthSTAR" — Somerset Airport KSMQ (40.6257 / -74.6697). Auto-photos.
  - `N9NJ` — "SouthSTAR" — Hammonton Municipal N81 (39.6682 / -74.7568). Auto-photos.
- **Worker**: deployed via `wrangler deploy`. DO + D1 + cron + `/log/photo`
  proxy all active.
- **D1**: `airports` populated (~25k US heliports + airports), `flights`
  mostly empty (user has logged a few real flights from N456MT — the
  history overlay can show them).

## 10. Things learned this session — patterns + mistakes to avoid

This section is mostly for the next Claude session, but the user reads it
too. These are things that actually came up in the v.0059–v.0061 work and
saved (or could have saved) significant cycles.

### Diagnostic patterns that worked

- **The user asks for "show me the plan + diff BEFORE you edit"** for any
  meaningful change. Treat that as a hard requirement on architectural work
  — they catch ambiguities and unit mismatches that would have shipped
  silently. The wrangler-tail check on the shared-snapshot work is the
  canonical example: they declared it "mandatory because it's the only
  thing that catches a units mismatch."
- **Verify units before writing the containment math.** Every distance
  constant in this project is **nautical miles** end-to-end. `distanceNm()`
  → nm (via `NM_PER_KM * km` haversine), `state.radiusNm` → nm,
  `BBOX_RADIUS_NM = 150` → nm, adsb.lol's `dist` path param → nm,
  `NJ_DO_BBOX.radius = 150` → nm. If something introduces km/meters
  silently, every visitor falls through to the gated upstream and you
  won't see it without watching `wrangler tail`.
- **A 403 means the server responded.** It is NOT a network/firewall
  block at our end — the request reached them, they refused it at the
  application layer. Don't say "firewall block" when you mean "their
  app-layer rejection." Likely causes for community APIs: cloud/datacenter
  egress IP filtering, generic User-Agent screening, IP reputation.
- **Verify per-source response shapes BEFORE designing the merge.**
  airplanes.live uses `/v2/point/{lat}/{lon}/{nm}` — different path from
  the other two. I assumed all three would mirror adsb.lol's path; that
  cost a probing cycle. Always curl each source's example URL with
  `python -m json.tool` before committing to a merge contract.
- **Read raw README before writing code.** `WebFetch` summarizes — that's
  useful for orientation but it can drop critical rules. The adsb.fi
  README has a key line: *"Requests returning a 400, 401, 403, 404, or
  429 status code count toward the limit. ... excessive invalid HTTP
  requests results in a temporary IP address restriction."* WebFetch's
  summary obscured this. Use `curl` on the raw `.md` for important docs.

### Sloppy reasoning the user corrected me on

- **I once called the adsb.fi 403 a "Cloudflare-to-Cloudflare firewall
  block."** Wrong. They are themselves served via Cloudflare, but the 403
  came from their application — could be a CF Rule they wrote, could be
  their backend code. Either way it's an application-layer rejection, not
  "network firewall." User caught this immediately.
- **I brought up adsb.fi's "personal, non-commercial only" terms.** User
  pushed back hard: this is a non-commercial personal project, the user is
  the pilot of one of the helicopters, the site actively costs them money,
  and the terms don't factor in to the technical question of "can we reach
  them from a CF Worker." Lesson: **separate technical from policy** —
  don't smuggle in policy framing on a technical conversation, and when
  the user has already told you commercial framing doesn't apply, drop it.
- **I jumped to "remove adsb.fi" without doing the cheap test first.**
  The user re-routed me: "before pulling adsb.fi, do ONE cheap test —
  swap to a real app-identifying User-Agent and check if it still 403s."
  Cheap tests before destructive changes. They were right; the answer was
  still "remove" but the test confirmed it was IP-based not UA-based,
  which is genuinely useful information to record (in the comment above
  `SOURCES` so a future session doesn't re-try the same thing).
- **I didn't proactively show per-source health when the user wanted it.**
  They had to explicitly ask me to dump per-source counts. Lesson: when
  you ship multi-source infrastructure, **show the per-source health in
  the same message** as the deploy confirmation. Don't make the user pull
  it.

### Where to look if a third source comes back

The merge code in `cloudflare-worker.js` is set up so adding a source is
literally one entry in the `SOURCES` array. Each entry needs:
1. A unique `name` string.
2. A `host` (no trailing slash).
3. A `pathFor({ lat, lon, nm })` builder — **don't assume the shape;
   verify from their docs / curl first**.
4. The response must be ADSBexchange-v2-compatible (`{ ac: [...] }` with
   `hex`, `r`, `lat`, `lon`, `alt_baro`, `gs`, `track`, etc. on each `ac`
   record), or the merge will produce garbage. `pollSource` does no
   field-mapping today.

If you want to try adsb.fi again later (their CF block lifts, or you route
through a non-CF host), add it back at the right path:
`https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}`. Their
rate limit is 1 req/sec (we'd be at 1/3 s — fine).

If you're considering a brand-new source: candidates that have worked or
been mentioned include OpenSky Network (auth-free at ~100 req/hr —
probably too tight at 3 s cadence without batching), and other readsb /
tar1090-ecosystem feeds. Verify the path + response shape and add the row.

## 11. Where the project is heading

Realistic short-term direction based on the user's stated priorities:

- **Fleet growth toward 15–20 aircraft.** User has said this explicitly.
  Section 13 (common operations) has the "add an aircraft" recipe — it's
  mostly a 5-min job. Photos + per-aircraft icon tuning trail behind.
- **Real flight data accumulating.** The DO state machine + outlier
  filter + per-aircraft photos all work today; the system is waiting on
  helicopters actually flying so the user can see the HISTORY overlay
  populated with real altitude profiles + maps. There's nothing to build
  here — just patience + watching the D1 grow.
- **Adsb.fi might come back** if their CF block lifts (we'd see it the
  next time someone re-tests). Worth doing once a month — a single curl
  from inside the worker (via a debug route, or just re-adding to
  SOURCES briefly) tells you.
- **Per-aircraft icon tuning** for the new fleet (especially the State
  Police birds — `map-icons/AW139Trooper.png` already exists and could
  be wired up). User uses the in-app DEV TOOLS icon tester to dial these
  in and pastes the snippet back.
- **Manual card photos.** Planespotters auto-photos cover most cases,
  but the user may want hand-picked PNGs for some entries (already done
  for the 3 Hackensack / RWJ aircraft). `cfg.image` always wins.

Things the user has explicitly said NOT to prioritize:
- Emergency squawk highlighting.
- Receiver-side decoding / self-hosting ADS-B.
- Mobile-app conversion (was discussed; user decided PWA-only path is
  enough if they ever want it).

Things that *might* eventually matter but haven't been pushed for:
- **A non-CF egress path** if adsb.fi (or future sources) stay
  blocking-CF-Workers. Would mean either renting a tiny VPS to proxy, or
  using a cheap host for the egress side of fetches. Significant infra
  change; only worth it if a key source insists.
- **Caching at the worker edge** on a few of the D1-backed endpoints
  (`/log/airports/bbox`, `/log/flights`). Currently served fresh per
  request — fine at current traffic, would matter at scale.

## 12. Outstanding / likely next requests

- **Manual card photos for the new aircraft.** Planespotters auto-photos are
  applied, but the user might want to drop hand-picked PNGs into `pictures/`
  and reference them via `cfg.image`. When they hand you a filename, add
  the field — `cfg.image` always wins over auto-photo.
- **Exact base for N3NJ CentralSTAR.** Right now it's Waretown center
  because "200 Volunteer Way" isn't in OSM. If the user provides exact
  lat/lon, just patch the FLEET entry.
- **More aircraft** — same template as Section 13.
- **Per-aircraft icon tuning.** User uses the icon tester in DEV TOOLS,
  copies the snippet, pastes it back; you splice it into the FLEET entry
  and bump version.
- **Custom `map-icons/*.png`** for the new aircraft — the State Police
  helos especially (real ones are AW139 Trooper birds, there's already an
  `AW139Trooper.png` in `map-icons/` that could be wired up).
- **More flight logs in D1.** Once the new aircraft fly, the HISTORY
  overlay's altitude chart + dedicated map + clean trail rendering
  becomes much more useful.

## 13. How to do common operations

### Add an aircraft
1. In `index.html`, append a new `FLEET` entry. Required: `registration`,
   `label`, `color` (match company, or new distinct hex per
   `feedback_company_color.md`), `kind`, `company`, `base.lat/lon`.
   `base.name` is internal data — won't show.
2. If you only got an address: geocode via Nominatim
   (`https://nominatim.openstreetmap.org/search?q=…&format=json&limit=1`)
   with a custom `User-Agent`. If Nominatim doesn't find it, try Photon
   (`https://photon.komoot.io/api/?q=…`). Some street addresses just
   aren't in OSM (CentralSTAR's "200 Volunteer Way" being a recent
   example) — fall back to the town's center coords + a comment in the
   `base.name`.
3. In `cloudflare-worker.js`, add the registration to `FLEET_REGS`.
4. `wrangler deploy` from the project dir (PATH includes
   `/c/Users/ddt19/AppData/Roaming/npm` + `/c/Program Files/nodejs`).
5. Bump version, commit, push. Verify the new version label on hemsnj.com.

### Push a change
- Bump `<div id="version">v.NNNN</div>` first.
- `git add <files> && git commit -m "…" && git push`.
- Poll `https://hemsnj.com/` for the new version label.

### Redeploy the worker
- `wrangler deploy` from the project dir. Wrangler reads `wrangler.toml`
  and pushes `cloudflare-worker.js`.

### Use the icon tester
- Open DEV TOOLS via the 🛠 DEV button (bottom-left, near the version
  label — desktop only; hidden on mobile).
- User uploads a PNG locally → applies live to N732HM's marker → scrubs
  sliders (size, rotation, anchor Y, glow opacity, glow size, glow color)
  → clicks 📋 COPY CONFIG.
- They paste the snippet to you; you splice it into the matching FLEET
  entry, bump version, commit, push.

### Re-import airports (rare)
- `node populate-airports.mjs` — re-fetches OurAirports, regenerates
  `airports.sql`, runs `wrangler d1 execute hemstracker-logs --file=airports.sql --remote`.
  Safe to re-run; first SQL statement is `DELETE FROM airports`.

### Preview locally
- `.claude/launch.json` already configures a Python http.server on port
  8765. Use the `mcp__Claude_Preview__preview_start` tool with
  `name: "static"`, then `preview_resize` to mobile/desktop, then
  `preview_eval` / `preview_inspect` for verification. Screenshots
  sometimes time out under load — inspector + eval are more reliable.

### Find / change a sprite icon
1. View `icons.webp` (Read tool works for images). Count cells
   **1-indexed**: row 1 = top, col 1 = leftmost.
2. Update the entry in `CATEGORY_SPRITE` in `index.html`. The
   `background-position` is computed from the `[row, col]` tuple
   automatically.

### Working with the Planespotters photo system
- The module is intentionally self-contained. Add new integration points
  by calling `AircraftPhoto.inlineMarkup()` or `AircraftPhoto.popupMarkup()`
  in your render code, then optionally `AircraftPhoto.decorateCard()` for
  the async fallback. Do **not** touch the cache or fetch internals — the
  isolation contract is what makes this safe to add features around.
- Adding photos in a new spot (e.g., the history overlay's stats strip):
  - Call `AircraftPhoto.getCached({hex})` synchronously when rendering
  - If null, call `AircraftPhoto.fetchPhoto({hex})` async — by the time
    the user comes back, cache will be warm.

## 14. Endpoints + commands cheat sheet

```bash
# Worker health / endpoint list
curl https://hemstracker.deltasteelfox92.workers.dev/

# Shared live snapshot — what the browser polls every 3s. Returns
# { ts, ageMs, stale, bbox, ac:[...], sources:[...], backoffUntil }.
# `sources` carries per-source health for verification.
curl -s https://hemstracker.deltasteelfox92.workers.dev/live \
  | python -c "import sys,json; d=json.load(sys.stdin); print(f'merged={len(d[\"ac\"])} ageMs={d[\"ageMs\"]}'); [print(f'  {s[\"name\"]:18} {s[\"status\"]:10} count={s[\"count\"]}') for s in d['sources']]"

# Current state of every tracked aircraft
curl https://hemstracker.deltasteelfox92.workers.dev/log/state

# Flight history (all aircraft, newest first, limit 30)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flights?limit=30'

# Flight history filtered to one aircraft
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flights?reg=N732HM'

# Full track points for a flight
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flight/<flight-id>/track'

# Nearest airport for a lat/lon (debug)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/airport?lat=40.078&lon=-74.132'

# All airports within a bbox (powers the airport overlay)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/airports/bbox?n=41.5&s=39.5&e=-73.5&w=-75.5'

# Aircraft photo proxy (Planespotters; 24h CF cache)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/photo?reg=N3NJ'
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/photo?hex=a3f930'

# Live position of one aircraft via the gated browser fallback path.
# /v2/* routes through fetchAdsb() — adsb.lol only. Used only when a
# visitor's view falls outside the DO's NJ bbox; default browser path is /live.
curl https://hemstracker.deltasteelfox92.workers.dev/v2/reg/N732HM
```

```bash
# Deploy worker
wrangler deploy

# Tail worker logs in real time
wrangler tail

# Direct query on D1
wrangler d1 execute hemstracker-logs --remote --command "SELECT * FROM aircraft_state"
wrangler d1 execute hemstracker-logs --remote --command "SELECT * FROM flights ORDER BY takeoff_time DESC LIMIT 10"
wrangler d1 execute hemstracker-logs --remote --command "SELECT COUNT(*) FROM airports"
```

---

**TL;DR for the next session:** Read the memory files. Read this doc.
Read CLAUDE.md (it's the architectural quick-reference for the data-fetch
path specifically). The user will probably hand you more tail numbers +
addresses to add, request manual card photos, ask for icon tuning, or
report a mobile glitch. Bump the version, deploy the worker if you
touched it, push to GitHub. The smooth-tracking pipeline, HISTORY overlay,
AircraftPhoto module, and shared-snapshot fetch path are intentionally
self-contained — if you add features, follow that isolation pattern.
**On anything architectural: show a plan + diff BEFORE you edit and
include a verification step the user can run themselves (e.g.
`wrangler tail` + per-source counts). Section 10 has the patterns and
the mistakes I made this session so you can skip them.**
