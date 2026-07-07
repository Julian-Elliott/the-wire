# Platform Leverage — The Wire v3

*Decision note for Julian. Sources: four platform audits (compute, data+AI, extras, GitHub, reliability) adversarially verified against live docs on 5 July 2026: 16 claims CONFIRMED, 1 PLAUSIBLE, 1 REFUTED. Where the verifier refuted or softened a figure, the corrected version appears here and is flagged. Phases refer to V3_BLUEPRINT.md §12: Phase 1 (server foundation, weeks 1–4), Phase 2 (butler, weeks 5–8), Phase 3 (ambient and audio, weeks 9–12).*

---

## 1. Verdict and the bill

The whole of v3's infrastructure — two Durable Object classes, D1, KV, R2, Workers AI embeddings, five cron cadences, email digests, push alerting, nightly backups, an external watchdog — fits inside the $5/month Workers Paid plan you already pay for, with every quota under 20% utilised and most under 2%. The marginal cost of v3 over v2 is zero. Every reliability primitive in section 4 is free-tier. The only refinement the verification pass forced is operational, not financial: Cloudflare Notifications webhooks do **not** work on your plan (refuted — they require a Pro zone), so alerting to your phone routes through ntfy/GitHub/email instead, exactly as designed below.

**Expected monthly infra bill (v3, verified prices):**

| Line item | Quota used / included | Cost |
|---|---|---|
| Workers Paid base (requests, CPU, static assets) | ~160k of 10M req; CPU negligible | **$5.00** |
| Durable Objects (21 instances, SQLite) | ~150k of 1M req; ~41k of 400k GB-s; ~50k of 50M rows written | $0 (included) |
| D1 (ledgers, registry, embeddings blobs) | thousands of reads/day vs 25B rows/mo | $0 (included) |
| KV (snapshots, flags) | <1% of 10M reads / 1M writes | $0 (included) |
| R2 (`wire-audio` + new `wire-backups`) | hundreds of MB of 10 GB-mo free; zero egress | $0 (free tier) |
| Workers AI (bge-m3 embeddings) | ~4.3 neurons/day of 10,000 free/day | $0 |
| Email Sending (digests + alerts) | ~1,800 of 3,000/mo; sends to own verified address unmetered | $0 (included) |
| Workers Logs, Analytics Engine, AI Gateway, Access | all inside included/free quotas | $0 |
| GitHub Actions, CodeQL, Dependabot, secret scanning | public repo, standard runners | £0 |
| healthchecks.io Hobbyist, ntfy.sh | free tiers | £0 |
| **Total** | | **$5/mo ≈ £4** |

**The do-nothing comparison** — what the same capabilities cost if bought naïvely instead of squeezed from included quotas:

| Capability | Naïve purchase | Cost avoided |
|---|---|---|
| Uptime probing | Cloudflare Health Checks (needs Pro zone, $20–25/mo) | ~£16–20/mo |
| Transactional email | Postmark/SendGrid starter | ~£10–12/mo |
| Hosted Postgres for ledgers | smallest managed instance | ~£15/mo |
| Log/metrics SaaS | entry-tier observability | ~£15/mo |
| Push alerting | PagerDuty free is fine, but paid tiers start | £0–20/mo |
| Object storage egress | S3-style egress on a few GB of audio plays | ~£1–5/mo |

Call it **£55–70/month avoided** by using what the $5 plan and public-repo free tiers already include. Infra lands well inside the £5–10 target; the app budget (£30–95) remains an ElevenLabs conversation, not an infra one.

---

## 2. Cloudflare: what we use, what we skip

