# The Wire — v2 Plan

> ## Status — 2026-07-02 sprint close
>
> This document is a **point-in-time snapshot of 1 July 2026**, written against the
> pre-fix code; the inline `worker.js:…` / `index.html:…` line links no longer point
> at the code they describe, and the "Where the app stands" bugs below are fixed.
> Where the sprint stands:
>
> - **Phase 0 — complete, except the prompt-injection hardening** (item 16: the fire
>   text is flattened/clamped, but `/api/ingest` still accepts any `userId` with the
>   secret rather than binding it to the issued fire). Smaller leftovers: item 15
>   (`/api/listen` key still includes `itemId`, no render lock), item 18 (cron KV
>   list unpaginated / fires the same first ≤8 profiles in key order), and parts of
>   items 5 and 19 (Range only on `/api/podcast/episode`, no ID3/Xing stripping, no
>   beat tombstone, per-request `touchActive`, clamp mismatch, `urlDateSec` boundary).
> - **Phase 1 — shipped**, with different mechanics than specified: style packs are
>   **register-only** (`scriptDirection` in the fire text; same cast, no per-pack
>   Voice-Design cast), previews live at `GET /api/style-preview?s=<id>` keyed
>   `previews/<id>-v1.mp3` (manual version bump, not defHash), and the public shared
>   `/feed.xml` shipped — per-user tokenised private feeds, Apple/Spotify submission,
>   and the "voices are AI-generated" disclosure did not.
> - **Phase 2 — largely shipped**: images (Guardian → og:image → R2 → `/api/img`),
>   thumbnail cards, salience ranking, cross-outlet dedup (prompt rule + Jaccard
>   backstop), freshness window, refresh clarity, reader tip, mark-all-read. Still
>   open: the **training deck** (first-visit + train-on-old-news), `/api/event`
>   engagement counters, BBC RSS/Microlink image fallbacks, the YouTube facade, the
>   serif reading face, and embeddings dedup.
> - **Phase 3 — in progress**: the MusicKit token endpoint is live and the key is
>   confirmed; **radio mode ("Wire FM") is being built now** (experimental toggle,
>   off by default); Alexa Flash Briefing not started.

*From a full code review (multi-agent, every finding adversarially verified against the code) plus research into music-app integration, image sourcing, and podcast speaker styles — 1 July 2026.*

## Where the app stands

The architecture is genuinely good: routine-generated content on the subscription instead of the metered API, KV-cached feeds, content-addressed R2 audio, Apple-gated personalisation, saga-aware dedup. The weaknesses are concentrated in three places: **podcast delivery reliability** (locking/retry/rollover bugs), **the refresh loop** (the client never actually picks up a rebuilt feed), and **cost guards** (several unauthenticated or unthrottled spend paths).

---

## The ideas list — status and solution for each

