// ============================================================================
//  HEMS Tracker — Cloudflare Worker
//
//  Two responsibilities:
//   1) /v2/*  → proxy adsb.lol for the browser (same as the original worker).
//   2) TrackerDO Durable Object polls adsb.lol every 3s, runs a state
//      machine on each fleet aircraft, and writes flight records to D1.
//      Browser reads history through /log/* endpoints below.
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
//    /v2/*                       adsb.lol passthrough
//    /log/state                  current state of every fleet aircraft
//    /log/flights?reg=…&limit=…  flight history (newest first)
//    /log/flight/<id>/track      full track points for one flight
//    /log/airport?lat=&lon=      nearest airport within 0.5 nm (server-side helper)
//    /log/heartbeat              keepalive (called by cron)
// ============================================================================

/* ---- Fleet config — KEEP IN SYNC WITH index.html FLEET[].registration ---- */
const FLEET_REGS = ["N732HM", "N551HU", "N456MT"];

/* ---- Polling area: bbox covers all fleet bases in one adsb.lol request --- */
const BBOX_CENTER     = { lat: 40.6, lon: -74.3 };  // centroid of NJ HEMS bases
const BBOX_RADIUS_NM  = 150;

/* ---- State machine knobs ------------------------------------------------- */
const POLL_INTERVAL_MS     = 3000;
const CONFIRMATIONS_NEEDED = 3;     // ~9 s hysteresis before flipping state
const GROUND_ALT_FT        = 100;
const GROUND_GS_KT         = 30;

/* ---- Airport-lookup tolerance ------------------------------------------- */
const AIRPORT_MAX_NM   = 0.5;       // closer than this counts as "at" the airport
const AIRPORT_BBOX_DEG = 0.02;      // pre-filter bbox before haversine sort

// ============================================================================
//  Worker entry point
// ============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    // adsb.lol proxy
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
        return new Response(JSON.stringify({ error: "Upstream fetch failed", detail: String(e) }),
          { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
      }
    }

    if (url.pathname.startsWith("/log/")) {
      const id   = env.TRACKER_DO.idFromName("singleton");
      const stub = env.TRACKER_DO.get(id);
      return stub.fetch(request);
    }

    return new Response(
      "HEMS Tracker proxy + logger.\n" +
      "Endpoints:\n" +
      "  /v2/*                      adsb.lol passthrough\n" +
      "  /log/state                 current fleet state\n" +
      "  /log/flights?reg=…         flight history\n" +
      "  /log/flight/<id>/track     track points\n" +
      "  /log/airport?lat=&lon=     nearest airport (debug)\n",
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
    this.state       = state;
    this.env         = env;
    this.initialized = false;
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

    if (url.pathname === "/log/heartbeat") {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: jhdrs });
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
  async alarm() {
    await this.ensureInitialized();
    try { await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS); } catch (e) { console.error("setAlarm:", e); }

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
          newDist += haversineNm(stateRow.last_lat, stateRow.last_lon, lat, lon);
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