| Product | Verdict | One-line reason |
|---|---|---|
| Workers Paid ($5) | **USE** | Everything fits with ~50× headroom |
| Durable Objects (SQLite) | **USE** | 21 DOs cost $0 marginal; the architecture's spine |
| Cron triggers (5 expressions, 1 Worker) | **USE** | 250/account limit; no multiplexing hack needed |
| Workers Logs | **USE** | Free 20M events/mo, 7-day retention, zero code |
| Versions / gradual deploy / rollback | **USE** | The 2 a.m. lever — with DO sharp edges, below |
| KV | **USE** | Already deployed; 1 write/s/key limit is 1000× clear |
| D1 (+ Time Travel + export) | **USE** | Consent ledger alone justifies PITR |
| R2 (+ `wire-backups` bucket) | **USE** | Free tier, zero egress; no versioning exists — don't design for it |
| Workers AI (bge-m3) | **USE** | ~4.3 neurons/day of 10,000 free daily — permanently $0 |
| AI Gateway (spend limits) | **USE (thin)** | Non-batch calls only; Batch API undocumented → direct |
| Analytics Engine | **USE** | The spend-visibility primitive; billing not even enabled |
| Email Sending | **USE** | Digests + free unmetered alerts to your own address |
| Email Routing (inbound) | **USE-LATER** | Enable `alerts@` forward day one; parsing surface later |
| Access (Zero Trust) | **USE** | 50 free seats; admin/dev paths behind OTP |
| WAF rate-limiting (1 free rule) | **USE** | Caps accidental retry-loops on `/api/*` |
| Notifications (budget alert, email) | **USE** | ~$8 tripwire; **email only — webhooks refuted on this plan** |
| Workers Assets (vs Pages) | **USE (keep)** | One deployable, one rollback; Workers-first features |
| Zone toggles (HTTPS, HSTS) | **USE** | Two switches; skip HSTS preload |
| Logpush | USE-LATER | Only if 7-day retention hurts a post-mortem |
| Vectorize | USE-LATER | Brute-force cosine over ~40/day is microseconds |
| Tail Workers | SKIP | A second Worker to babysit; Logs suffices at N=20 |
| Smart Placement | SKIP | Ignores DOs and assets; 20 UK users won't activate it |
| Queues | SKIP | Alarm chain + status rows is strictly simpler; seam kept |
| Workflows | SKIP | Per-step durability for a 4-step 3×/day chain earns nothing |
| Hyperdrive | SKIP | No external database exists |
| Turnstile | SKIP | No anonymous form anywhere in v3 |
| Snippets | SKIP | Not on Free zone; Worker already runs first |
| Cache Rules for Worker-served audio | SKIP (do it in code) | Rules don't cache Worker-generated responses |
| Standalone Health Checks | SKIP | Pro-zone-only; the watchdog replaces it for £0 |
| Browser Rendering | SKIP | Routine's local Chrome does this for £0 |
| Bot Fight Mode | SKIP (leave OFF) | Unscopeable; would challenge the Routine and clients |

### 2.1 Compute and DOs — Phase 1

Both DO classes ship as SQLite-backed from the first migration — this is irreversible, KV-backed classes cannot convert later and get no SQL or PITR:

```toml
[[migrations]]
tag = "v3-1"
new_sqlite_classes = ["NewsroomDO", "ProfileDO"]
```

Verified worked numbers: 20 ProfileDOs ≈ 37,500 GB-s/mo, NewsroomDO ≈ 3,400 GB-s/mo, against 400,000 included; ~150k DO requests/mo of 1M (alarm invocations count; each `setAlarm()` is one row written). Even a 5× estimating error stays inside inclusions, and blowing the duration quota by 100k GB-s costs $1.25. The one behavioural rule: never hold a ProfileDO awake with long polls or timers — duration bills wall-clock at 128 MB while active. One stale-wording caveat from verification: the DO pricing page still says storage billing "will be enabled January 2026" in future tense; treat it as live and keep the budget alert regardless.

The signals Worker takes all five cadences as plain expressions — route on `controller.cron`, skip the "one cron, route by time" multiplexing pattern entirely:

```toml
[triggers]
crons = ["*/5 * * * *", "*/30 * * * *", "0 * * * *", "5 16 * * *", "30 6 * * *"]
```

Runtime limits that matter: 6 simultaneous outgoing connections means the 20-device APNs fan-out serialises in batches of six — milliseconds, fire from `ctx.waitUntil` or the DO alarm. Stream R2 audio (`R2ObjectBody.body` piped straight to the Response); never buffer against the fixed 128 MB. Keep ingest heavy-lifting in DO alarms (30 s CPU each, chainable) — the blueprint's alarm-chain design is already correct.

### 2.2 Deploy safety: versions, gradual, rollback — Phase 1

Three verified sharp edges, all DO-related:

