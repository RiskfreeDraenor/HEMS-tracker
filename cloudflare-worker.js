// ============================================================================
//  HEMS Tracker — Cloudflare Worker
//
//  Two responsibilities:
//   1) /v2/*  → ADS-B passthrough (adsb.lol only, with timeout). Used only as
//      the GATED browser fallback when a visitor's view falls outside the
//      DO's NJ bbox. Default browser path is /live.
//   2) TrackerDO Durable Object polls multiple community ADS-B sources in
//      parallel every 3s (adsb.lol + airplanes.live; adsb.fi was tried but
//      blocks Cloudflare Worker egress IPs — see comment on SOURCES below),
//      merges them into one deduplicated aircraft list, stores the merged
//      snapshot for /live, runs the flight state machine off the merged
//      list, and writes flight records to D1. Browser reads history through
//      /log/* endpoints.
//
//  PRECISION (v.0021):
//   - Takeoff/landing time + position are recorded from the FIRST tick where
//     the new candidate state was observed, not from the tick where hysteresis
//     finally confirms it. Previously the recorded values were 6–9 s late.
//   - On flight close, the nearest airport/heliport within 0.5 nm is resolved
//     from the local D1 `airports` table and stored alongside the flight.
//
//  REQUIRED BINDINGS:
//    DB         — D1 database "hemstracker-logs"
//    TRACKER_DO — Durable Object, class "TrackerDO"
//  REQUIRED CRON TRIGGER:
//    "* * * * *"  — heartbeat every minute
//
//  ENDPOINTS:
//    /v2/*                       adsb.lol passthrough (gated browser fallback)
//    /live                       merged ADS-B snapshot (adsb.lol + airplanes.live)
//    /log/state                  current state of every fleet aircraft
//    /log/flights?reg=…&limit=…  flight history (newest first)
//    /log/flight/<id>/track      full track points for one flight
//    /log/airport?lat=&lon=      nearest airport within 0.5 nm (server-side helper)
//    /log/heartbeat              keepalive (called by cron)
// ============================================================================

/* ---- Fleet config — KEEP IN SYNC WITH index.html FLEET[].registration ---- */
const FLEET_REGS = ["N732HM", "N551HU", "N456MT", "N135TJ", "N137MH", "N3NJ", "N5NJ", "N9NJ"];

/* ---- Polling area: bbox covers all fleet bases in one adsb.lol request --- */
const BBOX_CENTER     = { lat: 40.6, lon: -74.3 };  // centroid of NJ HEMS bases
const BBOX_RADIUS_NM  = 150;

/* ---- State machine knobs ------------------------------------------------- */
const POLL_INTERVAL_MS     = 3000;
const CONFIRMATIONS_NEEDED = 3;     // ~9 s hysteresis before flipping state
const GROUND_ALT_FT        = 100;
const GROUND_GS_KT         = 30;

/* ---- Airport-lookup tolerance ------------------------------------------- */
// 2.5nm is loose enough that the "last airborne fix" before a heliport landing
// still identifies the right pad (ADS-B's last sample is often a few hundred
// meters from the actual touchdown). Multiple airports may now be in range —
// findNearestAirport() picks the closest, which is the right call.
const AIRPORT_MAX_NM   = 2.5;       // closer than this counts as "at" the airport
const AIRPORT_BBOX_DEG = 0.05;      // pre-filter bbox (~3nm) before haversine sort

// ============================================================================
//  ADS-B feeds (3-source merge in the DO; adsb.lol-only fallback for browser)
// ============================================================================
// The DO polls THREE community feeds in parallel each tick and merges their
// responses into one deduplicated aircraft list. Different feeders are
// connected to different aggregators, so each source catches some aircraft
// the others miss. All three are free, no keys, ~0.33 req/sec each at our
// cadence (well under any limit).
//
// IMPORTANT: airplanes.live uses a different path shape from the other two
// (/v2/point/{lat}/{lon}/{nm} instead of /v2/lat/.../lon/.../dist/{nm}).
// Each source carries its own pathFor() builder for that reason.
//
// The browser-side gated fallback (worker /v2/* passthrough → fetchAdsb)
// stays adsb.lol-only — it's only used when a visitor's view falls outside
// the DO's NJ bbox, which is rare and doesn't need multi-source coverage.
const ADSB_LOL_HOST   = "api.adsb.lol";
const ADSB_TIMEOUT_MS = 6000;

