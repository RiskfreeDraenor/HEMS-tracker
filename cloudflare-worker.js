// ============================================================================
//  HEMS Tracker — Cloudflare Worker
//
//  Two responsibilities:
//   1) /v2/*  → proxy adsb.lol for the browser (same as the original worker).
//   2) TrackerDO Durable Object polls adsb.lol every 3s, runs a state
//      machine on each fleet aircraft, and writes flight records to D1.
//      Browser reads history through /log/* endpoints below.
//
//  REQUIRED BINDINGS (in Workers & Pages → hemstracker → Settings → Bindings):
//    DB         — D1 database (e.g., "hemstracker-logs")
//    TRACKER_DO — Durable Object, class "TrackerDO" (configured AFTER deploying
//                 this code once, since the class must exist before binding)
//
//  REQUIRED CRON TRIGGER (Workers & Pages → hemstracker → Settings → Triggers):
//    "* * * * *"  — every minute. Acts as a heartbeat that wakes the DO if its
//                   self-scheduled alarm ever stalls.
//
//  ENDPOINTS:
//    /v2/*                       adsb.lol passthrough
//    /log/state                  current state of every fleet aircraft
//    /log/flights?reg=…&limit=…  flight history (newest first)
//    /log/flight/<id>/track      full track points for one flight
//    /log/heartbeat              keepalive (called by cron)
// ============================================================================

/* ---- Fleet config — KEEP IN SYNC WITH index.html FLEET[].registration ---- */
const FLEET_REGS = ["N732HM", "N551HU"];

/* ---- Polling area: bbox covers all fleet bases in one adsb.lol request --- */
const BBOX_CENTER     = { lat: 40.6, lon: -74.3 };  // rough centroid of NJ HEMS bases
const BBOX_RADIUS_NM  = 150;                        // covers NJ + parts of NY/PA

/* ---- State machine knobs ------------------------------------------------- */
const POLL_INTERVAL_MS    = 3000;   // 3 second polling
const CONFIRMATIONS_NEEDED = 3;     // ~9s hysteresis before transitioning
const GROUND_ALT_FT        = 100;   // belt-and-suspenders: below this AND…
const GROUND_GS_KT         = 30;    // …below this ground speed = on ground