1. **Preview URLs are never generated for Workers that implement a Durable Object** (verbatim limitation) — wire-api implements two, so previews are structurally unavailable, not merely unfashionable. Pre-prod poking happens on a staging environment (`[env.staging]`: own workers.dev URL, own DO namespaces, staging D1/KV) or via gradual deploys.
2. **Versions containing new DO migrations cannot even be uploaded**; migrations deploy only via full `wrangler deploy` and — the docs' own words — "should be deployed independently of other code changes". Standing rule: **migration-only commits, deployed alone**, additive schema only, never `deleted_classes` alongside risky code.
3. **Instant rollback** covers the last 100 versions but is refused if a DO migration occurred between the versions, or if a bound KV/D1/R2/queue was deleted in between — and it never touches data.

Operating procedure: risky merges go out via `wrangler versions upload` + `wrangler versions deploy` at 10%→100% (DO instances pin to one version and never flip-flop); `wrangler rollback` is the 2 a.m. lever; the deploy workflow greps the diff for `[[migrations]]` changes and, if found, skips auto-rollback and pages instead. Workers Assets deploy atomically with each version, so the web reader rides along.

### 2.3 Data layer — Phase 1

- **D1**: create `wire` DB for read_ledger, client registry, embeddings blobs, consent ledger. Time Travel gives 30-day PITR on Paid — but restore is **destructive and in-place** (`wrangler d1 time-travel restore <db> --timestamp=…` cancels in-flight queries, returns an undo bookmark; no fork/clone exists). It is also not offsite, hence the export job in section 4.
- **KV**: unchanged from v2. The 1 write/second/key limit is the only rule: the 30-min snapshot cron writes 48/day, the TfL 5-min cron 288/day — orders of magnitude clear; just never fan concurrent writers into one key.
- **R2**: keep `wire-audio` with its 14-day lifecycle; add private bucket `wire-backups` (prefixes `d1/`, `kv/`, `do/`, 30-day lifecycle). **Object versioning does not exist in R2 as of July 2026** — do not design around it; lifecycle expiry is the right shape. Audio caching: since `wire-audio` is served through the Worker, zone Cache Rules do nothing — set `Cache-Control: public, max-age=86400, immutable` in code and wrap the handler in `caches.default.match()/put()`. (If audio ever moves to a public custom domain like `audio.databased.business`, a Cache Everything rule plus native Range support becomes the better shape — Phase 3 option, not needed now.)

### 2.4 AI layer — Phase 1 (embeddings), Phase 2 (gateway)

```toml
[ai]
binding = "AI"
```

bge-m3 on title+lede: 40 stories × ~100 tokens ≈ 4.3 neurons/day against 10,000 free daily (verified) — permanently $0. No Claude models exist on Workers AI; renders go to Anthropic directly.

**AI Gateway** (Phase 2, when direct Messages calls appear): point non-batch calls at `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` via `ANTHROPIC_BASE_URL` — one env var buys logging plus the June 2026 **spend limits** (dollar budgets, up to 20 rules, 429 or fallback-model on breach, BYOK — verified). Verifier caveat: cost tracking is best-effort and eventually consistent, so keep Anthropic console limits as the hard backstop. The **Batch API is not documented** on the gateway — the ~140/day Haiku batch renders go straight to `api.anthropic.com`, capped in the Anthropic console.

### 2.5 Spend visibility — Phase 1

Three confirmed layers, all email-delivered because — **verifier refutation** — the reliability audit's claim that Notifications webhooks work on Workers Paid is wrong: live docs gate webhook destinations behind "at least one zone with a pro plan or above". A $5 Workers subscription on a Free zone does not qualify. Email is the only Notifications channel; phone delivery happens via the watchdog/ntfy path in section 4 instead.

1. **Budget alert** (confirmed real, Apr 2026): dashboard → Notifications, dollar threshold ~$8 on projected account spend; the Billable Usage dashboard is the single per-product spend view.
2. **Analytics Engine** for ElevenLabs/render metering — `writeDataPoint({indexes:["elevenlabs"], doubles:[chars], blobs:[userId, storyId]})` per render; read back via the SQL API or Grafana (Altinity ClickHouse plugin). 90-day retention makes it a dashboard, not a ledger — so also increment a monthly counter row in D1 for the permanent record.

```toml
[[analytics_engine_datasets]]
binding = "SPEND"
dataset = "wire_spend"
```

3. **Workers Logs** — free visibility into failures at our volume (~450k of 20M events/mo, sample 100%):

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

