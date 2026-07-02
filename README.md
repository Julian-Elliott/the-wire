# The Wire

Your own news desk. Six built-in desks — Liverpool FC, Worcester & UK, Gaming, EV & Battery, Markets and World — each written in its own voice, plus any desks you invent for yourself. British English, £, no ads, no comment columns. The research runs three times a day on a **Claude Code Routine** (billed to the Claude subscription, web search included), and everything is served instantly from cache — with a daily multi-host podcast to go with it.

```
the-wire/
├── src/worker.js                 # Cloudflare Worker: API routes, audio pipeline, cron
├── public/
│   ├── index.html                # The app — one file, no build step, no framework
│   ├── manifest.json             # PWA manifest (installable / Add to Home Screen)
│   └── icon.svg, icon-512.png, apple-touch-icon.png
├── routines/
│   ├── SETUP.md                  # Setting up the Claude Code Routine (+ refresh trigger)
│   └── briefing-prompt.md        # The routine's instructions: desk table, podcast format
├── docs/
│   ├── AUDIO_ARCHITECTURE.md     # Historical design doc — see the banner inside
│   ├── V2_PLAN.md                # 1 July review + plan, with a status header
│   └── prototypes/               # UI experiments
├── .github/workflows/deploy.yml  # Deploys to Cloudflare on push to main
├── wrangler.toml                 # Worker config: crons, KV, R2, routes, public vars
└── package.json
```

## How it works

Three moving parts:

1. **A Claude Code Routine** — a scheduled Claude Code session on Anthropic's cloud — reads `routines/briefing-prompt.md`, checks `/api/recent` for what's already been covered, researches every desk with its own web search, writes the stories *and* the day's podcast script, and `POST`s one JSON payload to **`/api/ingest`** with a shared secret. It runs three times a day on its own schedule (`0 6,12,18 * * *`).
2. **The Cloudflare Worker** validates the payload, drops anything the feed has already run (a rolling per-feed "seen" record catches reworded repeats of the same saga; a recency gate rejects genuinely stale stories), fetches a thumbnail for each story, merges it all into today's running feed in **Workers KV**, and pre-renders the podcast episode so it's cached before anyone presses play.
3. **The frontend** — one static HTML file, installable as a PWA — reads `/api/today`. No per-visit AI calls, so it's fast and effectively free to open.

And two kinds of reader:

- **Anonymous visitors** share one feed (the six built-in desks). Swiping and muting still work — they're learned locally in the browser (`localStorage`), and the client sends its anonymous id in an `x-user-id` header, never in the URL.
- **Signed in with Apple**, you get your own wire: pick desks from the catalogue, invent custom ones, message a desk, set writer styles and a freshness window — and the *same routine* researches your desks into your own feed, complete with a personalised podcast episode. Custom desks each get their own stable voice, so your episode still sounds multi-host.

The in-app **Refresh** button doesn't run a metered build. It *fires the routine* through its API trigger (throttled to one fire per 15 minutes per feed, plus a daily cap) and the routine posts fresh stories back when it finishes — usually a few minutes later. The client adds its own 5-minute button lock on top, which is why Refresh sometimes politely declines.

> **Legacy fallback:** with `FEED_SOURCE` unset, the Worker builds feeds itself on its cron via the metered Anthropic API (the original architecture, still in `src/worker.js` as `CATS` + `buildPrompt`). It's kept only as a fallback; production runs with `FEED_SOURCE = "routine"`.

## What's in the box

