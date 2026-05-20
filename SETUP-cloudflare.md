# Setting up the Cloudflare Worker proxy

This is a one-time setup that makes your tracker work bulletproof, forever. It's free.

## Why we're doing this

adsb.lol's servers don't accept requests directly from web browsers — they want requests from real servers. So we're going to set up a tiny "middleman" server on Cloudflare's free infrastructure. The middleman fetches data from adsb.lol on your tracker's behalf and passes it back. That's it.

Cloudflare runs the middleman for free (up to 100,000 requests/day; you'll use about 58,000). There's no server to maintain, no software to install on your computer. It's all done in a web browser.

Total time: **about 5 minutes.**

---

## Step 1 — Sign up for Cloudflare

Go to **https://dash.cloudflare.com/sign-up**

Use any email and password. No credit card needed. Click the verification link they email you.

---

## Step 2 — Create a Worker

After logging in:

1. In the **left sidebar**, click **Workers & Pages**
2. Click the **Create** button (top right)
3. Choose **Workers** → **Create Worker** (sometimes labeled "Hello World" — that's fine)
4. You'll see a screen with a randomly-generated name like `wandering-fog-1a2b`
5. **Optional but recommended:** rename it to something like `hems-adsb-proxy`
6. Click **Deploy** (this deploys the default placeholder code — we'll replace it next)

---

## Step 3 — Paste in the proxy code

After deploying, you'll see a "Success!" screen.

1. Click **Edit code** (or click into the worker, then click "Edit code" in the top right)
2. The editor will open on the left side of the screen with some default "Hello World" code
3. **Click anywhere in the editor**, press **Ctrl+A** (Windows) or **Cmd+A** (Mac) to select everything, then **Delete**
4. Open the **`cloudflare-worker.js`** file I sent you in a text editor (Notepad, TextEdit, VS Code — anything)
5. Select all of it (Ctrl+A / Cmd+A), copy (Ctrl+C / Cmd+C), and paste it into the Cloudflare editor
6. Click **Save and deploy** in the top right
7. When it asks to confirm, click **Save and deploy** again

---

## Step 4 — Test that it works

After deploying, you'll see a URL near the top of the page that looks something like:

```
https://hems-adsb-proxy.your-username.workers.dev
```

**Copy that URL.** This is your worker's address.

To test it works, paste this URL into your browser's address bar, **but add `/v2/reg/N732HM` to the end**, so it looks like:

```
https://hems-adsb-proxy.your-username.workers.dev/v2/reg/N732HM
```

Press Enter. You should see something like:

```json
{"ac":[...],"msg":"No error","now":...,"total":...}
```

If you see that — even if the `ac` array is empty because N732HM isn't flying — **the proxy is working.** 🎉

If you see an error page, double-check that you pasted the entire `cloudflare-worker.js` content and clicked **Save and deploy.**

---

## Step 5 — Plug the worker URL into your tracker

1. Open `index.html` in a text editor (right-click → Open with → Notepad / TextEdit)
2. Near the top of the file, find this line:

   ```js
   const WORKER_URL = "";
   ```

3. Paste your worker URL between the quotes. Make sure there is **no trailing slash**:

   ```js
   const WORKER_URL = "https://hems-adsb-proxy.your-username.workers.dev";
   ```

4. **Save the file.**
5. **Double-click `index.html`** to open it in your browser.

The status dot in the top right should turn **green** and say **LIVE** within a few seconds. Done.

---

## Optional: use your own domain (e.g., GoDaddy)

The `workers.dev` URL works fine forever. But if you'd rather have something like `traffic.your-domain.com`, here's how:

1. **Buy a domain** from any registrar (GoDaddy is fine; Cloudflare itself sells them at cost which is usually cheaper)
2. In the Cloudflare dashboard, click **Websites** → **Add a site** → enter your domain
3. Cloudflare will give you 2 nameservers (e.g., `xena.ns.cloudflare.com`). You need to put these into your GoDaddy DNS settings:
   - Log into GoDaddy → My Products → DNS → click your domain → Nameservers → Change → enter the two Cloudflare nameservers
   - This takes 5–60 minutes to take effect. Cloudflare will email you when it's done.
4. Back in Cloudflare: **Workers & Pages** → click your worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain** → enter `traffic.yourdomain.com`
5. Update `WORKER_URL` in your HTML to use the new domain

---

## Troubleshooting

**"The tracker says 'can't reach adsb.lol' even after setting WORKER_URL"**
- Check the WORKER_URL value: it should start with `https://`, not have a trailing slash
- Try opening `https://YOUR-WORKER-URL/v2/reg/N732HM` directly in your browser. If that doesn't show JSON, the worker isn't deployed correctly — redo Step 3.

**"I get HTTP 429 errors after a while"**
- This is a rate limit from either Cloudflare or adsb.lol. The default 3-second polling shouldn't trigger this for normal use. If it does, open `index.html` and find `refreshIntervalMs: 3000` — change `3000` to `5000` (5 seconds) or `10000` (10 seconds).

**"My worker URL gives 'Worker threw exception'"**
- Open the worker in the Cloudflare dashboard → click **Logs** → look at the most recent log to see what went wrong. Most likely cause: the code didn't paste in completely.

**"How do I update the tracker later?"**
- Just edit `index.html` and re-open it. The worker keeps running by itself — you don't have to touch it again.

**"What if I want to add more aircraft later?"**
- Open `index.html`, find the `FLEET` section near the top, and add another entry. Same pattern as before — no Cloudflare changes needed.
