# Generating the shared feed with a Claude Routine

The Wire's shared, anonymous briefing (the six built-in desks) can be generated
by a **Claude Code Routine** instead of the Worker calling the Anthropic API on
a cron. A routine runs as a full Claude Code session on Anthropic's cloud and is
**billed against your Claude subscription, not metered API credits** — and its
web search is included, so there are no per-search fees. That's the whole point:
it moves the always-on, 3×/day shared build off the API meter.

> **What this does *not* replace.** Routines run at most hourly, asynchronously,
> with a daily run cap (Pro 5 / Max 15). They can't serve a user waiting on the
> page. So onboarding pitches, desk previews, and per-user personalised builds
> still use the live Anthropic API. The routine only owns the shared feed —
> which is where essentially all of the recurring cron cost was.

Docs: <https://code.claude.com/docs/en/routines>

## How it fits together

```
Claude Routine (subscription)            Cloudflare Worker
─────────────────────────────            ─────────────────
 reads routines/briefing-prompt.md
 web-searches the 6 desks
 assembles one JSON payload
 POST /api/ingest  ───────────────────▶  validates + merges into today's
   x-ingest-key: <secret>                 running feed in KV (SHARED_KEY)
                                          served to every visitor at /api/today
```

The Worker endpoint is dormant until `INGEST_SECRET` is set, so nothing changes
until you finish the steps below.

## One-time setup

### 1. Set the shared secret on the Worker

Pick a long random secret (e.g. `openssl rand -hex 24`). Add it as an encrypted
Worker secret — **don't** put it in `wrangler.toml`:

```
wrangler secret put INGEST_SECRET
```

(or Cloudflare dashboard → Worker → Settings → Variables → add **INGEST_SECRET**,
encrypted).

### 2. Tell the Worker the routine now owns the shared feed

So the cron stops generating (and overwriting) the shared feed with a metered
API build, set a plain var in `wrangler.toml` under `[vars]`:

```toml
FEED_SOURCE = "routine"
```

Leave it unset to keep the old API cron behaviour (useful as a fallback). The
per-user personalised cron builds and onboarding pitch refresh are unaffected.

### 3. Create the routine

At <https://claude.ai/code/routines> → **New routine** (or the Desktop app →
Routines → New → **Remote**):

- **Prompt** — paste exactly:

  > Read `routines/briefing-prompt.md` from the cloned repository and follow it
  > exactly. Use the `INGEST_URL` and `INGEST_SECRET` environment variables.

- **Repository** — `Julian-Elliott/the-wire` (so it can read the prompt file).
- **Model** — your choice; a capable model gives better research.
- **Environment** — this is the step that's easy to miss:
  - **Network access → Custom**, and add `desk.databased.business` to **Allowed
    domains** (keep "include default list" ticked). Without this the POST fails
    with `403 host_not_allowed` — the default allowlist blocks your own domain.
  - **Environment variables** — add:
    - `INGEST_URL` = `https://desk.databased.business/api/ingest`
    - `INGEST_SECRET` = the same secret you set in step 1.
- **Connectors** — remove all of them; this routine doesn't need any.
- **Trigger** — **Schedule**. The web form's smallest preset is hourly; to run
  3×/day, create it then run `/schedule update` in the CLI and set the cron
  `0 6,12,18 * * *` (matches the old Worker cron; minimum interval is 1 hour).

### 4. Test it

On the routine's detail page click **Run now**, open the run, and confirm it
finishes with `ok: true` and `accepted` > 0. Then load
<https://desk.databased.business> — the shared feed should show the routine's
stories. Remember: a green run status only means the session didn't crash; open
the run to confirm the POST actually returned 200.

## Rotating the secret

Set a new value with `wrangler secret put INGEST_SECRET`, update the routine's
`INGEST_SECRET` env var to match, and run it again.