- **Fresh editions ~7am, 1pm and 7pm UK**, merged into a running daily feed (up to 3 items per desk per pull, capped at 9 per desk per day).
- **Salience ranking** — the researcher stamps each story 1–5 for how prominent it is across outlets; the feed blends that with freshness and what you've taught it.
- **Swipe learning** — right marks it read, left is "not for me"; keep swiping a content type left and it mutes itself. Plus **mark-all-read** when you're done.
- **The daily podcast** — a 2–4 minute multi-host episode: a dry narrator plus your desks bantering about the day, a distinct voice per desk. Play/restart transport, **download for offline**, branded intro/outro stings, and a podcast **RSS feed at `/feed.xml`** you can follow by URL in a podcast app.
- **Show styles** — The Briefing (default), The Wake-Up, The Green Room, Full Time — with a ~15-second taster for each, rendered through the real pipeline.
- **Per-item read-outs** — every story has a ▶ that reads a longer spoken version aloud, rendered on first play and cached.
- **Story images** — a Guardian API thumbnail or the article's own og:image, cached in R2 and served same-origin (never hotlinked).
- **One-desk-model settings** — every desk behaves the same: message it, set its writer style (brief / analyst / tabloid punch), reorder it, remove it.
- **Freshness window** — desk defaults, or clamp everything to the last 24h / 48h / week / month.
- **Wire FM** *(experimental)* — a radio-mode toggle, off by default, landing now; it builds on the MusicKit groundwork already in the Worker.

## API surface

| Endpoint | Purpose | Auth |
|---|---|---|
| `GET /api/today` | Today's feed — shared, or the caller's personalised feed | None (anon `x-user-id` header; Apple session cookie overrides it) |
| `POST /api/refresh` | Fire the routine to rebuild the caller's feed | None; throttled (15 min per feed + daily fire cap) |
| `GET /api/recent` | Recently-served headlines, per desk — the routine reads this before researching | `INGEST_SECRET` (`x-ingest-key` or Bearer) |
| `POST /api/ingest` | The routine posts the finished briefing (+ podcast script); optional `userId` targets a personalised feed | `INGEST_SECRET` |
| `GET /api/profile` | Read the caller's profile | Anon uid or Apple session (sessions can only read their own) |
| `PUT/POST /api/profile` | Save desks/notes/styles; `regenerate` fires a personalised rebuild | Apple session required |
| `GET /api/me` | Session status (signed in? name/email) | None |
| `GET /api/catalogue` | Onboarding desk catalogue with live "pitch" headlines | None (missing pitches fill in the background, locked + tombstoned) |
| `POST /api/desk-preview` | Design a custom desk with a live sample story (metered API call) | Apple session; 30s between, 20/day |
| `GET /api/podcast/today` | Today's episode MP3; `?meta=1` readiness probe, `?download=1` attachment | None |
| `GET /api/podcast/episode?d=YYYY-MM-DD` | A dated shared episode at a stable URL (Range-capable — the RSS feed points here) | None |
| `GET /feed.xml` | Podcast RSS over the shared daily episodes | None |
| `GET /api/listen/<itemId>` | Per-item read-out MP3, rendered on first play, cached | None (text comes from the feed, so no arbitrary-text spend) |
| `GET /api/beat?k=intro\|outro` | Branded audio stings (generated once, cached) | None |
| `GET /api/style-preview?s=<id>` | ~15s show-style taster (fixed set of 4, rendered once) | None |
| `GET /api/img/<id>` | Cached story thumbnail (content-addressed, immutable) | None |
| `GET /api/musickit-token` | MusicKit developer token for radio mode (KV-cached ~6h; tokens live 12h) | None (dormant until MusicKit vars + key are set) |
| `GET /auth/apple/login` · `POST /auth/apple/callback` · `GET /auth/apple/logout` | Sign in with Apple (dormant until configured) | None |
| `GET /.well-known/apple-developer-domain-association.txt` | Apple domain verification | None (serves `APPLE_DOMAIN_ASSOCIATION`) |
| anything else | Static assets (`public/`) | None |

## Secrets & configuration

Where each value lives — this matters, because **`wrangler deploy` replaces the Worker's plain vars with what's in `[vars]`**; anything set dashboard-only as a plain var is wiped on the next push to main. Encrypted secrets survive deploys.

**GitHub repository secrets** (Settings → Secrets and variables → Actions):

| Secret | What for |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Lets the deploy workflow run `wrangler deploy` ("Edit Cloudflare Workers" template) |
| `ANTHROPIC_API_KEY` | Re-pushed to the Worker as an encrypted secret **on every deploy** — used only for pitches, desk previews and the legacy fallback |

