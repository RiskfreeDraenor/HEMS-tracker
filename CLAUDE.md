# CLAUDE.md — HEMS Tracker architecture quick-reference

> Single-page live aircraft tracker for HEMS helicopters in NJ.
> Domain: **hemsnj.com**. Backend: Cloudflare Worker + Durable Object + D1.
> Full onboarding lives in **HANDOFF.md** — this file is the tight reference
> for the data-fetch path. Read both before making architectural changes.

---

## Live data fetch architecture (v.0061)

The previous design had every browser tab polling `api.adsb.lol` independently
every 3 s through the worker as a passthrough. Fine at 1–2 visitors, but
upstream call rate scaled linearly with traffic and would have gotten the site
rate-limited as it grew. The current design centralizes polling on the Durable
Object and **merges multiple ADS-B sources** so upstream call rate stays flat
at N source-calls per 3 s (currently N=2) regardless of visitor count.

```
┌──────────┐  /live (3s)    ┌─────────────┐  Promise.allSettled per tick:
│ browser1 │ ─────────────► │             │ ─► api.adsb.lol   /v2/lat/.../dist
│ browser2 │ ─────────────► │  TrackerDO  │ ─► api.airplanes.live /v2/point/...
│ browser3 │ ─────────────► │  (in-mem +  │   (adsb.fi tried + pulled —
│   ...    │ ─────────────► │   Durable   │    blocks CF Worker egress IPs,
└──────────┘                │   Storage)  │    see v.0060→v.0061 below)
                            └─────────────┘
                                   ▲
                                   └─ alarm() merges responses → snapshot.ac,
                                      processAircraft × FLEET_REGS off the
                                      single merged list
```

### Key points

- **The DO polls all configured sources every 3 s in parallel** via
  `Promise.allSettled(SOURCES.map(pollSource))` inside `alarm()`. Each
  `SOURCES` entry has its own `pathFor({lat,lon,nm})` because path shape
  differs between providers (airplanes.live uses `/v2/point/{lat}/{lon}/{nm}`
  while adsb.lol/adsb.fi use `/v2/lat/.../lon/.../dist/...`). The bbox is
  `BBOX_CENTER 40.6/-74.3` × `BBOX_RADIUS_NM 150` for all sources.
  Successful responses go through `mergeAircraft()` (next bullet); the
  merged list is stored in `this.snapshot` and persisted to Durable Storage.
- **mergeAircraft() rules**: hex is lowercased before being used as the
  dedup key (the browser uses `ac.hex` verbatim as a Map key, so case
  drift between sources would create duplicate markers). Freshest sample
  (lowest `ac.seen`) wins position — we don't average. Missing fields on
  the freshest record are backfilled from older records, so `flight` /
  `squawk` / `t` / `category` / `desc` etc. survive even if only one
  source carries them. Aircraft seen by only one source pass through
  unchanged — that's the whole point.

- **Browsers read from `/live`, not `/v2/*`.** The main worker `fetch()`
  routes `/live` to the DO singleton, which returns
  `{ ts, ageMs, stale, bbox, ac, backoffUntil }` from its in-memory snapshot
  with `Cache-Control: no-store`. **No upstream call on this path.**

- **Durable Storage persists the snapshot for cold-start resilience.**
  The DO constructor uses `state.blockConcurrencyWhile(...)` to hydrate
  `snapshot` + `backoffUntil` from storage before serving any requests.
  A worker re-deploy or DO eviction restores instantly — without this,
  every connected visitor would briefly fall through to the gated direct
  adsb.lol path while waiting for the next alarm.

- **Per-source 429 backoff is honored.** `this.sourceState[name].backoffUntil`
  is set independently per source. `pollSource()` reads `Retry-After`
  (numeric seconds OR HTTP-date), caps 5 min, defaults 30 s. One source
  going into backoff does NOT block the others — the merge keeps running
  with whoever's healthy. `/live` only surfaces `backoffUntil` to the
  browser when EVERY source is in backoff (= upstream truly delayed).
  Successful poll clears that source's backoff.
