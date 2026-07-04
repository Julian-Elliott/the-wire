# The Wire v3 — Newsroom & Butler

## Vision

The Wire v3 is a personal news product whose differentiator is not better news generation but **respectful delivery**: interrupt me when it matters, stay silent when it doesn't, and never make me pay attention twice to the same story. The editorial engine that already works — the Claude Code Routine researching on subscription against a versioned `briefing-prompt.md` — stays; around it we build a properly layered content pipeline (shared fact-extraction, enumerable render cells, LLM-free assembly), a standalone personal-context service ("Persona") that every future app can query, and a native iOS app that acts as sensor, gatekeeper and player. The server scores and offers; the phone decides. The web at `wire.databased.business` remains a complete reader, so nothing time-critical ever depends on a single broken build. This document is the decision-complete blueprint: architecture, data model, economics with the worked numbers, delivery policy, migration from v2, a 90-day plan with acceptance criteria, and an honest account of what it costs and where it can fail.

## What v3 is betting on

1. **Delivery, not generation, is the moat** — only a native iOS app can express both halves of "interrupt me when it matters, stay silent when it doesn't"; the PWA ceiling (no interruption levels, no background wake, no Focus signal) makes web-as-primary a dead end.
2. **At N=20 the LLM economics are won by sharing L1 fact-extraction (4–5× token saving), not cell caching (~2× until N≈70)** — so the layered cache is built as ~50 lines of cheap plumbing that becomes a 3,300× reuse factor if N ever passes ~136, while we spend nothing on it today.
3. **The reusable asset is Persona**: one profile Durable Object per user, fed only coarse enumerated states reduced on-device, queried by every future app through a scoped MCP/HTTPS surface — the phone is the sensor and the gatekeeper, and the server's most sensitive fact is "commuting".
4. **Privacy enforced by architecture beats privacy promised by policy** — raw Focus, location, health and calendar data never leave the phone, push payloads carry only IDs, and every trait is explainable and deletable.
5. **Solo-dev survivability is a design constraint, not an afterthought** — the fewest primitives that work (DOs, D1, KV, R2, cron), a server that is client-complete before any Swift ships, and tests seeded from v2's audited failure list before feature code.

---

## 1. System architecture

```
       Claude Code Routine (cron 0 6,12,18, subscription billing)
                     │ POST /ingest (L1 briefs + salience + dominant-cell renders)
                     ▼
┌─ Cloudflare ────────────────────────────────────────────────┐
│ wire-api  (TypeScript Worker, typed routes, vitest)         │
│  ├─ NewsroomDO ...... canonical stories, cells, build status│
│  ├─ ProfileDO/user .. signals → traits → policies (Persona) │
│  ├─ signals Worker .. cron pollers: PlanIt, Open-Meteo,     │
│  │                    Octopus, Carbon Intensity, TfL        │
│  ├─ D1 .............. client registry, consent ledger,      │
│  │                    policy versions, read_ledger,          │
│  │                    story embeddings (brute-force cosine)  │
│  ├─ KV .............. profile snapshots, edge caches        │
│  └─ R2 .............. audio cells, greetings, beats, images │
└──────┬──────────────────────┬────────────────┬─────────────┘
  APNs (timeSensitive /    Web Push        HTTPS JSON
  active / Live Activity)  (Android/desktop)
       ▼                      ▼                ▼
 iOS app (SwiftUI,       any browser      Web reader @
 TestFlight)                              wire.databased.business
 on-device context engine:                full read/settings parity
 Focus, EventKit, CLMonitor,
 HealthKit → coarse states only
```

**Components, and why each exists:**