**Cloudflare Worker secrets** (`wrangler secret put …` — encrypted, survive deploys):

| Secret | What for |
|---|---|
| `INGEST_SECRET` | Authorises the routine's `/api/ingest` + `/api/recent` calls; both endpoints are dormant without it |
| `ROUTINE_FIRE_TOKEN` | Bearer token for the routine's API trigger (the Refresh path) |
| `ROUTINE_FIRE_URL` | The routine's `/fire` endpoint URL — set it as a secret (or uncommented in `[vars]`), never dashboard-only, or a deploy silently kills Refresh |
| `SESSION_SECRET` | Signs session cookies; Sign in with Apple stays dormant without it |
| `ELEVENLABS_API_KEY` | All audio: podcast dialogue, read-outs, beats, tasters |
| `GUARDIAN_API_KEY` | Guardian Content API thumbnails (free developer tier; og:image scraping still works without it) |
| `MUSICKIT_PRIVATE_KEY` | The MusicKit `.p8` private key; the Worker mints developer tokens server-side |
| `APPLE_DOMAIN_ASSOCIATION` | Contents of Apple's domain-verification file, served at `/.well-known/…` |

**Public vars** (committed in `wrangler.toml` `[vars]`, safe to be visible): `APPLE_CLIENT_ID`, `APPLE_REDIRECT_URI`, `MUSICKIT_KEY_ID`, `APPLE_TEAM_ID`, `FEED_SOURCE`.

**Optional tuning env** (all have sensible defaults in code):

