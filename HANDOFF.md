# HEMS Tracker — Handoff for the next session

This document brings a fresh Claude Code session up to speed quickly. Read it
end-to-end before making changes. Memory files in `~/.claude/projects/.../memory/`
also auto-load and reinforce the conventions below.

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

## 2. What the user wants

Build a **single-pane HEMS dispatch tracker** for helicopters in NJ and nearby
states. Eventually 15–20 aircraft across multiple operators. Priorities, in order:

1. **Precise tracking** of fleet aircraft — accurate takeoff/landing times and
   locations. 3-second polling cadence is the baseline; never accept slower.
2. **Awareness of nearby traffic** around whichever fleet aircraft is currently
   focused — distance, altitude (when close), clock position relative to nose.
3. **Flight history** — every flight every aircraft ever took, with route
   (airport → airport), duration, max alt, max speed, distance, replayable track.
4. **Multi-aircraft, multi-company** layout — no aircraft is "the center"; the
   user picks who's focused by clicking a fleet card.

Things explicitly **not** important to the user (as of the last session):
- Emergency squawk highlighting (cool but not a priority)
- Receiver-side decoding / self-hosted ADS-B (data from adsb.lol is enough)

## 3. Current architecture

```
                       Cloudflare (Workers Paid, ~$5/mo)
                       ─────────────────────────────────
   browser ─ /v2/* ──► hemstracker worker ──► api.adsb.lol
   browser ─ /log/* ─► hemstracker worker ──► TrackerDO ──► D1 (hemstracker-logs)
                                                ▲
                                                │ self-scheduled alarm every 3 s
                                                │ + cron heartbeat * * * * *
                                                ▼
                                          api.adsb.lol (bbox 150nm around NJ)
```

- **Browser** (GitHub Pages, hemsnj.com): polls adsb.lol via the worker every
  3 sec for live display. Independent of the DO.
- **TrackerDO** (Durable Object): self-schedules a 3-second alarm, polls
  adsb.lol via bbox, runs a state machine on each fleet aircraft, writes flight
  records to D1. The cron is a heartbeat in case the alarm stalls.
- **D1 `hemstracker-logs`**: 5 tables — `aircraft_state`, `flights`,
  `track_points`, `airports` (25,097 US heliports/airports from OurAirports).
- **Sprite system**: `icons.webp` (the public adsbx aircraft sprite, 575×791,
  ~8 cols × 11 rows of ~72×72 cells). Per-category cells mapped in
  `CATEGORY_SPRITE` near the top of `index.html`. 1-indexed.

### State machine knobs (cloudflare-worker.js)

| Constant | Value | Purpose |
|---|---|---|
| `POLL_INTERVAL_MS` | 3000 | DO alarm cadence |
| `CONFIRMATIONS_NEEDED` | 3 | Hysteresis ticks before state transition (~9 s) |
| `GROUND_ALT_FT` / `GROUND_GS_KT` | 100 / 30 | Threshold for "on ground" if `alt_baro != "ground"` |
| `BBOX_CENTER` / `BBOX_RADIUS_NM` | 40.6/-74.3 / 150 nm | Polling area covering NJ + adjacent states |
| `AIRPORT_MAX_NM` | 0.5 nm | Tolerance for "took off / landed at this airport" |

### Precision notes
- Takeoff/landing time + position are recorded from the **first** tick where
  the new candidate state was observed, **not** from confirmation. This
  removed a 6–9 sec systematic offset.
- The browser separately polls `/v2/reg/<reg>` per aircraft for live display.
  This costs roughly 1 sec per call (adsb.lol per-reg lookup is slow). The DO's
  bbox polling is faster and the source of truth for logs.

## 4. File map

| File | What it is |
|---|---|
| `index.html` | The entire frontend. Single page. Leaflet for the map. |
| `cloudflare-worker.js` | The worker code (proxy + DO + `/log/*` endpoints). |
| `wrangler.toml` | wrangler deploy config — bindings, migrations, cron. |
| `populate-airports.mjs` | One-off (safe to re-run) Node script that fetches OurAirports CSV and bulk-imports US airports into D1 via `wrangler d1 execute`. |
| `icons.webp` | Aircraft sprite (adsbx public icons). Sprite math: 256×352 scaled, each cell 32×32. |
| `CNAME` | Just `hemsnj.com` for GitHub Pages. |
| `SETUP-cloudflare.md` | Original end-user worker setup walkthrough — outdated now (predates DO). Doesn't hurt anything. |
| `HANDOFF.md` | This document. |