// adsb.fi was tried in v.0060 (https://opendata.adsb.fi/api/v3/lat/.../lon/.../dist/...)
// but their server blocks requests from Cloudflare Worker egress IPs — confirmed
// via a controlled UA test (200 OK from a home IP with the exact same UA we
// send from the worker; persistent 403 from inside the worker). It's IP/ASN-
// based filtering, not something we can fix here. Add the entry back when
// adsb.fi opens up CF egress or we route through a non-CF host.
const SOURCES = [
  {
    name:    "adsb.lol",
    host:    "https://api.adsb.lol",
    pathFor: ({ lat, lon, nm }) => `/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  },
  {
    name:    "airplanes.live",
    host:    "https://api.airplanes.live",
    pathFor: ({ lat, lon, nm }) => `/v2/point/${lat}/${lon}/${nm}`,
  },
];

// Parses Retry-After header (numeric seconds OR HTTP-date). Caps at 5 min,
// defaults to 30 s when no header is given. Returns ms.
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return 30000;
  const sec = parseInt(headerValue, 10);
  if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 300000);
  const t = Date.parse(headerValue);
  if (Number.isFinite(t)) return Math.max(1000, Math.min(t - Date.now(), 300000));
  return 30000;
}

// Polls one source. Never throws — always returns a tagged result so
// Promise.allSettled siblings remain unaffected. Mutates `sourceState[name]`
// on 429 to set the per-source backoff.
async function pollSource(source, sourceState) {
  const s = sourceState[source.name] || { backoffUntil: 0 };
  if (s.backoffUntil && Date.now() < s.backoffUntil) {
    return { name: source.name, status: "backoff", backoffUntil: s.backoffUntil };
  }
  const path = source.pathFor({
    lat: BBOX_CENTER.lat, lon: BBOX_CENTER.lon, nm: BBOX_RADIUS_NM,
  });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ADSB_TIMEOUT_MS);
    const res = await fetch(`${source.host}${path}`, {
      headers: {
        "Accept":     "application/json",
        // App-identifying UA — generic UA strings often trigger 403s on community APIs
        // that filter cloud/datacenter egress. Including the site URL gives the
        // operator a clear contact path if they ever want to reach us.
        "User-Agent": "hemsnj.com HEMS situational-awareness tracker (contact: https://hemsnj.com)",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 429) {
      const backoffMs = parseRetryAfterMs(res.headers.get("Retry-After"));
      sourceState[source.name] = { backoffUntil: Date.now() + backoffMs };
      console.warn(`${source.name} 429 — backing off ${backoffMs}ms`);
      return { name: source.name, status: "429", backoffMs };
    }
    if (!res.ok) {
      return { name: source.name, status: `http_${res.status}` };
    }
    const data = await res.json();
    // Successful poll clears any prior backoff for this source.
    if (s.backoffUntil) sourceState[source.name] = { backoffUntil: 0 };
    const ac = Array.isArray(data && data.ac) ? data.ac : [];
    return { name: source.name, status: "ok", ac, count: ac.length };
  } catch (e) {
    return { name: source.name, status: "error", error: (e && e.message) || String(e) };
  }
}

// Merge multiple per-source results into one deduplicated aircraft list.
// Rules (from the audit + user spec):
//   - normalize hex to lowercase BEFORE keying (browser uses ac.hex verbatim
//     as a Map key with no case normalization — different cases would
//     produce duplicate markers).
//   - within a duplicate-hex group, the record with the LOWEST `seen` value
//     (freshest) wins position. We do NOT average positions.
//   - missing fields on the freshest record (flight, squawk, t, category,
//     desc, ownOp, year, etc.) are backfilled from the other sources.
//   - aircraft present in only one source pass through as-is (this is the
//     whole point — catching what adsb.lol misses).
// Output shape is identical to a single-source data.ac array — downstream
// (snapshot, /live, processAircraft) is unaffected.
function mergeAircraft(okResults) {
  const merged = Object.create(null);
  for (const r of okResults) {
    for (const ac of (r.ac || [])) {
      const rawHex = ac && ac.hex;
      if (typeof rawHex !== "string") continue;
      const hex = rawHex.toLowerCase().trim();
      if (!hex) continue;
      const incoming = { ...ac, hex };           // shallow clone + normalized hex
      const existing = merged[hex];
      if (!existing) { merged[hex] = incoming; continue; }
      const existingSeen = Number.isFinite(existing.seen) ? existing.seen : Infinity;
      const incomingSeen = Number.isFinite(incoming.seen) ? incoming.seen : Infinity;
      if (incomingSeen < existingSeen) {
        // Incoming is fresher — replace, then backfill from the prior (older) record.
        for (const k of Object.keys(existing)) {
          if (incoming[k] == null && existing[k] != null) incoming[k] = existing[k];
        }
        merged[hex] = incoming;
      } else {
        // Existing is fresher — backfill any missing fields from the older incoming.
        for (const k of Object.keys(incoming)) {
          if (existing[k] == null && incoming[k] != null) existing[k] = incoming[k];
        }
      }
    }
  }
  return Object.values(merged);
}

// Browser /v2/* gated fallback — adsb.lol-only with 6s timeout. Used only for
// outside-NJ visitor views (Api.live falls through to Api.trafficNear in that
// rare case). Kept here so the multi-source DO logic and the browser fallback
// path stay decoupled.
async function fetchAdsb(_env, path) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ADSB_TIMEOUT_MS);
    const res = await fetch(`https://${ADSB_LOL_HOST}${path}`, {
      headers: {
        "Accept":     "application/json",
        "User-Agent": "hemsnj.com HEMS situational-awareness tracker (contact: https://hemsnj.com)",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    console.error(`adsb.lol fetch failed: ${e && e.message || e}`);
  }
  return new Response(JSON.stringify({ ac: [], error: "adsb.lol unavailable" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================================
//  Worker entry point
// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // adsb.lol proxy via the shared fetchAdsb() helper (6s timeout + safety 502).
    // Kept as the gated fallback for browsers whose view falls outside the DO
    // bbox. Default browser path is /live (DO snapshot) now — see below.
    if (url.pathname.startsWith("/v2/")) {
      const res  = await fetchAdsb(env, `${url.pathname}${url.search}`);
      const body = await res.text();
      return new Response(body, {
        status:  res.status,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    // Shared live snapshot — routes to the DO singleton. The DO serves its
    // last-known good poll without re-hitting adsb.lol, so N visitors poll
    // /live every 3s but adsb.lol still only gets ONE call per 3s (the DO's).
    if (url.pathname === "/live") {
      const id   = env.TRACKER_DO.idFromName("singleton");
      const stub = env.TRACKER_DO.get(id);
      return stub.fetch(request);
    }

    if (url.pathname.startsWith("/log/")) {
      const id   = env.TRACKER_DO.idFromName("singleton");
      const stub = env.TRACKER_DO.get(id);
      return stub.fetch(request);
    }

    return new Response(
      "HEMS Tracker proxy + logger.\n" +
      "Endpoints:\n" +
      "  /v2/*                      adsb.lol passthrough (gated browser fallback)\n" +
      "  /live                      merged ADS-B snapshot (adsb.lol + airplanes.live)\n" +
      "  /log/state                 current fleet state\n" +
      "  /log/flights?reg=…         flight history\n" +
      "  /log/flight/<id>/track     track points\n" +
      "  /log/airport?lat=&lon=     nearest airport (debug)\n" +
      "  /log/photo?hex=|reg=       Planespotters photo proxy\n",
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain" } }
    );
  },

  async scheduled(event, env) {
    const id   = env.TRACKER_DO.idFromName("singleton");
    const stub = env.TRACKER_DO.get(id);
    await stub.fetch(new Request("https://hemstracker/log/heartbeat"));
  },
};

// ============================================================================
//  TrackerDO
// ============================================================================
export class TrackerDO {
  constructor(state, env) {
    this.state        = state;
    this.env          = env;
    this.initialized  = false;
    // Shared live snapshot — populated by alarm(), served by the /live route.
    // Stored both in-memory (hot path) AND Durable Storage (cold-start
    // resilience). Without storage persistence, a worker re-deploy or DO
    // eviction would briefly dump every connected visitor onto the gated
    // direct adsb.lol fallback while we wait for the next alarm.
    this.snapshot     = null;   // { ts, bbox, ac: [...], sources: [{name,status,count,...}] }
    // Per-source backoff state. Each SOURCES entry gets its own { backoffUntil }.
    // One source 429'ing or going down doesn't disable the others — merge keeps
    // running with whoever responded. /live only surfaces backoffUntil if EVERY
    // source is currently in backoff (= "data delayed" from the UI's POV).
    this.sourceState  = {};
    this.state.blockConcurrencyWhile(async () => {
      this.snapshot    = (await this.state.storage.get("snapshot"))    || null;
      this.sourceState = (await this.state.storage.get("sourceState")) || {};
      // Ensure every configured source has an entry (handles new sources after
      // a deploy where storage was populated with an older SOURCES list).
      for (const s of SOURCES) {
        if (!this.sourceState[s.name]) this.sourceState[s.name] = { backoffUntil: 0 };
      }
    });
  }

  async ensureInitialized() {
    if (this.initialized) return;
    // Base tables (idempotent)
    await this.env.DB.batch([
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS aircraft_state (
        reg                  TEXT PRIMARY KEY,
        confirmed_state      TEXT,
        last_candidate       TEXT,
        candidate_count      INTEGER DEFAULT 0,
        candidate_first_time INTEGER,
        candidate_first_lat  REAL,
        candidate_first_lon  REAL,
        last_seen            INTEGER,
        current_flight_id    TEXT,
        last_lat             REAL,
        last_lon             REAL,
        last_alt             REAL,
        last_gs              REAL,
        last_track           REAL
      )`),
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS flights (
        id              TEXT PRIMARY KEY,
        reg             TEXT NOT NULL,
        takeoff_time    INTEGER NOT NULL,
        takeoff_lat     REAL,
        takeoff_lon     REAL,
        landing_time    INTEGER,
        landing_lat     REAL,
        landing_lon     REAL,
        duration_sec    INTEGER,
        distance_nm     REAL DEFAULT 0,
        avg_speed_kt    REAL,
        max_alt_ft      REAL DEFAULT 0,
        max_speed_kt    REAL DEFAULT 0,
        squawks         TEXT,
        point_count     INTEGER DEFAULT 0,
        airport_takeoff TEXT,
        airport_landing TEXT
      )`),
      this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_flights_reg_time ON flights(reg, takeoff_time DESC)`),
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS track_points (
        flight_id TEXT,
        t         INTEGER,
        lat       REAL,
        lon       REAL,
        alt       REAL,
        gs        REAL,
        track     REAL,
        PRIMARY KEY (flight_id, t)
      )`),
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS airports (
        ident    TEXT PRIMARY KEY,
        iata     TEXT,
        name     TEXT NOT NULL,
        type     TEXT,
        lat      REAL NOT NULL,
        lon      REAL NOT NULL,
        country  TEXT,
        municipality TEXT
      )`),
      this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_airports_loc ON airports(lat, lon)`),
    ]);

    // Migrations for columns added after the table existed (ignore "duplicate column" errors)
    const migrations = [
      `ALTER TABLE aircraft_state ADD COLUMN candidate_first_time INTEGER`,
      `ALTER TABLE aircraft_state ADD COLUMN candidate_first_lat  REAL`,
      `ALTER TABLE aircraft_state ADD COLUMN candidate_first_lon  REAL`,
      `ALTER TABLE flights        ADD COLUMN airport_takeoff      TEXT`,
      `ALTER TABLE flights        ADD COLUMN airport_landing      TEXT`,
    ];
    for (const sql of migrations) {
      try { await this.env.DB.prepare(sql).run(); } catch (e) { /* column exists, fine */ }
    }

    this.initialized = true;
  }

  async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    if (current == null) await this.state.storage.setAlarm(Date.now() + 100);
  }

  // ---- HTTP endpoints ----------------------------------------------------
  async fetch(request) {
    await this.ensureInitialized();
    await this.ensureAlarm();

    const url   = new URL(request.url);
    const jhdrs = { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store" };

    // Shared live snapshot — served from the DO's in-memory + Durable Storage
    // copy of the most recent successful upstream poll. Every browser hits
    // this instead of /v2/lat/.../, so adsb.lol sees ONE call per 3s
    // regardless of visitor count. envelope includes ageMs / stale /
    // backoffUntil so the UI can show a "data delayed" state during a 429.
    if (url.pathname === "/live") {
      // backoffUntil is surfaced to the browser ONLY when EVERY source is
      // currently in backoff (= upstream truly delayed). If even one source
      // responded this cycle, the snapshot is fresh and the UI should stay
      // green — that's the point of multi-source.
      const nowMs = Date.now();
      const states = Object.values(this.sourceState || {});
      const allBackedOff = states.length > 0 && states.every(s => s.backoffUntil > nowMs);
      const minBackoffUntil = allBackedOff
        ? Math.min(...states.map(s => s.backoffUntil))
        : null;
      if (!this.snapshot) {
        return new Response(JSON.stringify({
          ac: [], stale: true, noData: true,
          sources: [], backoffUntil: minBackoffUntil,
        }), { status: 503, headers: jhdrs });
      }
      const ageMs = nowMs - this.snapshot.ts;
      return new Response(JSON.stringify({
        ts:           this.snapshot.ts,
        ageMs,
        stale:        ageMs > 15000,             // ~5 missed ticks
        bbox:         this.snapshot.bbox,        // matches BBOX_CENTER + BBOX_RADIUS_NM
        ac:           this.snapshot.ac,
        sources:      this.snapshot.sources || [],   // per-source health for verification + UI
        backoffUntil: minBackoffUntil,
      }), { headers: jhdrs });
    }

    if (url.pathname === "/log/state") {
      const rs = await this.env.DB.prepare(`SELECT * FROM aircraft_state`).all();
      return new Response(JSON.stringify({ aircraft: rs.results }), { headers: jhdrs });
    }

    if (url.pathname === "/log/flights") {
      const reg   = url.searchParams.get("reg");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
      const since = parseInt(url.searchParams.get("since") || "0");
      const stmt  = reg
        ? this.env.DB.prepare(`SELECT * FROM flights WHERE reg = ? AND takeoff_time >= ? ORDER BY takeoff_time DESC LIMIT ?`).bind(reg.toUpperCase(), since, limit)
        : this.env.DB.prepare(`SELECT * FROM flights WHERE takeoff_time >= ? ORDER BY takeoff_time DESC LIMIT ?`).bind(since, limit);
      const rs = await stmt.all();
      return new Response(JSON.stringify({ flights: rs.results }), { headers: jhdrs });
    }

    if (url.pathname.startsWith("/log/flight/") && url.pathname.endsWith("/track")) {
      const id = url.pathname.slice("/log/flight/".length, -"/track".length);
      const rs = await this.env.DB.prepare(
        `SELECT t, lat, lon, alt, gs, track FROM track_points WHERE flight_id = ? ORDER BY t ASC`
      ).bind(id).all();
      return new Response(JSON.stringify({ points: rs.results }), { headers: jhdrs });
    }

    if (url.pathname === "/log/airport") {
      const lat = parseFloat(url.searchParams.get("lat"));
      const lon = parseFloat(url.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return new Response(JSON.stringify({ error: "lat and lon required" }), { status: 400, headers: jhdrs });
      }
      const ap = await this.findNearestAirport(lat, lon);
      return new Response(JSON.stringify({ airport: ap }), { headers: jhdrs });
    }

    if (url.pathname === "/log/airports/bbox") {
      const n = parseFloat(url.searchParams.get("n"));
      const s = parseFloat(url.searchParams.get("s"));
      const e = parseFloat(url.searchParams.get("e"));
      const w = parseFloat(url.searchParams.get("w"));
      if (![n,s,e,w].every(Number.isFinite)) {
        return new Response(JSON.stringify({ error: "need n,s,e,w query params" }), { status: 400, headers: jhdrs });
      }
      const rs = await this.env.DB.prepare(
        `SELECT ident, name, type, lat, lon FROM airports
         WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
         LIMIT 2000`
      ).bind(s, n, w, e).all();
      return new Response(JSON.stringify({ airports: rs.results || [] }), { headers: jhdrs });
    }

    if (url.pathname === "/log/heartbeat") {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: jhdrs });
    }

    // ---- Aircraft-photo proxy (Planespotters Pub API) -----------------------
    // Self-contained, additive endpoint. Accepts ?hex=<icao24> or ?reg=<tail>.
    // Calls https://api.planespotters.net/pub/photos/(hex|reg)/<value> and forwards
    // the JSON back. Cloudflare caches the upstream response for 24h via cf.cacheTtl,
    // so we hit Planespotters at most once per aircraft per day. Failures (no photo,
    // upstream down, malformed input) return {photos: []} so the browser falls back
    // gracefully — nothing else in the app depends on this working.
    if (url.pathname === "/log/photo") {
      const hex = (url.searchParams.get("hex") || "").trim();
      const reg = (url.searchParams.get("reg") || "").trim();
      if (!hex && !reg) {
        return new Response(JSON.stringify({ error: "need ?hex=<icao24> or ?reg=<tail>" }), { status: 400, headers: jhdrs });
      }
      const upstream = hex
        ? `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex.toUpperCase())}`
        : `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg.toUpperCase())}`;
      try {
        const r = await fetch(upstream, {
          headers: { "Accept": "application/json", "User-Agent": "HEMSTracker/1.0 (+https://hemsnj.com)" },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!r.ok) return new Response(JSON.stringify({ photos: [] }), { headers: { ...jhdrs, "Cache-Control": "public, max-age=3600" } });
        const data = await r.json().catch(() => ({ photos: [] }));
        return new Response(JSON.stringify(data), { headers: { ...jhdrs, "Cache-Control": "public, max-age=86400" } });
      } catch (e) {
        return new Response(JSON.stringify({ photos: [], error: String(e && e.message || e) }), { headers: jhdrs });
      }
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jhdrs });
  }

  // ---- Nearest-airport lookup --------------------------------------------
  async findNearestAirport(lat, lon) {
    const rs = await this.env.DB.prepare(`
      SELECT ident, name, lat, lon FROM airports
      WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
    `).bind(lat - AIRPORT_BBOX_DEG, lat + AIRPORT_BBOX_DEG, lon - AIRPORT_BBOX_DEG, lon + AIRPORT_BBOX_DEG).all();

    let best = null, bestDist = Infinity;
    for (const row of (rs.results || [])) {
      const d = haversineNm(row.lat, row.lon, lat, lon);
      if (d < bestDist && d <= AIRPORT_MAX_NM) { best = row; bestDist = d; }
    }
    return best ? { ident: best.ident, name: best.name, distance_nm: +bestDist.toFixed(2) } : null;
  }

  // ---- Polling loop ------------------------------------------------------
  // Every 3s: poll all 3 sources in parallel, merge the results into ONE
  // deduplicated aircraft list, store it, then run the flight logger from
  // that single merged list. One slow source does not block the others;
  // one failed source does not blank the snapshot.
  async alarm() {
    await this.ensureInitialized();
    try { await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS); } catch (e) { console.error("setAlarm:", e); }

    // Skip the entire alarm only if EVERY source is in backoff. With multiple
    // sources this should be extremely rare — if any one source is healthy
    // the merge still has data and the downstream flow runs normally.
    const nowMs = Date.now();
    const states = Object.values(this.sourceState || {});
    if (states.length > 0 && states.every(s => s.backoffUntil > nowMs)) {
      return;
    }

    try {
      // Parallel fetch of all sources. Promise.allSettled so one failure
      // doesn't tank the others. pollSource() never throws — it returns a
      // tagged result either way.
      const settled = await Promise.allSettled(
        SOURCES.map(src => pollSource(src, this.sourceState))
      );
      const perSource = settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : { name: SOURCES[i].name, status: "rejected", error: String(s.reason) }
      );
      const okResults = perSource.filter(r => r.status === "ok");
      const mergedAc  = mergeAircraft(okResults);

      // Persist per-source backoff state (pollSource mutated it on 429s).
      await this.state.storage.put("sourceState", this.sourceState);

      // Store snapshot + per-source health for /live consumers + verification.
      this.snapshot = {
        ts:      Date.now(),
        bbox:    { lat: BBOX_CENTER.lat, lon: BBOX_CENTER.lon, radius: BBOX_RADIUS_NM },
        ac:      mergedAc,
        sources: perSource.map(r => ({
          name:      r.name,
          status:    r.status,
          count:     r.count     != null ? r.count     : 0,
          backoffMs: r.backoffMs || null,
          error:     r.error     || null,
        })),
      };
      await this.state.storage.put("snapshot", this.snapshot);

      // Flight logger — ONE call per fleet aircraft per tick, from the SINGLE
      // merged list. Calling processAircraft once per source would break the
      // hysteresis state machine (audit §8-E). Building byReg from mergedAc
      // means each fleet aircraft is seen exactly once per tick, with all
      // its fields backfilled from whichever source had them.
      const byReg = Object.create(null);
      for (const ac of mergedAc) {
        if (ac.r) byReg[ac.r.toUpperCase()] = ac;
      }
      const now = Date.now();
      for (const reg of FLEET_REGS) {
        await this.processAircraft(reg, byReg[reg.toUpperCase()], now);
      }
    } catch (e) {
      console.error("alarm cycle failed:", e);
    }
  }

  async processAircraft(reg, ac, now) {
    const stateRow = await this.env.DB.prepare(`SELECT * FROM aircraft_state WHERE reg = ?`).bind(reg).first();

    // 1) Determine this-tick candidate state
    let candidate;
    if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) {
      candidate = "offline";
    } else {
      const altNum = typeof ac.alt_baro === "number" ? ac.alt_baro : null;
      const gs     = Number.isFinite(ac.gs) ? ac.gs : null;
      const onGround = ac.alt_baro === "ground"
        || (altNum != null && altNum < GROUND_ALT_FT && gs != null && gs < GROUND_GS_KT);
      candidate = onGround ? "ground" : "airborne";
    }

    // 2) Live position (fall back to last known)
    const lat = ac && Number.isFinite(ac.lat) ? ac.lat : (stateRow ? stateRow.last_lat : null);
    const lon = ac && Number.isFinite(ac.lon) ? ac.lon : (stateRow ? stateRow.last_lon : null);
    const alt = ac && typeof ac.alt_baro === "number" ? ac.alt_baro : null;
    const gs  = ac && Number.isFinite(ac.gs)    ? ac.gs    : null;
    const trk = ac && Number.isFinite(ac.track) ? ac.track : null;

    // 3) Track when this candidate state was FIRST observed (for precision).
    //    On confirmation we'll record THAT time/position as takeoff/landing,
    //    not "now" (which would be 6–9 s late).
    let candidateCount     = 1;
    let candidateFirstTime = now;
    let candidateFirstLat  = lat;
    let candidateFirstLon  = lon;
    if (stateRow && stateRow.last_candidate === candidate) {
      candidateCount     = (stateRow.candidate_count || 0) + 1;
      candidateFirstTime = stateRow.candidate_first_time != null ? stateRow.candidate_first_time : now;
      candidateFirstLat  = stateRow.candidate_first_lat  != null ? stateRow.candidate_first_lat  : lat;
      candidateFirstLon  = stateRow.candidate_first_lon  != null ? stateRow.candidate_first_lon  : lon;
    }

    // 4) Transition decision
    let confirmedState = stateRow ? stateRow.confirmed_state : null;
    let transition = null;
    if (candidateCount >= CONFIRMATIONS_NEEDED && candidate !== confirmedState) {
      transition = { from: confirmedState, to: candidate };
      confirmedState = candidate;
    }
    if (confirmedState == null) confirmedState = candidate;

    let currentFlightId = stateRow ? stateRow.current_flight_id : null;

    // 5) Takeoff — use FIRST-observation values, not current
    if (transition && transition.to === "airborne" && transition.from !== "airborne") {
      currentFlightId = `${reg}-${candidateFirstTime}`;
      const airport = await this.findNearestAirport(candidateFirstLat, candidateFirstLon);
      await this.env.DB.prepare(
        `INSERT INTO flights (id, reg, takeoff_time, takeoff_lat, takeoff_lon, max_alt_ft, max_speed_kt, airport_takeoff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        currentFlightId, reg, candidateFirstTime, candidateFirstLat, candidateFirstLon,
        alt || 0, gs || 0, airport?.name || null
      ).run();
    }

    // 6) Landing — same: FIRST-observation values
    if (transition && transition.from === "airborne" && transition.to !== "airborne") {
      if (currentFlightId) {
        const flight = await this.env.DB.prepare(`SELECT * FROM flights WHERE id = ?`).bind(currentFlightId).first();
        if (flight) {
          const durSec  = Math.max(0, Math.round((candidateFirstTime - flight.takeoff_time) / 1000));
          const dist    = flight.distance_nm || 0;
          const avgKt   = durSec > 0 ? (dist / (durSec / 3600)) : 0;
          const airport = await this.findNearestAirport(candidateFirstLat, candidateFirstLon);
          await this.env.DB.prepare(
            `UPDATE flights SET landing_time = ?, landing_lat = ?, landing_lon = ?, duration_sec = ?, avg_speed_kt = ?, airport_landing = ?
             WHERE id = ?`
          ).bind(candidateFirstTime, candidateFirstLat, candidateFirstLon, durSec, avgKt, airport?.name || null, currentFlightId).run();
        }
        currentFlightId = null;
      }
    }

    // 7) While airborne — append track point + roll stats
    if (confirmedState === "airborne" && currentFlightId && ac && lat != null && lon != null) {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO track_points (flight_id, t, lat, lon, alt, gs, track) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(currentFlightId, now, lat, lon, alt, gs, trk).run();

      const f = await this.env.DB.prepare(
        `SELECT max_alt_ft, max_speed_kt, distance_nm FROM flights WHERE id = ?`
      ).bind(currentFlightId).first();
      if (f) {
        const newMaxAlt = Math.max(f.max_alt_ft   || 0, alt || 0);
        const newMaxSpd = Math.max(f.max_speed_kt || 0, gs  || 0);
        let newDist     = f.distance_nm || 0;
        if (stateRow && stateRow.last_lat != null && stateRow.last_lon != null) {
          // Server-side outlier filter — mirrors the browser's
          // ingestFleetSample() logic so source-jitter from multiple ADS-B
          // feeds can't silently inflate distance_nm. Cap: max(prev gs,
          // new gs, 200kt) × 1.6, scaled by elapsed time, with 0.25nm
          // minimum slack to absorb noise on slow / hovering aircraft.
          // We only gate the DISTANCE accumulation — the position itself is
          // still accepted into aircraft_state so the hysteresis state
          // machine doesn't lose its sample.
          const dtSec = Math.max(0, (now - (stateRow.last_seen || now)) / 1000);
          if (dtSec > 0) {
            const obsNm = haversineNm(stateRow.last_lat, stateRow.last_lon, lat, lon);
            const capKt = Math.max(stateRow.last_gs || 0, gs || 0, 200) * 1.6;
            const maxNm = Math.max((capKt * dtSec) / 3600, 0.25);
            if (obsNm <= maxNm) {
              newDist += obsNm;
            } else {
              console.warn(`[outlier-skip-dist] ${reg}: ${obsNm.toFixed(2)}nm in ${dtSec.toFixed(1)}s`);
            }
          }
        }
        await this.env.DB.prepare(
          `UPDATE flights SET max_alt_ft = ?, max_speed_kt = ?, distance_nm = ?, point_count = point_count + 1 WHERE id = ?`
        ).bind(newMaxAlt, newMaxSpd, newDist, currentFlightId).run();
      }
    }

    // 8) Persist updated aircraft state
    await this.env.DB.prepare(`
      INSERT INTO aircraft_state
        (reg, confirmed_state, last_candidate, candidate_count, candidate_first_time, candidate_first_lat, candidate_first_lon,
         last_seen, current_flight_id, last_lat, last_lon, last_alt, last_gs, last_track)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reg) DO UPDATE SET
        confirmed_state      = excluded.confirmed_state,
        last_candidate       = excluded.last_candidate,
        candidate_count      = excluded.candidate_count,
        candidate_first_time = excluded.candidate_first_time,
        candidate_first_lat  = excluded.candidate_first_lat,
        candidate_first_lon  = excluded.candidate_first_lon,
        last_seen            = excluded.last_seen,
        current_flight_id    = excluded.current_flight_id,
        last_lat             = excluded.last_lat,
        last_lon             = excluded.last_lon,
        last_alt             = excluded.last_alt,
        last_gs              = excluded.last_gs,
        last_track           = excluded.last_track
    `).bind(
      reg, confirmedState, candidate, candidateCount, candidateFirstTime, candidateFirstLat, candidateFirstLon,
      now, currentFlightId, lat, lon, alt, gs, trk
    ).run();
  }
}

// ============================================================================
//  Helpers
// ============================================================================
function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const r = d => d * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 0.539957;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control":                "no-store",
  };
}