// ============================================================================
//  Worker entry point
// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // adsb.lol proxy (browser uses this for live display)
    if (url.pathname.startsWith("/v2/")) {
      try {
        const res = await fetch(`https://api.adsb.lol${url.pathname}${url.search}`, {
          method:  "GET",
          headers: { "Accept": "application/json", "User-Agent": "hems-tracker-proxy/1.0" },
        });
        const body = await res.text();
        return new Response(body, {
          status:  res.status,
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Upstream fetch failed", detail: String(e) }),
          { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
        );
      }
    }

    // Flight-log endpoints → singleton TrackerDO
    if (url.pathname.startsWith("/log/")) {
      const id   = env.TRACKER_DO.idFromName("singleton");
      const stub = env.TRACKER_DO.get(id);
      return stub.fetch(request);
    }

    // Health-check / docs
    return new Response(
      "HEMS Tracker proxy + logger.\n" +
      "Endpoints:\n" +
      "  /v2/*                      adsb.lol passthrough\n" +
      "  /log/state                 current state of fleet\n" +
      "  /log/flights?reg=…         flight history (newest first)\n" +
      "  /log/flight/<id>/track     full track points for one flight\n",
      { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain" } }
    );
  },

  // Cron heartbeat — wakes the DO if its 3s alarm ever stalls
  async scheduled(event, env) {
    const id   = env.TRACKER_DO.idFromName("singleton");
    const stub = env.TRACKER_DO.get(id);
    await stub.fetch(new Request("https://hemstracker/log/heartbeat"));
  },
};

// ============================================================================
//  TrackerDO — single Durable Object that owns the polling loop
// ============================================================================
export class TrackerDO {
  constructor(state, env) {
    this.state       = state;
    this.env         = env;
    this.initialized = false;
  }

  // Auto-create tables on first call (idempotent — IF NOT EXISTS)
  async ensureInitialized() {
    if (this.initialized) return;
    await this.env.DB.batch([
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS aircraft_state (
        reg               TEXT PRIMARY KEY,
        confirmed_state   TEXT,                  -- 'airborne' | 'ground' | 'offline'
        last_candidate    TEXT,
        candidate_count   INTEGER DEFAULT 0,
        last_seen         INTEGER,
        current_flight_id TEXT,
        last_lat          REAL,
        last_lon          REAL,
        last_alt          REAL,
        last_gs           REAL,
        last_track        REAL
      )`),
      this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS flights (
        id           TEXT PRIMARY KEY,
        reg          TEXT NOT NULL,
        takeoff_time  INTEGER NOT NULL,
        takeoff_lat   REAL,
        takeoff_lon   REAL,
        landing_time  INTEGER,
        landing_lat   REAL,
        landing_lon   REAL,
        duration_sec  INTEGER,
        distance_nm   REAL DEFAULT 0,
        avg_speed_kt  REAL,
        max_alt_ft    REAL DEFAULT 0,
        max_speed_kt  REAL DEFAULT 0,
        squawks       TEXT,
        point_count   INTEGER DEFAULT 0
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
    ]);
    this.initialized = true;
  }

  async ensureAlarm() {
    const current = await this.state.storage.getAlarm();
    if (current == null) {
      await this.state.storage.setAlarm(Date.now() + 100);  // fire almost immediately
    }
  }

  // ---- HTTP endpoints --------------------------------------------------------
  async fetch(request) {
    await this.ensureInitialized();
    await this.ensureAlarm();

    const url   = new URL(request.url);
    const jhdrs = { ...corsHeaders(), "Content-Type": "application/json" };

    if (url.pathname === "/log/state") {
      const rs = await this.env.DB.prepare(`SELECT * FROM aircraft_state`).all();
      return new Response(JSON.stringify({ aircraft: rs.results }), { headers: jhdrs });
    }

    if (url.pathname === "/log/flights") {
      const reg   = url.searchParams.get("reg");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500);
      const since = parseInt(url.searchParams.get("since") || "0");
      const stmt  = reg
        ? this.env.DB.prepare(
            `SELECT * FROM flights WHERE reg = ? AND takeoff_time >= ? ORDER BY takeoff_time DESC LIMIT ?`
          ).bind(reg.toUpperCase(), since, limit)
        : this.env.DB.prepare(
            `SELECT * FROM flights WHERE takeoff_time >= ? ORDER BY takeoff_time DESC LIMIT ?`
          ).bind(since, limit);
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

    if (url.pathname === "/log/heartbeat") {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: jhdrs });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jhdrs });
  }

  // ---- The polling loop ------------------------------------------------------
  async alarm() {
    await this.ensureInitialized();

    // Schedule next alarm FIRST so transient failures don't kill the loop
    try {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    } catch (e) {
      console.error("setAlarm failed:", e);
    }

    try {
      const res = await fetch(
        `https://api.adsb.lol/v2/lat/${BBOX_CENTER.lat}/lon/${BBOX_CENTER.lon}/dist/${BBOX_RADIUS_NM}`,
        { headers: { "User-Agent": "hems-tracker-do/1.0", "Accept": "application/json" } }
      );
      if (!res.ok) { console.warn(`adsb.lol ${res.status}`); return; }
      const data  = await res.json();
      const byReg = Object.create(null);
      for (const ac of (data.ac || [])) {
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
    const stateRow = await this.env.DB.prepare(
      `SELECT * FROM aircraft_state WHERE reg = ?`
    ).bind(reg).first();

    // 1) Determine this-tick candidate state (belt-and-suspenders)
    let candidate;
    if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon)) {
      candidate = "offline";
    } else {
      const altNum = typeof ac.alt_baro === "number" ? ac.alt_baro : null;
      const gs     = Number.isFinite(ac.gs) ? ac.gs : null;
      const onGround =
        ac.alt_baro === "ground"
        || (altNum != null && altNum < GROUND_ALT_FT && gs != null && gs < GROUND_GS_KT);
      candidate = onGround ? "ground" : "airborne";
    }

    // 2) Hysteresis: only transition after N consecutive consistent candidates
    let candidateCount = 1;
    if (stateRow && stateRow.last_candidate === candidate) {
      candidateCount = (stateRow.candidate_count || 0) + 1;
    }

    let confirmedState = stateRow ? stateRow.confirmed_state : null;
    let transition = null;
    if (candidateCount >= CONFIRMATIONS_NEEDED && candidate !== confirmedState) {
      transition = { from: confirmedState, to: candidate };
      confirmedState = candidate;
    }
    if (confirmedState == null) confirmedState = candidate;  // first sighting: accept immediately

    // 3) Live position (fall back to last-known if currently offline)
    const lat = ac && Number.isFinite(ac.lat) ? ac.lat : (stateRow ? stateRow.last_lat : null);
    const lon = ac && Number.isFinite(ac.lon) ? ac.lon : (stateRow ? stateRow.last_lon : null);
    const alt = ac && typeof ac.alt_baro === "number" ? ac.alt_baro : null;
    const gs  = ac && Number.isFinite(ac.gs)    ? ac.gs    : null;
    const trk = ac && Number.isFinite(ac.track) ? ac.track : null;

    let currentFlightId = stateRow ? stateRow.current_flight_id : null;

    // 4) Handle takeoff
    if (transition && transition.to === "airborne" && transition.from !== "airborne") {
      currentFlightId = `${reg}-${now}`;
      await this.env.DB.prepare(
        `INSERT INTO flights (id, reg, takeoff_time, takeoff_lat, takeoff_lon, max_alt_ft, max_speed_kt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(currentFlightId, reg, now, lat, lon, alt || 0, gs || 0).run();
    }

    // 5) Handle landing
    if (transition && transition.from === "airborne" && transition.to !== "airborne") {
      if (currentFlightId) {
        const flight = await this.env.DB.prepare(`SELECT * FROM flights WHERE id = ?`).bind(currentFlightId).first();
        if (flight) {
          const durSec = Math.round((now - flight.takeoff_time) / 1000);
          const dist   = flight.distance_nm || 0;
          const avgKt  = durSec > 0 ? (dist / (durSec / 3600)) : 0;
          await this.env.DB.prepare(
            `UPDATE flights SET landing_time = ?, landing_lat = ?, landing_lon = ?, duration_sec = ?, avg_speed_kt = ? WHERE id = ?`
          ).bind(now, lat, lon, durSec, avgKt, currentFlightId).run();
        }
        currentFlightId = null;
      }
    }

    // 6) While airborne in an active flight, append track point + roll stats
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
          newDist += haversineNm(stateRow.last_lat, stateRow.last_lon, lat, lon);
        }
        await this.env.DB.prepare(
          `UPDATE flights SET max_alt_ft = ?, max_speed_kt = ?, distance_nm = ?, point_count = point_count + 1 WHERE id = ?`
        ).bind(newMaxAlt, newMaxSpd, newDist, currentFlightId).run();
      }
    }

    // 7) Persist updated aircraft state
    await this.env.DB.prepare(`
      INSERT INTO aircraft_state
        (reg, confirmed_state, last_candidate, candidate_count, last_seen, current_flight_id,
         last_lat, last_lon, last_alt, last_gs, last_track)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reg) DO UPDATE SET
        confirmed_state   = excluded.confirmed_state,
        last_candidate    = excluded.last_candidate,
        candidate_count   = excluded.candidate_count,
        last_seen         = excluded.last_seen,
        current_flight_id = excluded.current_flight_id,
        last_lat          = excluded.last_lat,
        last_lon          = excluded.last_lon,
        last_alt          = excluded.last_alt,
        last_gs           = excluded.last_gs,
        last_track        = excluded.last_track
    `).bind(reg, confirmedState, candidate, candidateCount, now, currentFlightId, lat, lon, alt, gs, trk).run();
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
