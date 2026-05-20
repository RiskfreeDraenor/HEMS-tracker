// ============================================================================
//  Brick Traffic Watch — adsb.lol API proxy
//  Runs as a Cloudflare Worker. Free tier: 100,000 requests/day.
//
//  HOW TO DEPLOY:
//    1. Sign up at https://dash.cloudflare.com/sign-up  (free, no card)
//    2. Workers & Pages → Create → Workers → Create Worker → Deploy
//    3. Click "Edit code", DELETE the default code, paste THIS file in full
//    4. Click "Save and deploy"
//    5. Copy your worker URL (looks like  https://NAME.USERNAME.workers.dev )
//    6. Paste it into the WORKER_URL field at the top of brick-tracker.html
//
//  See SETUP-cloudflare.md for the full walkthrough with troubleshooting.
// ============================================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Preflight (browser asks "can I send this request?" before the real one)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health-check / instructions if someone opens the worker URL in a browser
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "Brick Traffic Watch adsb.lol proxy.\n" +
        "Append a path like /v2/reg/N732HM to query.\n",
        { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain" } }
      );
    }

    // Only allow /v2/* — don't be an open proxy for the whole internet
    if (!url.pathname.startsWith("/v2/")) {
      return new Response(
        JSON.stringify({ error: "Only /v2/* paths are proxied." }),
        { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const upstream = `https://api.adsb.lol${url.pathname}${url.search}`;

    try {
      const res = await fetch(upstream, {
        method: "GET",
        headers: {
          "Accept":     "application/json",
          "User-Agent": "brick-tracker-proxy/1.0",
        },
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Upstream fetch failed", detail: String(e) }),
        { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Cache-Control":                "no-store",
  };
}