Memory files (auto-loaded by Claude) live in
`C:\Users\ddt19\.claude\projects\C--Users-ddt19-Documents-tracker-files\memory\`.

## 5. Key conventions the user has reinforced

These are sticky. Honor them by default — they have memory notes backing them.

| Convention | Memory note |
|---|---|
| **Bump VERSION (in index.html) before every commit.** Format `v.NNNN`. Single literal in the HTML, marked with comment. User uses it to verify the deployed build on hemsnj.com. | `feedback_version_bumping.md` |
| **One color per company.** All aircraft from a company share a hex. New company → new distinct color. | `feedback_company_color.md` |
| **No addresses in the UI.** Base addresses are positioning input only. Never render them in cards or popups. The airport DB name (e.g., "Ocean University Medical Center Heliport") wins over `FLEET[i].base.name` when both match. | `feedback_no_address_in_ui.md` |
| **Grid coordinates are 1-indexed.** When user says "row 6 col 7", that's the 6th row down and 7th col from left, both starting at 1. | `feedback_one_indexed_grids.md` |

## 6. Process timeline (high-level)

1. **Initial setup** — Cloudflare Worker proxy for adsb.lol, GitHub repo,
   GitHub Pages, custom domain hemsnj.com with HTTPS.
2. **First feature pass (v.0001 → v.0011)** — helicopter icon, fading trails,
   altitude / clock-position on traffic, max-altitude slider, sim panel for
   testing without flying, multi-aircraft restructure, click-to-focus, EC135
   photo icon (later replaced).
3. **Sprite icons (v.0012–0017)** — switched fleet helicopter from photo to
   the adsbx sprite (`icons.webp`, row 6 col 7, 1-indexed). Anchor recentered
   so trail lines connect at the visual middle of the icon.
4. **Flight logging via D1 + DO (v.0019)** — upgraded Cloudflare to Workers
   Paid, created D1 database, wrote the TrackerDO. **wrangler CLI** is
   required for DO setup (dashboard alone can't create new DO namespaces).
   Browser added FLIGHT LOG panel reading `/log/flights`; click a row to draw
   the saved track on the map.
5. **Precision pass (v.0020–0021)** — fixed click-to-focus not re-anchoring
   the traffic query; warm-start from `/log/state` so the map paints in
   ~100 ms instead of waiting for the first adsb.lol round-trip; first-
   observation timestamps for takeoff/landing (was 6–9 s late); OurAirports
   bulk-imported into D1 for `airport_takeoff` / `airport_landing` lookups.
6. **Per-category sprites (v.0022)** — every traffic marker now picks a
   sprite cell based on ADS-B category. Table in `CATEGORY_SPRITE` is easy to
   re-edit; the user has flagged that they'll **manually rework these icons
   later**, so don't get attached.
7. **Stability + UX (v.0023–0027)** — hard radius clip (was showing aircraft
   slightly outside the requested bbox), 9-second marker grace (transient
   ADS-B drops no longer blink the marker), dropped sticky-fallback bug in
   the Api wrapper (was getting locked on flaky allorigins proxy after one
   worker hiccup), 5-sec fetch timeouts, parallel `warmStart` + `tick`,
   immediate `render()` on `DOMContentLoaded`, default MAX ALTITUDE raised
   to 3000 ft.

## 7. Current state

- **Live at hemsnj.com**, version `v.0027`.
- **Fleet (2 aircraft):**
  - `N732HM` — "Hackensack 2", base 40.078262 / -74.132108
    (Ocean University Medical Center Heliport in OurAirports).
  - `N551HU` — "Hackensack 1", base 41.1327789 / -74.3405939
    (Greenwood Lake Airport area).
  - Both under company `"Hackensack"`, color `#0080ff` (blue).
- **Worker**: deployed via `wrangler deploy`. DO + D1 + cron all active.
- **D1**: `airports` populated (~25k US heliports + airports), `flights` empty
  (no flights logged yet because both Hackensacks have been parked).

## 8. Outstanding / likely next requests

