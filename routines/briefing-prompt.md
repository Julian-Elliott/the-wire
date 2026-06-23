# The Wire — briefing routine

You generate a news briefing for The Wire and push it to the live site with your
own web search. This is unattended: be explicit, finish the whole job, and verify
the POST succeeded before you stop.

## 0. Which build is this?

This routine runs in one of two modes, decided by the **run input** (the `text`
passed when the run was triggered):

- **Shared build** — the run input is empty or just asks for a shared refresh.
  Build the **shared desks** in §1 and POST as in §3 with **no** `userId`. This
  is what scheduled runs and the shared-feed refresh do.
- **Personalised build** — the run input begins with `PERSONALISED BUILD REQUEST`.
  In that case **ignore the shared desk table in §1** and instead build ONLY the
  desks listed in that request, for the `userId` it names. All other rules (item
  shape, British English, §2/§3 mechanics) are identical, except you **MUST**
  include `"userId": "<that id>"` in the POSTed JSON body so it lands in that
  user's feed. Use each desk's `category` id exactly as given in the request.

## 1. Research each desk (shared build)

Use web search to gather genuinely newsworthy, high-signal updates for each desk
below. Up to **3 items per desk**. Lead with confirmed/official news over rumour
and clearly tag anything speculative.

Rules for every item:

- **British English throughout.** Use £ for money and UK conventions (dates,
  place names, spelling). Frame everything for a UK reader.
- Prioritise factual, high-signal updates a smart reader would want. Exclude
  opinion/comment columns, culture-war or outrage pieces, ragebait, clickbait,
  rumour-mill churn, and anything that's mostly someone whinging. No ads.
- `summary` ≤ 24 words. `why` = why this reader should care.
- Always include a real `source` (publication) and `url` (link to the story).

The desks (use the `category` id exactly as given):

| category    | desk             | brief                                                                                                                        | window |
| :---------- | :--------------- | :--------------------------------------------------------------------------------------------------------------------------- | :----- |
| `liverpool` | Liverpool FC     | Most important Liverpool FC men's first-team news. Also set the `fixture` field to the next match, e.g. `Liverpool vs Arsenal — Sat, 17:30`. | ~48h   |
| `worcester` | Worcester & UK   | Worcester/Worcestershire local news + UK-national stories with local-life impact (councils, roads & rail, community, cost of living). | ~1 week |
| `gaming`    | Gaming           | Biggest video-game stories — industry, releases, hardware. Lead with real news over filler. £ for UK pricing.               | ~1 week |
| `ev`        | EV & Battery     | EV, home-battery, solar, home-charging and energy-tariff news for a curious, non-techie UK buyer. Plain English, £ saved.    | ~2 weeks |
| `markets`   | Markets          | What is moving a globally diversified, £-based multi-asset ISA: global equities (S&P 500, FTSE 100, MSCI World), bond yields, BoE/Fed rate expectations, the pound. For each item set `direction` (`up`/`down`/`flat`) and `changePct` (e.g. `+0.4%` or null). | ~48h   |
| `world`     | World            | Top high-profile UK-national and world news an informed UK reader should know.                                              | ~48h   |

## 2. Assemble the payload

Produce a single JSON object. Every item carries its desk id in `category`.
Markets items add `direction`/`changePct`; other desks omit them (or null).
**For a personalised build, also set a top-level `"userId"`** to the id from the
request (e.g. `{ "userId": "abc123", "items": [ … ] }`).

```json
{
  "fixture": "Liverpool vs Arsenal — Sat, 17:30",
  "items": [
    { "category": "liverpool", "title": "...", "summary": "<=24 words", "why": "why a fan cares", "contentType": "News", "source": "BBC Sport", "url": "https://..." },
    { "category": "markets", "title": "FTSE 100", "direction": "down", "changePct": "-0.6%", "summary": "...", "why": "the real reason it moved", "contentType": "Index move", "source": "Reuters", "url": "https://..." }
  ]
}
```

`contentType` is a short tag for the kind of story (e.g. `News`, `Analysis`,
`Index move`, `Earnings`). Anything sensible is fine.

## 3. POST it to the site

Send the payload to the ingest endpoint. The URL and secret are provided as
environment variables on the routine (`INGEST_URL`, `INGEST_SECRET`):

```bash
curl -sS -X POST "$INGEST_URL" \
  -H "x-ingest-key: $INGEST_SECRET" \
  -H "Content-Type: application/json" \
  --data @payload.json
```

Write your assembled JSON to `payload.json` first, then run the curl so the body
is exactly the JSON (no shell-escaping surprises).

## 4. Verify, then stop

A success looks like:

```json
{ "ok": true, "date": "2026-06-23", "slot": "morning", "accepted": 14, "report": { "liverpool": { "n": 3, "status": "ok" }, ... } }
```

- If you get **HTTP 200** with `ok: true` and `accepted` > 0, you're done.
  State the `accepted` count and the per-desk `n` from the report.
- **401** → the `INGEST_SECRET` env var doesn't match the one set on the Worker.
- **403** with `host_not_allowed` → the routine's environment can't reach the
  site; the domain needs allowing in the environment's network access.
- **404 "ingest not configured"** → `INGEST_SECRET` isn't set on the Worker yet.

Report what happened. Do not commit anything to the repository — this routine
only reads its instructions from here and pushes via the API.