### 2.6 Email, Access, edge hygiene — Phase 1–2

**Email Sending** (Phase 2 for digests, Phase 1 for alerts): Workers Paid includes 3,000 emails/mo then $0.35/1,000; 20 users × 3 digests/day ≈ 1,800/mo fits. The load-bearing freebie: **sends to verified destination addresses in your account are free and unmetered** — alert mail to your own address costs nothing forever. Onboarding auto-configures SPF/DKIM/DMARC on a `cf-bounce` subdomain. Still beta; fine for this use.

```toml
[[send_email]]
name = "EMAIL"
remote = true
```

Enable **Email Routing** day one for exactly one route: `alerts@databased.business` → forward to iCloud (free, unlimited inbound), giving alert mail a same-domain reply path. Reply-to-digest ingestion is USE-LATER.

**Access** (Phase 1, dashboard not wrangler): self-hosted app on `wire.databased.business/dev/*` and admin paths, policy = allow `julianpaulelliott@icloud.com`, One-Time PIN. Free to 50 users; optionally verify `Cf-Access-Jwt-Assertion` in the Worker as defence-in-depth.

**Edge hygiene** (Phase 1, dashboard): one free WAF rate-limiting rule — `URI Path starts with /api/` at 50 req/10s/IP → block (Free plan counts by IP only, 10 s windows). Always Use HTTPS on; HSTS `max-age=31536000` after a week's confidence, no `includeSubDomains` until every subdomain is HTTPS-clean, no preload. **Bot Fight Mode stays off** — it cannot be scoped and would challenge the Routine's `POST /api/ingest` and client polling.

---

## 3. GitHub: what we use, what we skip

