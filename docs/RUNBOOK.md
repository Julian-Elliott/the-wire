# The Wire — Runbook

Operational procedures for the solo operator. Sources: docs/research/PLATFORM_LEVERAGE.md (verified July 2026) and docs/V3_BLUEPRINT.md §9–§12. This file is the 2 a.m. document: every procedure here is meant to be executable without thinking.

## 1. Rollback

```
wrangler rollback            # interactive: pick the last known-good version
wrangler rollback --version-id <id> -y
```

- Rollback covers the **last 100 versions** and never touches data (KV/D1/R2/DO state stay as they are).
- Rollback is **refused** if a DO migration happened between the versions, or if a bound resource (KV namespace, D1 DB, R2 bucket, queue) was deleted in between.
- The deploy workflow greps the diff for `[[migrations]]` changes: if the block changed, **auto-rollback is skipped and a human is paged** — fix forward with a new migration-only deploy instead.
- Standing rule: **DO migrations ship as migration-only commits, deployed alone via full `wrangler deploy`, additive schema only.** Never bundle a migration with risky code.
- Risky (non-migration) merges go out gradually: `wrangler versions upload` → `wrangler versions deploy` at 10% → 100%. DO instances pin to one version — they never flip-flop mid-rollout.
- No preview URLs exist for this Worker (it implements Durable Objects). Pre-prod poking happens on `[env.staging]` (own workers.dev URL, own DO namespaces, staging D1/KV).

## 2. Alerts

- **Primary:** ntfy.sh topic `$NTFY_TOPIC` (unguessable name is the only auth — treat as a secret). Publishers: the watchdog workflow, the Worker's own catch blocks, healthchecks.io webhooks.
- **Fallback:** the watchdog reopens the pinned `watchdog-down` issue with a self-@mention → GitHub Mobile push (different provider chain; survives ntfy outages).
- **Cloudflare Notifications: email-only on this plan (settled 6 Jul 2026).** The dashboard renders the webhook Create button, but the save/test fails — the Pro-zone entitlement is enforced at save-time, exactly as the docs gate says. Budget tripwire (~$8) and incident notices arrive **by email**; do not re-attempt the webhook unless a zone is upgraded to Pro+. The GitHub→ntfy pipe was verified working the same day (test-alerts workflow, HTTP 200), so everything urgent still reaches the phone via the watchdog and Worker paths.
- Upgrade path if hosted ntfy proves flaky: Pushover (one-off ~$5).

## 3. Watchdog

- `.github/workflows/watchdog.yml`, cron `7,37 * * * *` (offset — top-of-hour schedules get delayed). Probes `https://wire.databased.business/api/health`: asserts HTTP 200 and `newest_story_age_h < 10`. On failure: reopen `watchdog-down` issue + POST to ntfy.
- Every **successful** run pings the healthchecks.io `gh-watchdog` check (period 30 min) — this catches GitHub's 60-day inactivity auto-disable of schedules. The watchdog is itself watched.
- healthchecks.io (free tier, 20 checks): `ingest` (routine pings after each successful POST /api/ingest; period 8 h, grace 2 h), `signals-daily` ×2, `nightly-backup`, `gh-watchdog`.
- `/api/health` contract (single JSON, 503 if any check red): `ok`; `kv`/`d1`/`r2` one-read checks (500 ms timeout); `last_ingest`; `newest_story_age_h`; per-cron heartbeats; `audio_spend_mtd_gbp` + `audio_cap_pct` (alert ≥80%); deployed `version`.

## 4. Backups and restore

**Iron rule: backups never enter git and never go through `actions/upload-artifact` — the repo is public and artifacts are publicly downloadable.** Destination: private R2 bucket `wire-backups` (prefixes `d1/`, `kv/`, `do/`), 30-day lifecycle.

Nightly Actions job (03:30 UTC; pings `nightly-backup` on success):