- **Server-side outlier filter on processAircraft's distance accumulation**
  mirrors the browser's `ingestFleetSample()` cap (`max(prev gs, new gs,
  200 kt) × 1.6` × elapsed time, 0.25 nm slack). Skips the distance add
  on impossible jumps; the position itself still flows into
  `aircraft_state` so the hysteresis state machine isn't disrupted.

- **Direct `api.adsb.lol` remains as a GATED fallback.** In `index.html`,
  `Api.live(focus, requestedRadius)` checks
  `(distFromCenter + requestedRadius) <= NJ_DO_BBOX.radius` (150 nm).
  If the view falls outside the DO's bbox (e.g. panned to Boston), it
  falls through to `Api.trafficNear(...)` → direct adsb.lol via the
  worker's `/v2/*` passthrough. This is rare. **Don't remove this path** —
  it's the safety net for outside-NJ views.

- **`allorigins.win` is gated off.** `ENABLE_PUBLIC_PROXY_FALLBACK = false`
  by default. Public CORS proxies have their own rate limits and were a
  liability when the worker degraded.

### UI surfaces feed state

`tick()` reads the envelope into `state.feedStale`, `state.feedBackoffUntil`,
`state.feedAgeMs`. The status-dot block in `renderPanel()` priority chain:

`ERR > BACKOFF (countdown) > DELAYED (age) > LIVE > CONNECTING`

Amber `.status-dot.warn` distinguishes "data delayed" from "data live" so
frozen positions never look fresh during a 429 outage.

### Units sanity check

All distance math is **nautical miles** end-to-end:
`distanceNm()` returns nm (via `NM_PER_KM * km` haversine), `state.radiusNm`
+ `bboxRadius` are nm, adsb.lol's `dist` path param is nm, `BBOX_RADIUS_NM`
= 150 nm, `NJ_DO_BBOX.radius` = 150 nm. The containment check works because
every term is in the same unit. If a future change introduces km/meters
anywhere in this path, the containment will silently fail and every visitor
will fall through to the upstream — verify with `wrangler tail` after any
change here.

---

## What NOT to change without thinking carefully

- **Don't increase the DO poll cadence below 3 s.** Community sources run on
  goodwill — going to 1 s polling per source could get the project blocklisted.
- **Don't shrink `BBOX_RADIUS_NM` below 150.** It needs to cover all fleet
  bases + each visitor's traffic radius. Smaller would push more visitors
  onto the gated fallback.
- **Don't remove the gated direct fallback.** Outside-NJ views legitimately
  need it.
- **Don't normalize hex anywhere upstream of `mergeAircraft()` without
  preserving the lowercased form downstream.** The browser uses `ac.hex`
  verbatim as a Map key — case-mismatched hexes produce duplicate markers
  silently. The merge is the single point where this happens.
- **Don't call `processAircraft` once per source per tick.** Hysteresis
  state machine accumulates `candidate_count` only when same candidate
  state is seen consecutively; per-source loops would reset that. Always
  feed the SINGLE merged list (see `alarm()` for the pattern).
- **Don't add a third party / paid feed as primary** without first checking
  the user's plan tier and projected call volume — see HANDOFF Section 7-D
  for the adsbexchange v.0055–v.0058 story and Section 10 for the
  diagnostic patterns that came out of v.0060–v.0061.

---

## Code map for this design

| What | File | Notes |
|---|---|---|
| Shared upstream fetch helper | `cloudflare-worker.js` (`fetchAdsb`) | adsb.lol only since v.0058 |
| DO constructor + storage hydration | `cloudflare-worker.js` (`TrackerDO.constructor`) | `blockConcurrencyWhile` load |
| DO poll loop + 429 + snapshot store | `cloudflare-worker.js` (`TrackerDO.alarm`) | writes mem + storage |
| `/live` route handler (DO) | `cloudflare-worker.js` (`TrackerDO.fetch`) | served from snapshot |
| `/live` route (main worker) | `cloudflare-worker.js` (default `fetch`) | routes to DO singleton |
| Browser live polling | `index.html` (`Api.live`) | envelope + containment + gated fallback |
| Browser state for envelope | `index.html` (state + `tick()`) | `feedStale` / `feedBackoffUntil` / `feedAgeMs` |
| UI status-dot priority chain | `index.html` (`renderPanel`) | amber `.status-dot.warn` for backoff/stale |

For everything else — fleet config, smooth tracking, history overlay,
Planespotters photo module, mobile drawer, iOS quirks — see **HANDOFF.md**.