| Offering | Verdict | One-line reason |
|---|---|---|
| Actions, standard runners | **USE** | Free, no minute cap, public repo — incl. macOS for future iOS CI |
| Scheduled workflows (watchdog) | **USE** | The only probe outside Cloudflare's failure domain |
| Concurrency groups | **USE** | Already serialising deploys; add per-workflow groups |
| `actions/cache` via `setup-node` | **USE** | One line, saves 30–60 s per deploy |
| Environments (secret scoping) | **USE** | `production` env pins the CF token to `main` |
| Dependabot | **USE** | Weekly, grouped; never auto-merge wrangler/runtime deps |
| CodeQL default setup | **USE** | One click, zero maintenance, JS/TS |
| Secret scanning + push protection | **USE** | The most important toggle given history — confirm manually |
| Branch ruleset on `main` | **USE** | Block force-push/delete, require green checks; no PR requirement |
| Issue form (tester feedback) | **USE (light)** | Structures 20 testers' reports |
| OIDC → Cloudflare | **SKIP (doesn't exist)** | Scoped-token discipline instead |
| Larger runners | SKIP | Always billed, even on public repos |
| Artifacts / Releases / Pages | SKIP | No consumer; artifacts on a public repo are publicly downloadable |

### 3.1 The deploy pipeline (Phase 1)

Job-level spec for `.github/workflows/deploy.yml`:

1. **PR checks** — `vitest` + prompt-fixture snapshots; separate concurrency group from deploys.
2. **Deploy on `main`** — job carries `environment: production` (the environment holds `CLOUDFLARE_API_TOKEN`, deployment-branch policy = `main` only, so no branch or fork PR can exfiltrate it). Record `PREV=$(wrangler deployments list …)`, then `wrangler deploy`. Add `cache: "npm"` to `setup-node`. Skip required-reviewer rules — solo self-approval is friction you'd rubber-stamp.
3. **Smoke** — curl `/api/health` (200 + fresh) and `/api/feed/latest` (≥1 story), 3×10 s retries.
4. **Auto-rollback** — `wrangler rollback --version-id $PREV -y`, ntfy either way — **unless** the diff touched the `[[migrations]]` block, in which case skip rollback (it would be refused anyway) and page for a human decision.

### 3.2 Tokens: the honest OIDC answer

**No official Cloudflare OIDC path for wrangler exists as of July 2026** (verified: CI/CD docs still mandate a long-lived token; wrangler-action#402 and workers-sdk discussion #11434 remain open requests). Do not build a token-vending Worker. Instead: one API token scoped to one account with exactly Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, D1:Edit — not the broad "Edit Cloudflare Workers" template — stored in the `production` environment, rotated quarterly on a calendar reminder. Keep the existing token-verify step.

### 3.3 Dependabot and rulesets

`.github/dependabot.yml`: npm weekly with a grouped `dev-minor` rule (development deps, minor/patch), github-actions monthly. Auto-merge only dev-dependency patch/minor behind required checks; `wrangler` and runtime deps always get a manual glance plus the vitest gate. One ruleset on `main`: block force pushes and deletions, require `vitest` and `prompt-fixtures` status checks. Do not require PRs.

### 3.4 The payload.json history item

Verifier downgraded "push protection on by default" to PLAUSIBLE: it defaults on only for **new** personal-account public repos (post-March 2024) plus user-level pushes — repo-level push protection is "disabled by default" per current docs. So **manually confirming both toggles** (Settings → Code security: secret scanning AND push protection) is mandatory, not hygiene — this is the single most important checkbox on the GitHub list. On the leaked Apple sub in `payload.json`: rotate/invalidate first; the history rewrite is a pending decision for you, and the honest advice is that `git-filter-repo` un-leaks nothing on an already-mirrored public repo — treat the value as burned, rotate it, and skip the rewrite unless the file also contained anything key-shaped.

---

## 4. The reliability layer

Total monthly cost: £0. One external service (healthchecks.io) earns its place as the only thing that notices *silence* rather than errors. All of this is **Phase 1**, not "later" — see section 5.

### 4.1 Watchdog: probe + dead-man's-switch

**GitHub scheduled workflow** (`.github/workflows/watchdog.yml`, cron `*/30` offset off the hour, e.g. `7,37 * * * *`): curls `https://wire.databased.business/api/health`, asserts HTTP 200 and `newest_story_age_h < 10`; on failure reopens a pinned `watchdog-down` issue via `gh` and POSTs to ntfy. Documented caveats accepted honestly: runs can be delayed at the top of the hour (hence the offset), occasionally skipped under load, and **schedules auto-disable after 60 days of repo inactivity** — which is why every *successful* run also pings a healthchecks.io check, so the watchdog is itself watched.

**healthchecks.io** (free Hobbyist: 20 checks, 100 log entries/check — verified; note 100 entries on a 30-min check is ~2 days of history, fine for alerting, useless for forensics). ~6 checks: `ingest` (Routine pings after each successful `POST /api/ingest`; period 8 h, grace 2 h), `signals-daily` ×2, `nightly-backup`, `gh-watchdog` (period 30 min — this is the cross-brace that catches the 60-day disable), spare.

**`/api/health` contract** (single JSON, 503 if any check red): `ok`; `kv`/`d1`/`r2` (one read each, 500 ms timeout); `last_ingest` (KV heartbeat); `newest_story_age_h` (from NewsroomDO); per-cron KV heartbeats; `audio_spend_mtd_gbp` + `audio_cap_pct`; deployed `version` id.

### 4.2 Alert delivery to the phone

- **Primary: ntfy.sh** — free hosted, iOS app, publishable by plain HTTP POST from Actions, from the Worker's own `catch` blocks, and from healthchecks.io's webhook integration. Topic name unguessable (`wire-alerts-<random>`) — it is the only auth. **Corrected by the verifier: Cloudflare Notifications cannot POST to ntfy on this plan** (webhooks need a Pro zone); the Worker-and-Actions paths above are the substitutes and cover everything. *(Account-reality check, settled 6 Jul 2026: the dashboard renders the webhook Create button, but saving/testing the destination fails — the Pro-zone entitlement is enforced at save-time. The refutation stands in practice; Notifications stay email-only, and the GitHub→ntfy pipe was verified working end-to-end the same day.)*
- **Fallback: GitHub Mobile** — the watchdog's issue reopen + self-@mention produces a push through a different provider chain, surviving ntfy outages.
- **Email** — Cloudflare's budget/incident notifications and healthchecks.io's built-in secondary; never primary (silent-failure magnet). **Pushover** (one-time $4.99) is the USE-LATER upgrade if hosted ntfy proves flaky.

### 4.3 Backups — personal data never touches the public repo

Iron rule: backups never enter git and never go through `actions/upload-artifact` — artifacts on a public repo are publicly downloadable. Destination: private `wire-backups` bucket, 30-day lifecycle, <0.2 GB steady state — £0 inside R2's free tier.

Nightly Actions job (03:30 UTC), pinging `nightly-backup` on success:

- **D1**: `wrangler d1 export wire --remote --output=d1.sql` (verified) → gzip → `wrangler r2 object put wire-backups/d1/$(date +%F).sql.gz`. Time Travel (30-day PITR) is the second line — but it is in-place, destructive and not offsite, so the export is load-bearing.
- **KV**: `wrangler kv key list` → `wrangler kv bulk get` → JSON → gzip → same put. Data transits only the ephemeral runner.
- **DO-SQLite** — the real gap: **no built-in export exists** (verified). Two layers: (a) alarm-driven self-export — NewsroomDO's nightly alarm serialises its tables and RPC-fans-out to each ProfileDO via the D1 client registry; each dumps NDJSON to `wire-backups/do/{class}/{name}/{date}.ndjson.gz` through an R2 binding (~30 lines, plus a matching `import()` RPC used by the drill); (b) platform PITR — bookmark restore to any point in the last 30 days (`getBookmarkForTime()` + `onNextSessionRestoreBookmark()`), verified but **code-invoked only, no dashboard, no export, unsupported in local dev**. PITR covers "I wrote a bad migration"; the R2 sweep covers "the DO is gone". Ship the sweep in week one.

### 4.4 Quarterly restore drill

`scripts/restore-drill.sh`, documented in `docs/RUNBOOK.md`: throwaway `wire-restore-test` D1 → `d1 execute --file` the latest export → assert row counts against a manifest; `kv bulk put` into a scratch namespace; call a staging ProfileDO's `import()` with one NDJSON dump and diff traits. Reminder lives in the timebomb workflow. A backup you haven't restored is a rumour.

### 4.5 Calendar failure modes

One `.github/timebombs.yml` (dates only, no secrets) + a weekly workflow filing an issue 30 days ahead (issue → GitHub Mobile push), mirrored in your personal calendar:

| Bomb | Blast radius | Reminder lives in |
|---|---|---|
| Apple Developer Program lapse (£79/yr) | Sign in with Apple + APNs die for everyone | timebomb −30d + calendar; auto-renew on |
| TestFlight builds expire after 90 days | app stops launching for all 20 testers | timebomb: "ship any build" every 75 days |
| Provisioning profiles (annual) | local builds only | calendar |
| APNs key type | whole bomb class removed | decision: use a non-expiring `.p8` token key |
| Domain renewal / registrar card | everything | auto-renew + timebomb at card-expiry month |
| Cloudflare billing card expiry | Paid lapses: crons throttle, Time Travel drops to 7 days | CF billing email + timebomb |
| ElevenLabs creeping spend / cap reset | audio dies mid-month | `audio_cap_pct` in `/api/health`; watchdog alerts ≥80% |
| GitHub 60-day schedule disable | monitoring dies silently | healthchecks.io `gh-watchdog` check |
| Quarterly restore drill | untested backups | timebomb, quarterly |
| CF API token rotation | deploys fail | calendar, quarterly |

---

## 5. Blueprint deltas (one edit pass on V3_BLUEPRINT.md)

1. **§9 (secrets/config):** add `NTFY_TOPIC` (unguessable, treated as a secret), the scoped four-permission `CLOUDFLARE_API_TOKEN` spec with quarterly rotation, `ANTHROPIC_BASE_URL` = AI Gateway **for non-batch calls only** (batch → direct + Anthropic console cap), and the rule that the token lives in the GitHub `production` environment, branch-policy `main`.
2. **§9 (policy):** add the standing deploy rule verbatim: *DO migrations ship as migration-only commits, deployed alone via full `wrangler deploy`; additive schema only; auto-rollback is skipped whenever the `[[migrations]]` block changed.*
3. **§10 (cost table):** replace any per-product infra estimates with a single line — *infra = $5/mo flat, all v3 quotas <20% utilised, verified July 2026* — and add the £55–70/mo do-nothing comparison as a footnote. Correct any mention of Cloudflare webhook alerting: **email-only on this plan** (verifier-refuted); phone alerts go via ntfy/GitHub.
4. **§12 Phase 1 acceptance criteria (additions):** watchdog workflow live and pinging healthchecks.io; nightly D1/KV/DO backups landing in `wire-backups` with the DO NDJSON sweep; `/api/health` implementing the full contract (heartbeats, spend, version); budget alert at ~$8; `new_sqlite_classes` migration deployed; Access on `/dev/*`; secret scanning + push protection toggles **manually confirmed** on the repo; ruleset on `main`; dependabot.yml merged.
5. **§12 Phase 2 additions:** Email Sending digests (within 3,000/mo included) + `alerts@` inbound route; AI Gateway spend limits in front of direct Messages calls; Analytics Engine `wire_spend` dataset plus the D1 monthly counter row.
6. **New `docs/RUNBOOK.md` items:** rollback procedure (incl. the migration-blocked case), restore drill script + quarterly cadence, timebomb table, the payload.json decision record (value burned + rotated; history rewrite declined unless key-shaped material is found), and the R2-audio caching note (in-Worker `caches.default`, not zone Cache Rules).

---

## 6. Appendix — verification table

| Claim | Status | Note |
|---|---|---|
| Workers Paid: 10M req (+$0.30/M), 30M CPU-ms (+$0.02/M), no duration charge, free unlimited static assets | CONFIRMED | Verbatim on pricing page; $5 bundles KV/DO/D1/Logs base quotas |
| DO pricing: 1M req (+$0.15/M, alarms count), 400k GB-s (+$12.50/M), SQLite 25B reads/50M writes/5 GB-mo (+$0.20), setAlarm = 1 row | CONFIRMED | Page still future-tenses Jan 2026 storage billing; treat as live |
| DO arithmetic: 37,500 GB-s ProfileDOs, ~3,400 GB-s NewsroomDO, ~150k req/mo, $1.25 per 100k GB-s overage | CONFIRMED | Recomputed clean; marginal cost $0 holds |
| D1 Time Travel: 30-day PITR Paid, destructive in-place, undo bookmark, no fork/clone | CONFIRMED | Offsite export to R2 therefore stands |
| DO-SQLite bookmark PITR: 30 days, code-invoked only, no export, no dashboard | CONFIRMED | Nightly JSON-to-R2 sweep is genuinely required, not optional |
| Workers AI: 10k free neurons/day both plans; bge-m3 $0.012/M tokens ≈ 4.3 neurons/day for us | CONFIRMED | Permanently $0 |
| AI Gateway spend limits (Jun 2026): 20 rules, 429/fallback, BYOK | CONFIRMED | Cost tracking best-effort — keep Anthropic console cap as backstop |
| AI Gateway supports Anthropic but not the Batch API | CONFIRMED | Only /v1/messages documented; batch goes direct |
| R2 free tier (10 GB-mo, 1M A, 10M B, zero egress); no object versioning | CONFIRMED | Lifecycle-expiry design and £0 backup maths hold |
| Actions free, no cap, public repos, standard runners incl. macOS; larger runners always billed | CONFIRMED | Never request a larger runner |
| No Cloudflare OIDC for wrangler (July 2026) | CONFIRMED | wrangler-action#402 / workers-sdk#11434 still open; scoped token instead |
| Secret scanning + push protection free and on by default for public repos | PLAUSIBLE | Repo-level push protection defaults off unless repo is post-Mar-2024 personal-account — manual toggle check is mandatory |
| Rollback: last 100 versions, blocked by intervening DO migration or deleted bound resources, never reverts data | CONFIRMED | Deploy workflow's skip-on-migration rule correctly derived |
| No preview URLs for DO Workers; gradual deploys pin DO instances; migration versions can't be uploaded — full deploy only, shipped independently | CONFIRMED | Staging env + gradual deploys are the substitutes |
| Email Sending: Workers Paid, 3,000/mo then $0.35/1,000; verified-address sends free/unmetered; inbound routing unlimited | CONFIRMED | Still beta; 1,800/mo digests fit |
| Access free plan: 50 users, $7/user/mo beyond | CONFIRMED | 24 h Zero Trust log retention on free — fine |
| healthchecks.io Hobbyist: $0, 20 checks, 100 log entries/check | CONFIRMED | ~2 days of history on a 30-min check — alerting, not forensics |
| Cloudflare Notifications webhooks available on Workers Paid | **REFUTED** | Requires a **Pro+ zone**; Workers Paid on a Free zone does not qualify. Email-only Notifications; ntfy wiring moves to Worker/Actions/healthchecks paths. Budget alerts themselves confirmed (Apr 2026, email-delivered) |