| Var | Default | What it does |
|---|---|---|
| `ROUTINE_FIRE_MIN_SECONDS` | `900` | Minimum seconds between routine fires, per feed |
| `ROUTINE_FIRE_DAILY_MAX` | `15` | Daily ceiling on **on-demand** fires (the cron's scheduled fires bypass it) |
| `MAX_PERSONALISED_PER_CRON` | `8` | How many active users' personalised rebuilds each Worker cron run fires |
| `SEEN_DEDUP` | `on` | Set `off` to disable the cross-day seen-record dedup |
| `SEEN_WINDOW_DAYS` | `6` | How many days the seen record remembers per feed |
| `RECENCY_GATE` | `on` | Set `off` to stop dropping confidently-dated stale stories |
| `MODEL` | `claude-sonnet-4-6` | Model for the metered paths (pitches, previews, fallback) |

The **routine's own environment** needs just two variables: `INGEST_URL` and `INGEST_SECRET` (see `routines/SETUP.md`).

## Deploys

Push to `main` and GitHub Actions does the rest (`.github/workflows/deploy.yml`): it verifies the Cloudflare token, re-pushes `ANTHROPIC_API_KEY` as a Worker secret, and runs `wrangler deploy`. Manual `wrangler deploy` from your machine works too, but the Action is the normal path.

The Worker is still named `jacks-wire` — a legacy identifier kept so nothing needs re-provisioning; the product is just "The Wire". It serves on the custom domain `desk.databased.business` (configured as a route in `wrangler.toml`; Cloudflare provisions DNS + TLS on deploy).

## Storage

- **Workers KV** (`WIRE_KV`) — the shared feed, per-user feeds and profiles, per-feed seen records, daily snapshots (~5 days, they feed the RSS), pitches, render locks and throttle counters. Per-user feeds carry a TTL so accounts that go quiet expire.
- **R2** (`wire-audio`) — all generated media: `podcast/` episodes (keyed by script hash), `listen/` read-outs (content-addressed), `img/` story thumbnails, `beats/` stings and `previews/` style tasters. **Lifecycle rules (set in the Cloudflare dashboard) expire `img/`, `listen/` and `podcast/` after 14 days**; `beats/` and `previews/` are evergreen and deliberately exempt.

## The two schedules

Easy to conflate, so to be clear:

- **The routine's schedule** (`0 6,12,18 * * *`, set on the routine itself via `/schedule update`) owns the **shared feed**. That's what lands the three daily editions.
- **The Worker's cron** (`crons` in `wrangler.toml`, same three times) does *not* touch the shared feed in routine mode. It fires **personalised rebuilds** through the routine for recently-active signed-in users (up to `MAX_PERSONALISED_PER_CRON`, default 8, per run; users inactive for 48h drop off), and refreshes the onboarding pitches on the morning run.

Mind the routine's daily run cap (Pro 5 / Max 15 runs a day): 3 shared runs + up to 8×3 personalised cron fires + on-demand Refresh fires all draw from it. `MAX_PERSONALISED_PER_CRON` and `ROUTINE_FIRE_DAILY_MAX` are the levers — see `routines/SETUP.md`.

## Costs

The picture changed completely with the routine:

- **Research is on the Claude subscription.** Shared *and* personalised builds run in the routine, web search included — no per-search fees, no per-token metering. Refresh fires the routine too (throttled), so pressing it costs nothing extra on the meter.
- **The metered Anthropic API** is only touched for onboarding pitches (refreshed once each morning + on-demand fills), signed-in desk previews (throttled 30s apart, 20/day per user), and the legacy fallback if `FEED_SOURCE` is ever unset. Pennies.
- **ElevenLabs is the main variable cost.** Each *unique* podcast script renders once on v3 Text-to-Dialogue (the shared episode plus one per active personalised user, up to 3×/day each); per-item read-outs use cheap Flash and render **lazily** — only items someone actually plays are ever billed, then cached; beats and style tasters were one-off renders.
- **Cloudflare** — Workers, KV, R2 and the cron all sit comfortably in the free tier at this volume.

## Changing the desks / voices

- **The shared desks** (briefs, freshness windows, the podcast format) live in the desk table in `routines/briefing-prompt.md` — that's the file the routine actually reads. Edit and push; the next run picks it up.
- **Your own desks** are edited in the app (⚙ Settings) — no deploys involved.
- `CATS` at the top of `src/worker.js` still defines the desk personas for the frontend and the legacy fallback build; `ITEMS_PER_DESK` (3 per pull) and `DAILY_CAP_PER_DESK` (9/day) govern volumes.
- **Voices** are a hard-coded `VOICE_MAP` in `src/worker.js` (one per built-in desk + a narrator); custom desks get a stable pick from the pool.

## Local development

```bash
npm install
wrangler dev
```

`wrangler dev` runs the Worker with local KV/R2. Secrets go in a gitignored `.dev.vars` file (`ANTHROPIC_API_KEY=…`, `INGEST_SECRET=…`, etc.).

## Troubleshooting

- **Feed is blank / stuck on skeletons:** in routine mode this almost always means the routine hasn't run yet, or `/api/ingest` rejected it. Check the routine's last run at claude.ai/code/routines — a green status only means the session didn't crash; open the run and confirm the POST returned `{ ok: true, accepted: > 0 }`.
- **Ingest returns 404 "ingest not configured":** `INGEST_SECRET` isn't set on the Worker (`wrangler secret put INGEST_SECRET`).
- **Ingest returns 401:** the routine's `INGEST_SECRET` env var doesn't match the Worker's secret.
- **Routine POST fails with 403 `host_not_allowed`:** the routine's environment needs `desk.databased.business` added to its allowed network domains.
- **Refresh does nothing:** first suspect the throttles — a 5-minute client-side lock, a 15-minute per-feed fire throttle, and the daily fire cap; the button says so when it's locked. If it *never* works, `ROUTINE_FIRE_URL`/`ROUTINE_FIRE_TOKEN` are missing — or were set as plain dashboard vars and wiped by a deploy. Set both as encrypted secrets.
- **Podcast says "Generating today's episode…":** a cold render takes up to a minute; the player polls and recovers by itself. Persistent failures usually mean `ELEVENLABS_API_KEY` is missing or out of credit.
- **Desks error in legacy (non-routine) mode:** web search isn't enabled for your org in the Anthropic Console, or `ANTHROPIC_API_KEY` isn't set.
- **Watch live logs:** `wrangler tail`.