- **Claude Code Routine** — unchanged editorial engine. Research happens on subscription billing three times a day; `briefing-prompt.md` remains the versioned editorial contract (desk table, salience rubric, tone rules) that can be edited without a deploy. New in v3: the routine also renders the *dominant* L3 cells during its run, so the most-read renders ride the subscription too — the single biggest lever on metered LLM cost.
- **wire-api Worker** — one TypeScript Worker with typed routes and a vitest suite. No route ships untested; the v2 lesson (a 2,170-line untyped `worker.js` in which 19 bugs shipped silently) is the reason this is a hard rule, not a preference.
- **NewsroomDO** — the single writer for the feed. It kills two v2 pathologies at once: the shared-mutable KV feed with hand-rolled merge and no CAS ("the later write clobbers — accepted at this scale" was written into v2's own source), and the implicit distributed "generating" state machine of markers, poll counters and cooldown special-cases. Build status becomes explicit rows.
- **ProfileDO (Persona)** — one SQLite-backed Durable Object per user, keyed `idFromName(userId)`. Owns signals, decayed traits, and policy evaluation. Deliberately does *not* own The Wire's read-state (see §2) so that client two and three inherit a clean profile service, not The Wire's plumbing.
- **signals Worker** — cron pollers for the five zero-friction UK sources (§7), emitting `trigger` events into NewsroomDO.
- **D1 / KV / R2** — client registry, consent ledger, policy versions, the Wire-specific `read_ledger`, and story embeddings live in D1; ~3 KB profile snapshots and edge caches in KV; audio cells, greeting clips, beats and images in R2, content-addressed.
- **Pipeline orchestration** — the ingest→cluster→render→TTS chain runs as a DO alarm chain inside NewsroomDO, with each step writing an explicit build-status row. This is designed as a seam: if per-step durability ever needs more, Cloudflare Workflows is an afternoon swap, but at 40 stories/day the exotic primitive must never be load-bearing. The same seam philosophy applies everywhere a novel primitive tempts us: story clustering uses brute-force cosine over embeddings stored as D1 rows (trivially cheap at 40 stories/day), with Vectorize as the deliberate later swap if scale demands it.

The deliberate absences matter as much as the presences: no Queues, no Workflows, no Vectorize, no separate auth subdomain, no service mesh of four workers. The economics judge was right that decomposition buys nothing at 40 stories/day and 20 users; the operator judge was right that two DO classes and one cron worker is what you want to debug at 2 a.m.

## 2. Data model

**Content units (NewsroomDO + D1 + R2):**

- **`story` (L1)** — one per real-world event, global, 100% shared: `{story_id = cluster-centroid hash, facts, entities, timeline, saga_id, salience 0–100, sources[]}`. Clustering: embed title+lede, cosine ≥ ~0.85 within 48 h plus an entity-overlap check; chain clusters across days into sagas. Saga-awareness is the mechanism that actually stopped reworded repeats in v2 (commit a92c4bd), so `saga_id` is first-class, not an afterthought.
- **`cell` (L3)** — a text render keyed `SHA256(story_hash ‖ desk ‖ pitch(0–2) ‖ tone ‖ len ‖ prompt_ver ‖ model_id)`. Content-addressed, so a prompt or model bump invalidates cleanly — this generalises v2's `POD_RENDER_VERSION` trick, which force-re-rendered every cached episode after the Xing fix with zero migration code.
- **`audio_cell`** — R2 object keyed `(cell_hash, voice_id, render_ver)`. Greetings and name clips are **separate short objects, never baked into shared bodies** — the direct lesson of the pitch-shift and Xing-header bugs, both of which came from doing MP3 byte surgery in a Worker. v3 does no audio container manipulation server-side; the client stitches beats + greeting + body with `AVQueuePlayer` playlists.
- **`trigger`** — `{source, entity, geo_class, dedup_key, expires, priority}` from the signals Worker.

**Profile (ProfileDO, SQLite):**

- `signals` — append-only `{ts, source_app, type, entity, value}`, pruned at 90 days (aggregates survive in traits).
- `traits` — `{key, value, confidence, half_life_days, updated_at, evidence_count}`. Affinity traits decay exponentially (τ = 30–90 days; update rule `w ← w·e^(−Δt/τ) + η·signal_strength`, skips counting −0.3× a play); rhythm traits (chronotype, commute windows, interruption tolerance by hour) are recomputed weekly by the DO alarm. Agents may only *propose* trait updates; the decay job owns the table — no free-text rot.
- `policies` — versioned JSON in D1, ~10–30 rules, evaluated in the DO so `is_interruptible` is one RPC.
- KV snapshot `profile:{uid}:snapshot` (~3 KB, top-20 traits + coarse state) for cheap eventually-consistent reads; anything real-time reads the DO.

**Read-state (Wire's own D1, *not* Persona):** a `read_ledger` with the four-state enum `{delivered, seen, read, dismissed}` per (user, story). This kills the v2 intersection-observer bug class outright ("all my news articles disappeared on refresh" — two fixes in one day for one client-side filter means the state model was wrong) and the localStorage-doesn't-roam class with it. It lives in The Wire's D1 rather than ProfileDO deliberately: the economics critique of the winning proposal was that coupling client-one state into the shared profile makes every future client inherit The Wire's plumbing. Persona stays app-agnostic; The Wire keeps its own ledger.

**Coarse device states (the only context the server ever stores):** `state ∈ {focus, meeting, commuting, workout, asleep, open}` and `place_class ∈ {home, work, transit, away}`. No coordinates, no Focus names, no health records. Each coarse-state report carries a timestamp; **state decays to `unknown` after 30 minutes, and `unknown` always demotes to digest** (the trust ladder, §5).

## 3. Content pipeline and the reuse economics, spelled out

The pipeline is five layers; the money question is which layer the tokens live in.

| Layer | Produces | Shareable? | Cache key |
|---|---|---|---|
| L0 ingest | raw articles, fact extraction | global | source URL hash |
| L1 story brief | one deduped brief per event | global, 100% | `story_id` |
| L2 desk angle | framing per desk | all users on desk | `(story_id, desk_id)` |
| L3 render | final text per pitch×tone×length | all users in cell | content-addressed hash |
| L4 assembly | ordering, dedup, saga recall, greeting | per-user | none — recomputed, LLM-free |

**L1 is the expensive read and it is already free.** Reading the sources costs ~5k tokens per story; the routine does it once per story on subscription billing. In the worked example (40 stories/day, 20 users, 12 desks each, so ~16 stories consumed per user per day), the naive design — rewrite each story per user from sources — costs 320 renders and ~1.6M input tokens/day. The layered design pays the 5k-token read once per story and renders from the 900-token brief: ~330k tokens/day at realistic cell occupancy. That 4–5× token saving, not cell caching, is the near-term win. v2 had it accidentally; v3 keeps it deliberately.

**L3 cells are enumerable, not per-user.** "Liverpool die-hard vs newcomer" feels continuous but collapses to 3 pitch levels × 4 tones = 12 cells maximum per story, and at friends-and-family scale users cluster into ~4 occupied cells — roughly 140 renders/day for 40 stories, each a short Haiku call. The honest maths on cache reuse: with q ≈ 0.033 per user per cell, the hit rate at N=20 is only ~49% — user 21 still needs ~8 fresh renders of their ~16 items. The 90% crossover is N≈68; 99% at N≈136, where the render count caps at S·C = 480/day regardless of N and the reuse factor versus naive reaches ~3,300×. So we do not pretend caching is today's win; we build the content-addressed keys because they are ~50 lines of plumbing with an enormous option value.

**Where the render spend goes.** Dominant cells (expected requesters N·q ≥ 1 — in practice the top cell of each followed desk) are rendered *inside the routine*, riding the subscription. Overflow and tail cells render lazily on first assembly via the Batch API (−50%, and the 3×/day digest cadence tolerates batch latency) — queued at ingest for eager cells the routine didn't cover. Custom desks get a **per-user cell cap with lazy-only rendering**, the one control that stops custom desks fragmenting the enumerable grid and re-inflating render costs.

**L4 assembly is LLM-free.** Ranking = desk weight × salience × recency × trait affinity; dedup against the `read_ledger`; saga continuity from `saga_id`; the recency gate drops only confidently-dated stale items (the v2 rule that avoided false-positive drops). Optional bespoke transitions ("after yesterday's verdict…") are one tiny Haiku call per digest — 60/day, noise. Anything genuinely continuous (the user's name, "as you heard on Tuesday") lives in L4 or in separable audio clips, never baked into a cached render.

**Audio** follows the same maths at `(cell_hash, voice_id)`, strictly lazily: render on first play, share thereafter. The `AUDIO_PAUSED` kill switch carries forward and gates *every* ElevenLabs spend path — it was deployed in anger in v2 when the usage cap was hit, and it stays wired from day one. The explicit budget bound beyond the switch: a dominant-cell-only audio fallback mode.

## 4. Persona: the personal context engine

One profile per user, derivation strictly one-directional: **signals → traits → policies**. The design copies what has actually worked elsewhere and rejects what hasn't: from ad-tech taxonomies, the affinity/in-market split and weighted topics (~50–150 is plenty), while rejecting inference the subject can't read — every trait shows *why* (which signals) and has a delete button; from industrial recsys, the long-term-embedding vs session-intent split, which is why three skipped football stories this morning must not nuke a two-year football affinity; from agent-memory practice, tool-mediated just-in-time retrieval, while rejecting free-text accretion.

**Agent surface** — an MCP server (Agents SDK) whose tools are also plain HTTPS POST:

```
get_context(domain, budget_tokens?)      → compact brief for prompt injection
get_trait(key) / query_traits(prefix, …) → trait reads
is_interruptible(priority: 1|2|3)        → {decision: interrupt|digest|silent, reason, retry_after?}
get_pitch_level(topic)                   → {level 0–3, label, rationale}
record_signal(type, entity, value, app)  → {accepted, affected_traits[]}
propose_trait_update(key, value, evidence) → {status: queued}
get_recent_signals(types?, since?, limit?) → Signal[]
```

**Access model** is OAuth-lite: a D1 client registry with `noun.verb` scopes (`news.traits:read`, `signals.news:write`, `state.coarse:read`, `policy:eval`, …), HS256 JWTs minted by an admin CLI, 90-day expiry, no refresh flow — re-mint. The MCP tool list itself is scope-filtered: a future meal-planner holding `diet.traits:read` structurally cannot see location signals or `get_recent_signals`. Every read appends to a per-user audit ring buffer surfaced on the profile page: "The Wire read `topic.football` 14× this week." A consent ledger in D1 records every grant and revocation.

**Platform discipline, borrowed verbatim from the runner-up:** Persona is time-boxed to ~one week of build, with a falsifiable acceptance test — **Wire FM must integrate as client two in under a day**. If it can't, Persona folds back into the Wire worker and the platform experiment ends having cost a week, not a quarter. And because one user's data lives in one DO, **GDPR export and erasure are single-object operations** — worth stating on the privacy page in exactly those words.

## 5. Delivery tiers and the interruption gate

The server never decides to interrupt; it **scores and offers**. Every candidate carries `priority ∈ {1,2,3}`: 3 = commute-breaking trigger ("your 07:42 is cancelled", M6 closed); 2 = high-salience desk story; 1 = digest filler.

| Tier | Mechanism | Gate |
|---|---|---|
| **Interrupt** | `timeSensitive` APNs push (capability checkbox, no approval) | priority 3 AND fresh coarse state passes `is_interruptible` AND inside wake window |
| **Digest** | scheduled `active` notification at the user's 3 editions | anything priority ≥ 2 that failed the interrupt gate is folded in — **never dropped** |
| **Ambient** | Live Activity ("morning edition ready", saga scores) + widget | none — non-interrupting by construction; frequent-updates flag on score days |
| **On-demand** | app/web feed, Wire FM audio | everything |

**The mechanics, honestly.** The operator judge correctly flagged that the original proposal glossed how a device "locally suppresses a push": iOS gives no unapproved way to silently drop an incoming alert push (the filtering entitlement is approval-gated; silent-push wakes are budgeted ~2–3/hour). So v3 splits the gate in two:

1. **Server-side gate (authoritative for pushes).** Before sending any timeSensitive push, the server evaluates `is_interruptible(priority)` in the ProfileDO against the *last-reported* coarse state, under the trust ladder: **state older than 30 minutes decays to `unknown`, and `unknown` always demotes to digest**. Interrupts additionally require high trait confidence on the topic. This is deliberately conservative — a legitimate interrupt occasionally demotes, but the failure mode is a story arriving 4 hours later in a digest with a note, never a ping during a funeral.
2. **Device-side gate (final veto for locally-scheduled notifications).** The iOS app prefetches candidates opportunistically (silent push as prefetch, BGAppRefresh as backstop, Live Activity pushes carrying payloads) and schedules local notifications after checking live context — Focus boolean via `INFocusStatusCenter`, Focus Filter value, EventKit busy, CLMonitor place class, `CXCallObserver` in-call, HealthKit sleep lag. Raw context never leaves the phone; the device reports back only the coarse state and the decision, as a signal. The device is also what keeps the server's picture fresh: Focus Filter intents fire in the background on every Focus switch, CLMonitor and visit monitoring relaunch a terminated app, so in practice the 30-minute freshness window is usually met at exactly the moments that matter (start of commute, entering a meeting).

**Trust UX (grafted, non-negotiable):** every interrupt carries a one-line *why* ("interrupted because: commute trigger, TfL, you're in your commute window") and a one-tap **"never again for this"**; every policy-demoted story appears in the digest with a *why demoted* note ("held back — you were in a meeting"). Silent suppression becomes inspectable behaviour, which is what makes users leave the gate switched on. Where a delivery channel is unavailable entirely, interrupts visibly demote to "top of next digest" with a label — honest degradation over fudged parity.

**Never** critical alerts (approval effectively refused for a briefing app), never guaranteed sub-hour background polling, never DeviceActivity/Screen Time export or SensorKit — all red in the audit (Appendix B).

## 6. Clients

**Commitment: a native SwiftUI iOS app, TestFlight-distributed, is the primary surface.** The Apple-context audit (Appendix B) is decisive: every mechanism this product needs is native-only and green/amber — Focus boolean (`INFocusStatusCenter` + the Communication Notifications checkbox), Focus Filters via `SetFocusFilterIntent`, `UNNotificationInterruptionLevel`, Live Activities, EventKit/CLMonitor/CallKit heuristics, AlarmKit (iOS 26) for a legitimate wake-up edition. The PWA ceiling on iOS is visible web-push banners that Focus silences, no background anything: the web cannot express either half of "interrupt respectfully based on context". Shortcuts automations ship as an importable power-feature (a *Work Focus on → POST /context* automation leaks the Focus name the official API withholds, running silently since iOS 17) — but nothing depends on them; they are fragile and per-user hand-assembled.

**Bias mitigation, because one developer now owns Swift and TypeScript and App Review could quibble with the focus-status framing:** TestFlight-only at N=20 (no review pressure; the communication-notifications capability is a checkbox); the iOS app stays a *thin* client — candidates in, policy decisions out, zero editorial logic; and the app's MVP is deliberately tiny (login, digest view, one notification gate). If the app stalls half-built, interruptions are late, not the news.

**wire.databased.business is a complete reader**, not a stub: full read and settings parity, Sign in with Apple via the JWKS-verified `form_post` flow carried over from v2 (no client secret, no `.p8` signing). A broken app build never locks anyone out of the news, only out of the interruptions. And the interrupt tier is not iOS-only from day one: **Web Push serves Android and desktop browsers immediately** — it lacks interruption levels and context, so it is gated purely by the server-side trust ladder, but "your train is cancelled" reaching an Android partner in week 4 beats reaching them in week 12.

## 7. UK signals: sources and build order

The signals Worker ships in **weeks 5–8**, pulled forward from the original weeks 9–12 slot, because locality triggers are the product's delight and the interrupt tier needs something worth interrupting for. Build order, by delight-per-line-of-code and integration friction (full catalogue in Appendix C):

1. **PlanIt** — a single daily radius query per user; "new planning application 250 m from home" is the catalogue's highest-delight alert for trivial cost.
2. **Open-Meteo** — no key, 10k calls/day; frost-on-car and washing-line triggers on day one (swap to Met Office DataHub later if official data matters).
3. **Octopus Agile prices** — unauthenticated; one poll at ~16:05 daily for "electricity is 4p/kWh 02:00–05:00".
4. **Carbon Intensity API (NESO)** — no key, 30-minute poll, instant "grid is green, run the dishwasher".
5. **TfL Unified API** — one free key, 500 req/min, the entire London commute story in clean JSON. Non-London users substitute the NR Knowledgebase Disruptions REST feed via the Rail Data Marketplace; the Darwin Kafka Push Port is explicitly phase-two-or-never.

Deferred: BODS (XML volume), bin collections (per-council scraper maintenance), Skiddle/Ticketmaster (digest garnish, not triggers). Skipped: Amazon price-watch (Associates gating, PA-API deprecation) — renewal and price triggers are user-entered.

## 8. Privacy model

Privacy is the product story, enforced by architecture rather than policy text:

- **On-device reduction**: raw Focus status, location, HealthKit and calendar data never leave the phone; the app reduces them to five coarse states and four place classes. The server cannot leak what it never receives; its most sensitive stored fact is "commuting".
- **Expiry and explainability**: raw signals expire at 90 days; every trait shows its evidence and has a delete button; the consent ledger and per-user audit ring buffer make every app's reads inspectable on the profile page.
- **Push payload minimisation**: alert pushes carry story IDs only; content is fetched over TLS on wake, so APNs never carries story text tied to context.
- **Scope enforcement in the tool list**: a client without `state.coarse:read` cannot even see the context tools, let alone call them.
- **GDPR by construction**: one user's data lives in one Durable Object, so export and erasure are single-object operations.

## 9. Secrets and configuration policy

The v2 footgun — `wrangler deploy` wiping dashboard-set plain vars, which silently killed Refresh — becomes structurally impossible: **configuration is either committed `[vars]` in `wrangler.toml` or a Cloudflare secret; nothing is ever set in the dashboard.** Secrets are held canonically in **GitHub Actions secrets** (per project convention) and pushed to Cloudflare via `wrangler secret put` in the deploy workflow; the Worker **verifies its required config at boot** and fails loudly, not silently. Integrations stay dormant-until-secret (the v2 pattern that made mid-setup deploys always safe). Carried secrets: `INGEST_SECRET`, `ROUTINE_FIRE_URL/TOKEN`, `SESSION_SECRET` (rotation logs out all 90-day sessions — rotate deliberately), `ELEVENLABS_API_KEY`, `GUARDIAN_API_KEY`, `MUSICKIT_PRIVATE_KEY`, `APPLE_DOMAIN_ASSOCIATION`, plus the new Persona JWT secret.

## 10. Costs (20 users) — honest

| Item | /day | £/month |
|---|---|---|
| L1 research + dominant-cell L3 renders (Claude Code Routine, 3 fires) | subscription | £0 marginal |
| Tail L3 renders: remainder of ~140/day × (0.9k in / 0.4k out), Haiku 4.5 ($1/$5 per MTok), Batch API (−50%) | ≤ ~$0.21 | ≤ ~£5 |
| L4 transitions (optional): 60 tiny Haiku calls | ~$0.06 | ~£1.50 |
| Workers Paid plan (DOs, KV, D1, R2 within included quotas) | — | ~£4 |
| ElevenLabs audio: lazy per-cell, ~10–20 shared clips/day ≈ 200–600k chars/mo | — | **£20–£80 (dominant)** |
| Apple Developer (already held) | — | £6 amortised |

**Total ≈ £30–£95/month, of which audio is 70%+.** The band is wide because listening behaviour is the one genuinely unpredictable variable; it is bounded by, in order: the `AUDIO_PAUSED` kill switch on every spend path, per-cell caching at `(cell_hash, voice_id)`, lazy-only rendering, and the dominant-cell-only fallback mode. Moving dominant renders into the routine pushes the metered LLM line towards zero; marginal LLM cost per additional user at this scale is ~£0.25/month, trending to ~zero past N≈150 as the cell cache saturates.

**Runbook contingency:** if the Claude Code Routine (and its subscription billing) ever dies, the metered fallback is Sonnet doing L1 research at roughly **$1.30/day** — an acceptable degraded mode, documented so the 2 a.m. decision is pre-made.

## 11. Migration and coexistence

`desk.databased.business` stays untouched and live; v3 deploys to `wire.databased.business` as a new Worker sharing nothing at runtime.

**Must migrate (one-off script, run against production KV, then re-run at cut-over):**
- `profile:apple:<sub>` — desks enabled/custom, weights, notes, deskOrder, styles, window, show. The core user asset.
- `aname:apple:<sub>` — Apple sends the user's name **only on first authorisation**; unrecoverable if dropped.
- `seen:shared` / `seen:user:<uid>` — 6-day rolling records; skipping them means a week of repeat stories on day one. These seed the new `read_ledger`.

**Must carry (config and assets):** desk catalogue and personas (`CATS`, `CATALOGUE`), `VOICE_MAP` (account-specific ElevenLabs voice IDs), `SHOW_STYLES`/`WRITER_STYLES`, `briefing-prompt.md`, R2 evergreen beats and style previews (one-off paid renders), all secrets per §9. The Apple Services ID gains the new return URL — both domains valid simultaneously.

**Transition mechanics:** the routine dual-posts to both `/ingest` endpoints; users move by signing into the new domain (anon-profile linking preserved). **Retirement clock:** once v3 has run two clean weeks, `desk.databased.business` goes **read-only for 30 days, then dies** — a firm deprecation contract, not an open-ended "when stable".

**Dropped:** all TTL'd briefings, pitches, locks, throttle keys, pending/active markers, anonymous profiles never linked, R2 `podcast/`/`listen/`/`img/` (14-day lifecycle regenerates), and every `jackwire:*` localStorage key.

## 12. Ninety days, three phases

**Phase 1 — Server foundation (weeks 1–4).**
Monorepo; typed Worker skeleton with vitest, where the **first test suite is v2's audited silent-failure list** — dedup-key clamp mismatches (title 240 vs 160), the poll gate that meant Refresh never delivered, lock release-only-if-acquired semantics — written *before* feature code. NewsroomDO + ProfileDO with signals/traits tables and the decay alarm; Persona built and time-boxed inside week 2. KV migration script run against production data. Pipeline live: routine dual-posts L1 briefs and dominant-cell renders; Batch-API tail renderer; LLM-free L4 assembly; single rate-limit primitive replacing v2's throttle-key zoo; web reader at wire.databased.business; Web Push interrupts for Android/desktop.
*Acceptance criteria:* v2 regression suite green; web reader at full v2 parity (feed, settings, Sign in with Apple, audio playback); migrated profiles render correct personalised digests; Wire FM integrates against Persona as client two **in under a day** (else Persona folds back into the Wire worker); routine failure alarms visibly.

**Phase 2 — The butler (weeks 5–8).**
iOS app MVP on TestFlight: Sign in with Apple, digest view, APNs, on-device policy engine v1 (Focus boolean + EventKit busy + wake window), coarse-state reporting, server-owned read_ledger sync. Signals Worker ships in build order §7 (PlanIt → Open-Meteo → Octopus → Carbon Intensity → TfL); trigger→interrupt path end-to-end under the trust ladder.
*Acceptance criteria:* a priority-3 trigger reaches the phone as a timeSensitive notification inside 5 minutes when state is fresh and permissive, and appears in the next digest with a "why demoted" note when it isn't; "Share Focus Status" declined degrades to time-window heuristics without error; no interrupt ever fires while coarse state says meeting/asleep; every interrupt shows its *why* and honours "never again".

**Phase 3 — Ambient and audio (weeks 9–12).**
Live Activity edition surface and widget; AlarmKit wake-up edition; Focus Filters intent; lazy audio cells + separate greeting clips with client-side `AVQueuePlayer` stitching; Shortcuts automation import; Persona audit dashboard; v2 cut-over, read-only period starts.
*Acceptance criteria:* audio plays with correct pitch/duration on cold and warm cache (fixture test on the stitching path); ElevenLabs month-to-date spend visible and kill switch verified in production; Live Activity updates within budget on a score day; v2 read-only with zero data-loss reports; total monthly spend inside the §10 band.

## 13. Horizon (post-90-days, explicitly not now)

- **Cross-domain clients**: the meal-planner and the FM DJ as Persona clients three and four, each proving the scoped-JWT model (`diet.traits:read` structurally blind to location) and feeding taste signals back.
- **Social/relational layer**: shared sagas ("you and Tom both follow this trial"), household digests deduped across two profiles, "read this so you can talk to your dad about it" prompts — all pure L4 assembly over existing cells, so marginal cost is zero; the hard problem is consent UX between profiles, which the ledger already models.
- **Later swaps**: Darwin Push Port if commute triggers earn it; Met Office DataHub; Vectorize if brute-force cosine ever feels slow; App Store release only if the audience outgrows TestFlight.

## 14. Risks (top three, honest)

1. **Solo-dev surface area.** Swift + TypeScript + five pollers is a lot for one person; the iOS app could stall half-built. Mitigation: the server ships first and is client-complete; the app MVP is deliberately tiny; the web reader and Web Push mean a stalled app costs interruption quality, never the news.
2. **Context sensing under-delivers.** Users decline Always-location or Share Focus Status; HealthKit sleep lags minutes-to-hours; silent push is budgeted and force-quit apps get none. Mitigation: every policy degrades to time-window heuristics; the trust ladder means stale state demotes rather than misfires; interruption quality is a ladder, not a cliff, and the digest tier catches everything, labelled.
3. **Audio economics.** ElevenLabs is metered, capped, and 70%+ of spend; one listening-heavy month blows the band. Mitigation: kill switch wired to every spend path, lazy rendering, per-cell sharing, no in-Worker MP3 surgery, dominant-cell-only fallback — and the honest position that if audio stays dominant at higher N, the fix is a pricing conversation, not more caching.

---

## Appendix A — Reuse-maths model

Users are sparse vectors over D=30 desks, following k=12 each (f = 0.4); C cells per story; desk popularity Zipf-like (α≈1, results insensitive over [0.8, 1.2]). Cell-request probability per user q = f/C. Distinct renders for N users, S stories: **R(N) = S·C·(1 − (1−q)^N)**; marginal user cost ΔR = S·f·(1−q)^N; marginal hit rate 1 − (1−q)^N.

| N | Hit rate (C=12, q=0.033) | Note |
|---|---|---|
| 20 | ~49% | user 21 needs ~8 fresh renders of ~16 items |
| 68 | 90% | crossover where the cache starts earning |
| 136 | 99% | renders cap at S·C = 480/day |
| 100,000 | ~99.97% | reuse factor ≈ 3,300× vs naive |

Occupancy correction: at N=20, ~2 tones × 2 pitches occupied → C_eff ≈ 4, hit rate 1−(0.9)²⁰ = 88% on occupied cells, ~3.5 renders/story. Worked example (40 stories/day, 20 users): naive = 320 renders, ~1.6M input tokens; layered uniform = ~236 renders, ~410k; layered realistic = ~140 renders, ~330k. Render-count saving only ~2×, but token saving 4–5× because the 5k-token source read happens once per story and renders read the 900-token brief. Eager-render where N·q ≥ 1; lazy otherwise. Audio caches at `(rendering_hash, voice_id)` with identical maths.

## Appendix B — Apple context API verdicts (audit, July 2026; baseline iOS 26)

| Capability | API / gate | What you get | Verdict |
|---|---|---|---|
| Focus status | `INFocusStatusCenter` + Communication Notifications checkbox | single boolean `isFocused`, never the Focus name; user must enable Share Focus Status | Amber |
| Focus semantics | `SetFocusFilterIntent` (Focus Filters) | user wires values per Focus; `perform()` fires on switch, even backgrounded | Green |
| timeSensitive level | capability checkbox, no approval | breaks Focus/summary; revocable per-app | Green |
| Critical alerts | manual Apple approval | safety/health only — a briefing app will be refused | **Red** |
| AlarmKit (iOS 26) | alarm framing | wake-up edition breaks Silent/Focus legitimately | Amber-green |
| Live Activities | ActivityKit + push type | ambient non-interrupting surface; frequent-updates flag; 8 h limit | Green |
| WidgetKit | budgeted | 40–70 refreshes/day; ambient only | Green (ambient) |
| Silent push | `content-available:1` | ~2–3 wakes/hr, deprioritised for unused apps, none if force-quit | Amber |
| Calendar busy | EventKit full access | compute free/busy yourself | Green |
| Location | `CLMonitor` (≤20 conditions), significant-change, `CLVisit` | background wakes, relaunches terminated app | Green |
| Sleep | HealthKit `sleepAnalysis` + background delivery | sessions written after the fact; Sleep Focus boolean is the better live proxy | Amber |
| Workout | HealthKit; live sessions watchOS-only | minutes of lag without a watch app | Amber |
| In-call | `CXCallObserver` | system-wide call state, only while app alive | Amber |
| Screen Time export | DeviceActivity/FamilyControls | network-sandboxed tokens; 4–8 week application | **Red** |
| SensorKit | research entitlement + IRB | not for consumer apps | **Red** |
| Shortcuts automations | per-Focus/arrive/leave triggers, Run Immediately | leaks Focus *names* via background POST; user-assembled, fragile | Green as power-feature |
| BGAppRefresh | system-scheduled | ~30 s, cadence usage-dependent, approaches zero for ignored apps | Backstop only |
| PWA on iOS | web push 16.4+ | visible banners only; no Focus, levels, background sync, geofencing, Live Activities | Ceiling — why native |

## Appendix C — UK signal-source catalogue (verified July 2026)

| Source | Gives | Auth/cost | Poll cadence | Fit |
|---|---|---|---|---|
| PlanIt | planning applications, 420 authorities, radius+date queries | free (polite) | daily | "planning app 250 m from home" — build first |
| Open-Meteo | hourly forecasts (UKMO/ECMWF), no key | free 10k/day | hourly | frost/washing-line/rain triggers |
| Octopus Energy | Agile half-hourly rates, no auth for prices | free | 1×/day ~16:05 | cheap-electricity window |
| Carbon Intensity (NESO) | GB + 14 regions, 96 h forecast | free, no key | 30 min | "grid is green" |
| TfL Unified API | line status, arrivals, disruptions | free key, 500 req/min | minutes | London commute |
| NR Knowledgebase/Disruptions (RDM) | route disruptions, REST | free via RDM | 5–10 min | non-London "is my line broken" |
| National Rail Darwin (RDM) | real-time running via Kafka/STOMP | free | push | phase two — heaviest integration |
| National Highways | DATEX II incidents, closures | free key | ~5 min | "M6 shut" (strategic roads only) |
| BODS | England bus live/disruptions | free key | ~10 s capable | deferred (XML volume) |
| UKBinCollectionData | 300+ council bin days, scraped | self-hosted | daily | deferred (scraper maintenance) |
| Met Office DataHub | official forecasts | free 360/day | poll | later swap for Open-Meteo |
| Skiddle / Ticketmaster | UK gigs / major tours | free keys | daily | digest garnish, deferred |
| NHS Service Search | pharmacy/GP hours | free key (v1/v2 deprecated Feb 2026) | weekly | "late pharmacy open now" |
| Overpass / Historic England / National Trust | POIs, listed buildings, open land | free | quarterly bulk | outing content |
| Eventbrite / Amazon PA-API | discovery removed / Associates-gated, deprecated May 2026 | — | — | skip; renewals user-entered |

## Appendix D — v2 keep/kill lessons

**Keep:** the Routine as research engine on subscription with `briefing-prompt.md` as the editorial contract; desks-as-single-model with per-user weights/notes/styles; salience as a 1-byte int; belt-and-braces cross-day dedup (canonical URLs, Jaccard backstop, saga-aware framing, recency gate); render locks with release-only-if-acquired semantics; the `AUDIO_PAUSED` kill switch; Sign in with Apple via JWKS-verified `form_post`; content-addressed R2 keyed by script hash + render version; dormant-until-secret integrations; prewarm awaited in the ingest handler, not `ctx.waitUntil`.

**Kill:** the 2,170-line untyped worker with zero tests — 19 bugs found only by adversarial review, three of which (poll gate, lock-deletion double-billing, clamp mismatch breaking dedup keys) become v3's first regression tests; in-Worker MP3 byte surgery (Xing and pitch-shift bugs) → client-side playlist stitching; localStorage-only state and client-side seen heuristics → the server-owned `read_ledger`; the KV clobber-merge feed → NewsroomDO single writer; the throttle-key zoo → one rate-limit primitive; dashboard vars wiped on deploy → §9 config policy; the implicit "generating" state machine → explicit build-status rows.

**Data that must survive:** `profile:apple:<sub>`, `aname:apple:<sub>` (unrecoverable), `seen:*`; desk catalogue, `VOICE_MAP`, `briefing-prompt.md`, R2 evergreen assets, all secrets. Everything else is TTL'd or regenerable.