- **More aircraft.** User explicitly plans 15–20. When they give you a tail
  number + base location (address OR lat/lon — either is fine), you add a
  FLEET entry in `index.html` AND extend `FLEET_REGS` in `cloudflare-worker.js`,
  then `wrangler deploy`. Match the company color or assign a new one (see
  `feedback_company_color.md`).
- **Manual sprite rework.** User has said they'll re-pick sprite cells for
  some/all categories. Just listen to row/col (1-indexed) and update
  `CATEGORY_SPRITE` in `index.html`.
- **Real flight in D1.** Once a Hackensack flies for real, you can verify
  end-to-end logging (takeoff time, landing time, airport-to-airport line in
  the FLIGHT LOG panel). Until then, sim-mode in the right panel is the
  closest thing — but sim is browser-only and doesn't hit the DO, so it
  won't generate D1 entries.
- **Smarter fleet polling.** The browser currently calls `/v2/reg/<reg>` per
  aircraft each tick. At 15–20 aircraft that's 15–20 calls of ~1 sec each. If
  responsiveness degrades, switch the browser to a single bbox query and
  filter by registration locally (the DO already does this). Or have the
  browser read fleet state from `/log/state` and let the DO be the only thing
  hitting adsb.lol for fleet positions.

## 9. How to do common operations

### Add an aircraft
1. In `index.html`, append a new `FLEET` entry. Required: `registration`,
   `label`, `color` (same as other helos from the company), `kind`,
   `company`, `base.lat/lon`. `base.name` is internal data — won't show.
2. If you only got an address: geocode it. Either follow a Google Maps short
   link (the redirect URL contains `@lat,lon`), or query Nominatim
   (`https://nominatim.openstreetmap.org/search?q=…&format=json&limit=1`).
   Be respectful to Nominatim — set a `User-Agent` header.
3. In `cloudflare-worker.js`, add the registration to `FLEET_REGS`.
4. `cd "C:\Users\ddt19\Documents\tracker\files" && wrangler deploy` (the user's
   wrangler is authed; `PATH` is `/c/Users/ddt19/AppData/Roaming/npm` +
   `/c/Program Files/nodejs`).
5. Bump version, commit, push. Pages deploy lands in ~30–60 sec.

### Push a change
- Bump `<div id="version">v.NNNN</div>` first.
- `git add <files> && git commit -m "..." && git push`.
- Poll `https://hemsnj.com/` for the new version label to confirm Pages
  finished serving the new build.

### Redeploy the worker
- `wrangler deploy` from the project dir. Wrangler reads `wrangler.toml` and
  pushes `cloudflare-worker.js`. New `[[migrations]]` entries are how you'd
  evolve the DO class if you ever change it.

### Re-import airports (rare)
- `node populate-airports.mjs` — re-fetches OurAirports, regenerates
  `airports.sql`, runs `wrangler d1 execute hemstracker-logs --file=airports.sql --remote`.
  Safe to re-run; first SQL statement is `DELETE FROM airports`.

### Find / change an icon
1. View `icons.webp` (Read tool works for images). Count cells **1-indexed**:
   row 1 = top, col 1 = leftmost.
2. Update the relevant entry in `CATEGORY_SPRITE` in `index.html`. The math is:
   `background-position: -((col-1)*32)px -((row-1)*32)px`. The script computes
   this automatically from the `[row, col]` tuple.

## 10. Useful endpoints + commands cheat sheet

```bash
# Worker health
curl https://hemstracker.deltasteelfox92.workers.dev/

# Current state of every tracked aircraft
curl https://hemstracker.deltasteelfox92.workers.dev/log/state

# Flight history (all aircraft, newest first, limit 30)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flights?limit=30'

# Flight history filtered to one aircraft
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flights?reg=N732HM'

# Full track points for a flight (id from the flights response)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/flight/<flight-id>/track'

# Nearest airport for a lat/lon (debug / sanity check)
curl 'https://hemstracker.deltasteelfox92.workers.dev/log/airport?lat=40.078&lon=-74.132'

# Live position of one aircraft (browser uses this per-fleet per-tick)
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
```

---

**TL;DR for the next session:** Read the memory files. Read this doc. The user
will probably hand you more tail numbers + addresses to add to the fleet, or ask
you to re-pick some sprite icons. Bump the version, deploy the worker if you
touched it, push to GitHub. Don't make the page look like it revolves around any
single aircraft — the user has multiple operators on the way.
