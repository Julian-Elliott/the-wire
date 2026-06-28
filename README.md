# The Wire

A personal daily news briefing across six desks — **Liverpool, Worcester & UK, Gaming, EV & Battery, Markets, World** — each written in its own voice. British English, £, no ads, no comment columns. Built by Claude with live web search, generated once each morning and cached so it loads instantly.

```
jacks-wire/
├── src/worker.js        # Cloudflare Worker: cron + KV cache + /api endpoints
├── public/index.html    # Static frontend (no build step, no framework)
├── wrangler.toml        # Worker config (cron, KV, assets)
├── package.json
└── README.md
```

## How it works

- A **cron trigger** runs the Worker every morning. It asks Claude (with web search) for each desk, assembles the briefing, and writes it to **Workers KV** as one shared copy.
- The frontend just reads `/api/today` — no per-visit API calls, no client-side timeouts. Fast and cheap.
- **Downvoting a content type** is stored in the visitor's browser (`localStorage`) and hides that type locally. The shared briefing isn't regenerated per person, so there's no extra cost.
- `POST /api/refresh` forces a fresh generation on demand (the in-app **Refresh** button).

---

## Deploy (about 4 commands)

You need a **Cloudflare account** (free tier is fine) and an **Anthropic API key**. I can't run these for you — `wrangler login` and your secret key have to live on your machine.

### 0. Prerequisites
- Install Node 18+ and the CLI: `npm install -g wrangler` (or prefix commands with `npx`).
- In the **Anthropic Console**, make sure **web search is enabled** for your organization (Settings → tool/privacy settings). Without this, the desks will return an error.

### 1. Log in to Cloudflare
```bash
wrangler login
```

### 2. Create the KV namespace, then paste its id into `wrangler.toml`
```bash
wrangler kv namespace create "WIRE_KV"
```
Copy the printed `id = "…"` into the `[[kv_namespaces]]` block in `wrangler.toml`
(replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`).
> Older wrangler (v2): the command is `wrangler kv:namespace create "WIRE_KV"`.

### 3. Add your Anthropic key as a secret
```bash
wrangler secret put ANTHROPIC_API_KEY
```
Paste the key when prompted. It's stored encrypted by Cloudflare — never in the code.

### 4. Deploy
```bash
wrangler deploy
```
You'll get a URL like `https://jacks-wire.<you>.workers.dev`. Open it.

### 5. Warm it up (optional)
The first visit generates the briefing if the cron hasn't run yet. To trigger it immediately:
```bash
curl -X POST https://jacks-wire.<you>.workers.dev/api/refresh
```

That's it. From then on it refreshes itself every morning.

---

## Send Jack the link
Just share the `workers.dev` URL. Want a nicer address? Add a custom domain in the
Cloudflare dashboard (Workers & Pages → your worker → Settings → Domains & Routes),
or in `wrangler.toml` via a `route`. On a phone he can "Add to Home Screen" for an app-like icon.

## Changing the morning time
`crons = ["0 6 * * *"]` in `wrangler.toml` is **06:00 UTC**. Standard cron, UTC only —
e.g. `"30 5 * * *"` for 05:30 UTC. Redeploy after editing.

## Tweaking the desks / voices
All six desks (labels, MBTI personas, voice instructions, content-type tags) and their
prompts live at the top of `src/worker.js` in `CATS` and `buildPrompt`. Edit there and
redeploy. To change how many stories per desk, adjust `ITEMS_PER_DESK`.

## Costs
Web search is **$10 per 1,000 searches** plus standard token costs. One generation hits
~12–18 searches, so a once-a-morning shared briefing is roughly **£0.10–£0.20 a day** plus
a few pennies of tokens — independent of how many times anyone opens it. The in-app
**Refresh** button costs one more generation each time it's pressed. Cloudflare Workers,
KV, and Cron all sit comfortably in the free tier at this volume.

## Local development
```bash
npm install
wrangler dev
```
`wrangler dev` runs the Worker locally with a local KV. You still need the secret set
(or a `.dev.vars` file with `ANTHROPIC_API_KEY=...`, which is gitignored).

## Troubleshooting
- **All desks error / empty:** web search isn't enabled in the Anthropic Console, or the
  secret isn't set. Check `wrangler tail` for the live error.
- **One desk says "timed out" / "couldn't parse":** transient — press Refresh; it retries
  once automatically and usually lands.
- **Feed is blank on first load:** the cron hasn't run yet and generation is in progress;
  give it a few seconds or hit `/api/refresh`.
- **Watch live logs:** `wrangler tail`.

---

### Alternative: fully free, no server
If you'd rather not run a Worker, the same idea works as a **GitHub Action on a cron** that
writes `briefing.json` into the repo each morning (API key stored as a GitHub Actions
secret), served by **GitHub Pages**. Slightly more moving parts for the build, genuinely
£0. Ask and I'll generate that variant.