- **D1:** `wrangler d1 export wire --remote --output=d1.sql` → gzip → `wrangler r2 object put wire-backups/d1/$(date +%F).sql.gz`. Time Travel (30-day PITR) is the second line of defence — but restore is **destructive and in-place** (undo bookmark, no fork), and it is not offsite, so the export is load-bearing.
- **KV:** `wrangler kv key list` → `wrangler kv bulk get` → JSON → gzip → same put. Data transits only the ephemeral runner.
- **DO-SQLite:** no built-in export exists. (a) NewsroomDO's nightly alarm serialises its tables and RPC-fans-out to every ProfileDO via the D1 client registry; each dumps NDJSON to `wire-backups/do/{class}/{name}/{date}.ndjson.gz`; a matching `import()` RPC exists for the drill. (b) Platform PITR: bookmark restore to any point in the last 30 days (`getBookmarkForTime()` + `onNextSessionRestoreBookmark()`) — code-invoked only, no dashboard, no export. PITR covers "I wrote a bad migration"; the R2 sweep covers "the DO is gone".

**Quarterly restore drill** (`scripts/restore-drill.sh`; timebomb issue reminds you): throwaway `wire-restore-test` D1 → `d1 execute --file` the latest export → assert row counts against the manifest; `kv bulk put` into a scratch namespace; call a staging ProfileDO `import()` with one NDJSON dump and diff traits. A backup you haven't restored is a rumour.

## 5. Routine failure (degraded mode)

If the Claude Code Routine or its subscription billing dies: the metered fallback is Sonnet doing L1 research at roughly **$1.30/day**, fired from the Worker cron. Pre-made decision — switch, don't deliberate. Restore the routine when possible; the fallback is a degraded mode, not a destination.

## 6. Audio spend

- `AUDIO_PAUSED = "true"` in `wrangler.toml` + deploy is the kill switch for **every** ElevenLabs spend path (deployed in anger in v2; stays wired).
- `audio_cap_pct` in `/api/health` alerts at ≥80% via the watchdog.
- Fallback mode before the kill switch: dominant-cell-only audio rendering.

## 7. Calendar timebombs

`.github/timebombs.yml` (dates only, no secrets) + a weekly workflow filing an issue 30 days ahead; mirrored in the personal calendar.

| Bomb | Blast radius | Reminder |
|---|---|---|
| Apple Developer Program lapse (£79/yr) | Sign in with Apple + APNs die for everyone | timebomb −30d + calendar; auto-renew on |
| TestFlight builds expire after 90 days | app stops launching for all testers | timebomb: "ship any build" every 75 days |
| Provisioning profiles (annual) | local builds only | calendar |
| Domain renewal / registrar card | everything | auto-renew + timebomb at card-expiry month |
| Cloudflare billing card expiry | Paid lapses: crons throttle, Time Travel drops to 7 days | CF billing email + timebomb |
| ElevenLabs cap / creeping spend | audio dies mid-month | health `audio_cap_pct` ≥80% alert |
| GitHub 60-day schedule auto-disable | monitoring dies silently | healthchecks.io `gh-watchdog` |
| Quarterly restore drill | untested backups | timebomb, quarterly |
| CF API token rotation | deploys fail | calendar, quarterly |

APNs uses a non-expiring `.p8` token key — that bomb class is removed by choice of key type.

## 8. Decision record — payload.json in public git history

A `payload.json` containing an Apple `sub` (the stable pairwise user identifier from Sign in with Apple) landed in the public repo's history during v2 development. Assessment (PLATFORM_LEVERAGE §3.4): the `sub` is an **identifier, not a credential** — it cannot authenticate anything on its own (Apple signs the tokens); the exposure is privacy linkage, not account compromise. A `git-filter-repo` rewrite would un-leak nothing on an already-mirrored public repo. **Recommendation: treat the value as burned, skip the history rewrite, and prevent recurrence with push protection (now to be manually confirmed in repo settings).** Final call is Julian's — recorded here as recommended, not yet ratified.

## 9. R2 audio caching note

`wire-audio` is served **through the Worker**, so zone Cache Rules do nothing. Set `Cache-Control: public, max-age=86400, immutable` in code and wrap the handler in `caches.default.match()/put()`. If audio ever moves to a public custom domain (`audio.databased.business`), switch to a Cache Everything rule with native Range support — a Phase 3 option, not needed now.