- [x] **Podcast generator fix** → Four verified bugs cause the flaky behaviour; fix list in Phase 0 below. The headline ones: the render lock is deleted by callers that never acquired it ([worker.js:948](../src/worker.js#L948)), and the player retries ~10–15s against a ~40s render ([index.html:910](../public/index.html#L910)) so first plays die with "Couldn't load the episode".
- [x] **User-selectable podcast audio type with example audio** → "Style packs" (Phase 1). Verified: ElevenLabs Text-to-Dialogue has *no* per-turn style params — the levers are per-request `stability`, v3 audio tags, script register, and swapping in a different Voice-Design cast per pack. Render one ~15s preview per style once, cache in R2, play next to each choice.
- [ ] **Swipe to train it on old news** → Training deck (Phase 2). Serve a calibration deck from the daily snapshots already kept 5 days in KV (`briefing:<date>`); swipes feed the existing weights without marking anything read.
- [x] **Change news selection (desks)** → Already shipped (onboarding picker, settings toggles, custom desks, reorder). Two bugs undermine it: desk changes never deliver the rebuilt feed (poll gate, [index.html:485](../public/index.html#L485)) and the signed-out picker sells desks that can never produce content ([index.html:662](../public/index.html#L662)). Fix both in Phase 0 and this is done.
- [x] **Select writer type** → Per-desk "writer" presets (Phase 2): a small set of registers (Brief & factual / Colour writer / Analyst / Tabloid punch) stored on the profile and injected into the desk prompt exactly like `notes` already is. The plumbing (notes → prompt) exists; this is a UI + preset copy job.
- [x] *(part (a) shipped; (b) `/api/event` still open)* **Prioritise by international engagement then user engagement** → No engagement data exists server-side. Two-step (Phase 2): (a) have the routine stamp each item with a 1–5 `salience` ("front-page-ness" across outlets — it can see this during research); rank by salience first, learned weights second. (b) later, aggregate real engagement via a tiny `/api/event` endpoint + KV counters.
- [ ] **Reader tip / font / "one and done" / first-visit training deck** → Phase 2: cut the tip to one line, make it a swipeable card (the machinery exists), fold it into a 2–3 card first-visit training deck (swipe-to-tune, reader tip, podcast intro). Add a serif reading face (e.g. Literata/Source Serif) for summaries.
- [x] *(images shipped — Guardian → og:image → R2; BBC RSS/Microlink fallbacks and the video facade still open)* **Add images and videos** → Verified pipeline (Phase 2): source-aware, at ingest — Guardian Content API `fields.thumbnail` (free tier confirmed live to include images), BBC RSS `media:thumbnail` (confirmed live), else og:image via `HTMLRewriter` with browser-ish headers (~60–85% hit rate), Microlink free tier as fallback; cache bytes to R2, serve from `/api/img/:id`. **Don't hotlink** (rot, signed URLs) and don't use `/cdn-cgi/image` URL transforms (needs per-origin allowlists). Video: YouTube only — oEmbed thumbnail facade, `youtube-nocookie.com` iframe on tap. Keep thumbnails preview-sized + attributed (no UK personal-use copyright exception; publisher-supplied images are the clean path).
- [x] **Streamline the card (photo, iMessage-style)** → Phase 2, lands with images: thumbnail left like a Messages link preview, one metadata row, "why" stays as the inline expander.
- [x] *((a)+(b) shipped; embeddings upgrade open)* **Assess duplication of stories (same story, different outlet)** → Current dedup is exact URL/title only, so cross-outlet repeats slip. Phase 2: (a) routine instruction to pick ONE outlet per story cluster; (b) server-side near-dup backstop at ingest — normalised-title token overlap (Jaccard ≥ ~0.6) within desk+day; (c) optional upgrade: Workers AI embeddings (`bge-small`) cosine similarity.
- [x] **Clarity around 15-min refresh** → The server already returns `throttled`/`retryInSec`; surface it properly (Phase 0/2): countdown on the Refresh button ("New pull in ~12m"), "Updated 13:02 · next pull ~18:00" line, and actually deliver the refreshed feed (poll fix).
- [x] **"Set all articles above to read"** → Phase 2, small: a "Mark all read" action per filter (and/or below the fold) adding visible ids to the existing read/dismissed stores.
- [x] *(shipped as the 4 named show styles)* **Podcast variety of speakers (Whiley vs Laverne vs Moyles; Shearer/Neville/Richards)** → Same feature as audio-type selection: 3–4 named ORIGINAL show styles. Legal/policy verified: register emulation is fine; real names may appear ONLY in the Claude script-direction prompt — never in UI copy, ElevenLabs voice descriptions, or spoken text (ElevenLabs impersonation policy + UK passing-off). Suggested packs: **The Wake-Up** (zoo-radio breakfast, stability ~0.2, `[excited]`/`[laughs]`), **The Green Room** (warm evening magazine, 0.5, `[warm]`/`[thoughtful]`), **Full Time** (football panel, ~0.3, quick volleys), **The Briefing** (current default).
- [ ] *(public `/feed.xml` + MusicKit token endpoint shipped; radio-mode UI in progress; private feeds/Alexa open)* **Link to music apps, news every 30 min** → Verified: **no API on Spotify or Apple Music can inject audio into the user's native-app stream.** Do instead (Phase 3): (1) **Podcast RSS feed** — one Worker route over the R2 episodes you already render; public shared feed (submit to Apple Podcasts/Spotify) + per-user tokenised private feeds with `itunes:block` (add via "Follow a Show by URL"/Overcast; Spotify can't add private feeds). (2) **Radio mode** page via **MusicKit JS** (needs £79/yr Apple Developer Program; user is the Apple Music subscriber): play their music in-page, pause on a timer, play the bulletin, resume — Safari-reliable. Spotify Connect pause/resume works but Development Mode caps at 5 allowlisted users forever — personal hack only. Optional afternoon job: Alexa Flash Briefing JSON feed (still supported). Skip Google (Assistant sunsets ~March 2026).

---

## Phase 0 — Fix pass (verified bugs, do before any features)

### Podcast reliability bundle (= "podcast generator fix")
1. **Lock deletion bug** ([worker.js:948](../src/worker.js#L948)) — `finally` deletes `podcast:lock:*` even when this caller only *observed* the lock (early return at :943) or failed. A cold GET during the ingest prewarm destroys the renderer's lock → duplicate paid renders; failed renders never back off. Fix: `let acquired = false` after the KV put; delete only if acquired (and consider keeping the lock on failure + a short-TTL `podcast:fail:<key>` tombstone).
2. **Player retry budget** ([index.html:910](../public/index.html#L910)) — 2 retries × 5s vs a ~40s render. Fix: on 503, poll `?meta=1` until `ready` (up to ~90s) before re-requesting audio.
3. **Date-rollover carry-over** ([worker.js:1050](../src/worker.js#L1050)) — `existing.podcast` is kept with no date gate (items are gated at :1033). Yesterday's episode serves as "today" and re-renders at full cost under today's key. Fix: `existing.date === londonDate()` gate; add `stale` to `?meta=1`.
4. **Personalised prewarm** ([worker.js:1486](../src/worker.js#L1486)) — drop the `!uid` gate so personalised ingests prewarm too (the routine POST absorbs the latency); first listener currently eats the whole cold render.
5. Smaller: pack dialogue chunks on exchange boundaries (don't split host-question/desk-answer, [worker.js:886](../src/worker.js#L886)); honour `Range` on audio endpoints (R2 supports ranged reads) and strip mid-stream ID3/Xing headers for sane duration/seek; cache-bust the episode URL with the meta `key` (fixed URL + `max-age=3600` replays stale episodes); beat failures need a negative-cache tombstone ([worker.js:863](../src/worker.js#L863)); reuse ONE `Audio` element across playlist tracks so iOS keeps the gesture blessing.

### Refresh actually delivering (root of the "15-min refresh" confusion)
6. **Poll gate** ([index.html:485](../public/index.html#L485)) — `isBuilding` requires an *empty* feed, so after Refresh or a desk change the app never refetches; and a fresh personalised feed returns no `generating` flag at all. Fix: poll while `generating` regardless of item count AND until `generatedAt` changes from the pre-refresh value; make the lock-expiry timer call `load(false)`.
7. **Throttled regenerate swallowed** ([worker.js:1510](../src/worker.js#L1510)) — a desk edit inside the 15-min window is dropped silently; store a `pending-rebuild:<uid>` flag that `/api/today` honours.

### Onboarding & profile integrity
8. **Signed-out picker trap** ([index.html:662](../public/index.html#L662)) — signed-out users can pick only custom desks → all builtins disabled → permanently empty feed. Gate non-builtin picks behind sign-in (same toast as `addCustomDesk`), show the Apple button in setup, and refuse a setup that disables everything buildable.
9. **Re-onboarding destroys notes/deskOrder** ([index.html:669](../public/index.html#L669)) — `profileCustomised()` ignores them; `finishSetup` replaces the profile. Include notes/deskOrder in the check; merge, don't replace.
10. `getUid` unguarded `localStorage.getItem` ([index.html:223](../public/index.html#L223)) → blank page where storage throws. Wrap it.
11. Timer re-renders wipe open panels/half-typed notes ([index.html:503](../public/index.html#L503)); stale category filter after disabling the filtered desk; poll-cap leaves permanent skeletons; the two audio players play over each other ([index.html:876](../public/index.html#L876)).

### Cost & abuse guards
12. **Daily fire budget** — unauth `POST /api/refresh` can fire the shared routine 96×/day against a 5–15/day run cap ([worker.js:1434](../src/worker.js#L1434)); and if the fire config ever drifts, it falls through to an unthrottled *metered* build per request (:1444). Add a KV daily counter (e.g. 20/day) + a KV min-interval on the metered fallback; return "refresh unavailable" instead of falling through in routine mode.
13. **Catalogue pitch fill** ([worker.js:1116](../src/worker.js#L1116)) — unauthenticated; failures aren't negative-cached and concurrent hits each schedule fills (location desks mint a fresh billed pitch per novel geo). Tombstone failures (1–2h TTL), KV lock around `fillPitches`, skip location-desk fills or cache per coarse region.
14. **Desk-preview throttle** ([worker.js:1310](../src/worker.js#L1310)) — signed-in but unlimited metered web-search calls. Per-uid min interval + small daily quota; cache by normalised topic.
15. **`/api/listen` key** ([worker.js:1339](../src/worker.js#L1339)) — drop `itemId` from the R2 key (`listen/<voiceId>/<sha16(text)>.mp3` is fully content-addressed) + short KV lock against parallel cold renders.
16. **Prompt injection** ([worker.js:761](../src/worker.js#L761)) — desk notes/topics flow as prose into the privileged routine's instructions; `safe()` strips quotes/newlines only. Move reader text into a fenced, explicitly-untrusted data block, and have `/api/ingest` reject a POST whose `userId` differs from the uid the fire was issued for.
17. **URL scheme allowlist** — `item.url` is rendered as `<a href>` with no scheme check ([worker.js:977](../src/worker.js#L977), [index.html:722](../public/index.html#L722)); modern browsers block `javascript:` under `noreferrer`, but enforce http(s) server-side anyway.
18. **Cron fairness/scale** ([worker.js:1561](../src/worker.js#L1561)) — KV `list` never paginates (silent cutoff at 1000 profiles) and the routine loop fires the same first ≤8 users in key order every run (throttled attempts also consume the cap). Cursor loop + rotate the start point + count only real fires.
19. Housekeeping: R2 lifecycle rule on `podcast/` + `listen/` (~7–14 days, keep `beats/`) — already prescribed in AUDIO_ARCHITECTURE.md, never applied; coalesce `touchActive` writes (skip if stamped <1h); consistent title/URL clamps between `normalizeIngest` and `recordSeen` (240/600 vs 160/400 breaks long-headline dedup keys); tighten `urlDateSec`'s year-month regex (numeric IDs like `/2025-04567` parse as dates and the recency gate drops current stories).

## Phase 1 — Podcast v2 (style packs, previews, RSS)

- **Style packs**: `{styleId, stability, tagPalette, scriptDirection, cast}` — 4 packs as above. One-time Voice-Design setup per pack (generic descriptions, fixed seeds; 12 voices fits Creator's 30 slots; a few dollars once). Routine reads the user's `styleId` from the fire text; render passes the pack's stability/cast into the existing dialogue call.
- **Previews**: one ~350-char, 2–3-turn dialogue snippet per style through the *production* path, cached `previews/<styleId>-<defHash>.mp3` (immutable), `GET /api/style-previews/<id>`; picker UI with a ▶ per style. Don't use Flash for previews (no tags, single voice — misrepresents the product).
- **Hygiene**: "voices are AI-generated" disclosure near the player; real-presenter register anchors live only in the Claude prompt.
- **RSS feed**: `/feed.xml` over existing R2 episodes (RSS 2.0 + enclosures + artwork). Public shared feed → Apple Podcasts Connect + Spotify for Creators; per-user tokenised private feeds with `itunes:block`.

## Phase 2 — Feed v2 (images, cards, ranking, dedup, reading UX)

- Image pipeline at ingest (Guardian API → BBC RSS → og:image → Microlink → logo tile), R2-cached, `/api/img/:id`; YouTube-only video facade. Card redesign with thumbnail.
- `salience` field from the routine; rank salience → learned weights → recency. Later: `/api/event` + KV counters for real engagement.
- Cross-outlet dedup: routine clustering instruction + Jaccard title backstop at ingest (embeddings later).
- Mark-all-read; refresh countdown + "updated/next pull" copy; first-visit training deck (swipe-to-tune card, one-line reader tip, podcast card); serif reading face; "train on old news" deck from KV snapshots.

## Phase 3 — Reach

- Radio mode (MusicKit JS; £79/yr Apple Developer Program; Safari-first). Spotify pause/resume as a personal-only hack (5-user Dev Mode cap).
- Alexa Flash Briefing feed (one small JSON route).

## Suggested order

Phase 0 items 1–7 are one focused day and fix the two things users actually feel (podcast flakiness, refresh doing nothing). Items 8–19 are a second day. Phase 1 before Phase 2: it's the most differentiating feature and mostly configuration + one setup script. Phase 2 as appetite allows; Phase 3 opportunistic.
