# CLAUDE.md — HEMS Tracker architecture quick-reference

> Single-page live aircraft tracker for HEMS helicopters in NJ.
> Domain: **hemsnj.com**. Backend: Cloudflare Worker + Durable Object + D1.
> Full onboarding lives in **HANDOFF.md** — this file is the tight reference
> for the data-fetch path. Read both before making architectural changes.

---

## Live data fetch architecture (v.0059+)

The previous design had every browser tab polling `api.adsb.lol` independently
every 3 s through the worker as a passthrough. Fine at 1–2 visitors, but
upstream call rate scaled linearly with traffic and would have gotten the site
rate-limited as it grew. The current design centralizes upstream polling on
the Durable Object so the upstream call rate stays **flat at 1 per 3 s**
regardless of visitor count.

```
┌──────────┐   /live (3s)    ┌─────────────┐
│ browser1 │ ──────────────► │             │
│ browser2 │ ──────────────► │  TrackerDO  │       /v2/.../dist/150
│ browser3 │ ──────────────► │  (in-mem +  │ ────────────────────► api.adsb.lol
│   ...    │ ──────────────► │   Durable   │       once per 3s,
└──────────┘                 │   Storage)  │       regardless of N visitors
                             └─────────────┘
                                    ▲
                                    └── alarm() polls every 3s,
                                        writes snapshot to mem + storage
```

### Key points

- **The DO polls adsb.lol once every 3 s.** `alarm()` in
  `cloudflare-worker.js` calls `fetchAdsb(...)` for the 150 nm NJ bbox
  (`BBOX_CENTER 40.6/-74.3`, `BBOX_RADIUS_NM 150`). The parsed response is
  stored in `this.snapshot` (in-memory) **and** persisted via
  `this.state.storage.put("snapshot", ...)`. Single key, overwrite —
  never appends, so storage doesn't accumulate.

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

- **429 backoff is honored.** If adsb.lol returns 429, `alarm()` reads
  `Retry-After` (numeric seconds OR HTTP-date), sets `this.backoffUntil`
  (capped 5 min, default 30 s if header missing), and skips the upstream
  call until past the backoff window. `/live` keeps serving the last good
  snapshot with `stale: true` and `backoffUntil` populated. Successful
  poll clears the backoff.

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

- **Don't increase the DO poll cadence below 3 s.** adsb.lol is a community
  service running on goodwill — going to 1 s polling could get the project
  blocklisted.
- **Don't shrink `BBOX_RADIUS_NM` below 150.** It needs to cover all fleet
  bases + each visitor's traffic radius. The current value covers everything
  reasonable; smaller would push more visitors onto the gated fallback.
- **Don't remove the gated direct fallback.** Outside-NJ views legitimately
  need it.
- **Don't add a third party / paid feed as primary** without first checking
  the user's plan tier and projected call volume — see HANDOFF Section 7-D
  for the adsbexchange v.0055–v.0058 story.

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
