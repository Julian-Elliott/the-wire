# The Wire v3, the ideas list, planned (July 2026)

> ## Status, 2026-07-07
>
> This document plans the July ideas list into the v3 programme. It is
> subordinate to [V3_BLUEPRINT.md](V3_BLUEPRINT.md): nothing here changes the
> blueprint's architecture, its 90-day phases, or the "Next up, in order"
> queue (first dual-post edition, Persona tool surface, first trigger through
> the interrupt gate, v3-native routine prompt, cut-over clock). Everything
> below is the **consumer track**: web-reader and routine-side work that can
> proceed in the gaps around the butler's critical path, sized so a solo dev
> can interleave it. Items land in three waves (A, B, C) pegged to the
> blueprint's Phase 2, Phase 3, and Horizon.

The governing constraint, restated from the brainstorm: every idea must ride
the routine-plus-cache architecture. Anything that demands per-user live LLM
calls at read time fights the thing that makes The Wire fast and cheap, and
gets redesigned until it doesn't.

---

## The ideas list, verdict and mechanism for each

- [ ] **No-AI-content mode (human-written articles)** → Build as
  **source-first presentation**, Wave A. v3 already validates pinned URLs at
  ingest and stores `sources[]` on every L1 story, so the mode is a render
  path, not a pipeline: a reader setting `presentation: wire | sources` that
  suppresses the L3 cell and renders headline, one neutral factual line from
  the L1 brief, outlet name, and the link-out. No full-text mirroring
  (rights); the pitch is "AI found it, humans wrote it, you read it at the
  source". Ship the routine's planned output badge in the UI at the same
  time so AI-written copy is labelled everywhere, which is the half of this
  feature that builds trust even for readers who never flip the toggle.
  Effort S (one setting, one card variant, badge plumbing).

- [ ] **Consumption modes: easy news vs news you probably needed to know** →
  Ride **ranked L4 assembly** (blueprint Phase 1 leftover), Wave A. Salience
  0-100 already exists on every story. Two modes at assembly time:
  **Catch-up** (default: top salience across the reader's interests, capped
  around 7, explicit "you're done" end state) and **Graze** (the full
  stream). "Needed to know" is not a third tab: it is one pinned
  fibre slot per edition, chosen by salience-times-consequence against the
  reader's audience tags, with the "why this matters to you" line the
  Editorial Read declaration already carries. One slot is a feature; a tab
  of vegetables is homework. Effort M (assembly policy + two UI states).

- [ ] **Search-one-thing onboarding (the extension pattern)** → Build, Wave
  A, the flagship of this track. Landing surface becomes one search box:
  "What do you want to follow?" The answer runs through step-0 **entity
  resolution** (already in the blueprint's routine-prompt plan) and echoes
  the canonical reading back for confirmation, then writes an interest to
  ProfileDO. Instant gratification without a live build: embed the query and
  brute-force-cosine it against the story embeddings already sitting in D1,
  so the reader sees what the newsroom already knows about the topic in
  seconds, with "your wire starts watching this now" framing. The next
  routine fire researches it properly and the first notification closes the
  loop ("Ivy found 3 new stories about the thing you asked for"). The aha
  moment is the product doing the second search for you tomorrow. Effort M
  (first-run screen, query-embed endpoint, confirm step; the heavy parts
  exist).

- [ ] **Simpler feed UI (tabs are overwhelming)** → Build, Wave A. v3's "no
  general edition, every article personalised" philosophy already implies
  this: **one stream, interests become chips**, a manage sheet behind an
  edit button, tabs deleted. Catch-up mode needs the single stream anyway,
  so these land together. Desk/interest reorder survives inside the manage
  sheet. Effort M (web reader restructure; no server change).

- [ ] **Correctness of user-typed content (Messi is Lionel Messi)** → Solve
  at write time, Wave A; **no live infrastructure**. Two layers: the entity
  resolution + confirmation echo above at interest-creation and
  message-a-desk time ("Following **Lionel Messi**, the footballer, not the
  2014 film. Right?"), and the canonical entity id (Wikidata QID) stored on
  the interest so every later research prompt uses the resolved name rather
  than the typo. Wikidata's free search API is the non-LLM fallback. Live
  in-story entity linking (tap a name, get a who-is-this card) is Horizon,
  and only if reading data says people dwell on names. Effort S.

- [ ] **Local news via agent search + location** → Build, Wave B, on the
  signals Worker's coat-tails. The reader types a town (or the iOS app
  offers its coarse `place_class` home town); an interest "Local: {place}"
  is created with a town-level string, never coordinates, matching the
  privacy model. The routine gets a local-sourcing skill (BBC Local, local
  papers, council feeds, hyperlocal blogs; PlanIt planning applications are
  already polled). **Local stories are audience-scoped and shared**: every
  reader in Worcester shares one research pass, which keeps routine cost
  flat as local adoption grows. That shared-cache property is the design
  centre, decide it first. Effort M-L (routine skill + interest template;
  scoping already landed).

- [ ] **Events, offers, open days (National Trust days, family days)** →
  Build, Wave B-C, as a **content shape, not a desk voice**. Event items
  carry structured `when / where / cost / booking link` (this is the "When,
  where" bullet, treated as schema). Routine gets an events skill that only
  emits future-dated items; dedupe by (name, venue, date), not saga; the
  reader renders a distinct event card with a date chip and add-to-calendar
  (EventKit on iOS, ICS link on web). Pairs with the local interest: "free
  things to do near you this weekend" is the killer query. Clearly-labelled
  promoted events are the least-icky monetisation surface this product
  could ever have, and are **explicitly not now**: ship unmonetised, revisit
  post-cut-over. Effort L (schema + skill + card + calendar plumbing).

- [ ] **Videos and images** → Images: keep the verdict already shipped
  (publisher thumbnail, og:image, R2, same-origin serve); remaining work is
  coverage fallbacks (BBC RSS, Microlink) already tracked in V2_PLAN. Video:
  **no native video, reaffirmed**. Where a story is inherently visual the
  routine may attach one official YouTube link, rendered as the oEmbed
  thumbnail facade with a `youtube-nocookie.com` iframe on tap (the V2_PLAN
  design, unchanged). Native video fights the calm, cached, cheap soul of
  the product. Effort S when it comes up; not scheduled as its own item.

- [ ] **Inter-platform delivery** → Mostly already planned; sequence it.
  **Email digest first** (Wave A-B: the relay domain is registered, Email
  Sending is inside the included 3,000/month, and the digest is a render of
  an edition that already exists). Then the podcast RSS promoted harder
  in-app (exists), then Alexa Flash Briefing as the afternoon job it always
  was (Wave C). WhatsApp/Telegram bots go to Horizon: each is a new surface
  with its own failure modes, and email plus push plus RSS covers the
  channels the first twenty users actually named. Effort S (email) because
  the artifacts are cached; everything consumes the same edition JSON.

- [ ] **Recommended feeds** → Build, Wave B, two tiers. **Editorial starter
  packs** first (The Commuter, The Parent, The Match-Goer: hand-curated
  bundles on the onboarding and manage screens; pure content work). Then
  **behavioural suggestions** from the preference-vector compass that just
  landed: read/swipe clusters inside a broad interest suggest a dedicated
  one ("You keep reading EV-charging stories inside Markets. Want a desk for
  it?"), computed weekly in the ProfileDO decay alarm, never live. Effort S
  then M.

- [ ] **Ivy, the name** → Decide in Wave B, act in Wave C. v3 is literally
  "Newsroom & Butler": the butler earns a name the moment the product
  speaks, interrupts, and answers a search box. Middle path that de-risks a
  rebrand: **The Wire stays the product; Ivy names the butler** (narrator
  voice, interrupt author, search persona: "Ask Ivy to follow this"). If
  users start saying "Ivy told me", revisit naming the whole product.
  Pre-decision checks: UK trademark classes 9/38/41, App Store search
  collision (The Ivy restaurant group, Ivy the salon brand), domain and
  handle availability, and whether the podcast feed survives a title change
  without losing followers. Effort S (decision + copy), plus the check list.

- [ ] **When, where** → Absorbed above: as **event schema fields** (the
  events item) and as **delivery context** (the blueprint's coarse states
  and wake windows already carry when-and-where for interrupts; edition
  framing by time of day rides the existing three-a-day cadence). No
  separate build.

- [ ] **Scorecard vs the current platform** → Build **first**, Wave A,
  before any feature above ships. v2 is explicitly the living lab, so the
  comparison is clean: same readers, two products. Definition in the next
  section. Effort S (event names + counters + one dashboard page under
  /dev).

---

## The scorecard

v3 already owns the hard part: the server-side `read_ledger` gives
delivered/seen/read/dismissed per story without client heroics, and the
Analytics Engine spend dataset established the pattern. Add a
`wire_engagement` dataset with a small fixed event vocabulary, written from
the Worker (web) and the iOS app:

`edition_opened`, `edition_finished` (Catch-up end state reached),
`story_read`, `story_dismissed`, `linkout_opened` (source-first mode's
currency), `readout_played`, `episode_completed`, `interrupt_accepted`,
`interrupt_never_again`, `search_onboard_started`, `search_onboard_confirmed`,
`digest_email_opened`, `recommendation_accepted`.

**The spine, per product (v2 lab vs v3):**

- Reach: DAU/WAU, installs, notification and email opt-ins
- Habit: editions opened per day, days-active per week, Catch-up completion
  rate
- Depth: read-to-served ratio, link-outs, listen-through
- Respect (the v3 bet): interrupt precision (accepted vs never-again),
  demotion agreement (reader opens a demoted story from the digest rather
  than complaining it was late)
- Quality: dupe reports, correction rate, entity-confirmation decline rate
- Efficiency: routine fires per reader-day, LLM spend per WAU, cache hit
  rate

**Protocol:** two weeks of v2 baseline (it is live and un-paused), then each
Wave A feature launches with one named primary metric: single-stream UI owns
Catch-up completion; search onboarding owns D7 retention of search-onboarded
readers vs picker-onboarded; source-first mode owns link-out rate among its
adopters; the email digest owns days-active per week. A feature that cannot
name its primary metric before shipping goes back to the drawing board.

---

## Waves, pegged to the blueprint

**Wave A, alongside blueprint Phase 2 (the butler weeks).** Web-reader and
assembly work only, no iOS dependency: scorecard events + /dev dashboard
page; single-stream UI with interest chips; ranked L4 assembly carrying
Catch-up/Graze and the fibre slot; search-one-thing onboarding with entity
confirmation (needs the Persona tool surface, already next in the queue);
source-first mode + AI badge; email digest.

**Wave B, alongside blueprint Phase 3.** Local interest template + routine
local-sourcing skill (shared, audience-scoped); editorial starter packs,
then compass-driven suggestions; the Ivy decision with its check list;
events schema groundwork (fields on the story contract, card design).

**Wave C, post-cut-over (Horizon adjacent).** Events skill end-to-end with
calendar actions; Alexa Flash Briefing; Ivy rollout in voice and copy if the
Wave B decision says yes; YouTube facade when a desk genuinely needs it;
promoted-events monetisation question formally revisited, with the no-ads
principle as the null hypothesis.

**Explicitly deferred:** WhatsApp/Telegram delivery, live in-story entity
linking, native video, any read-time per-user LLM call.

---

## Risks, honest

1. **Track discipline.** The butler's critical path (first live edition,
   interrupt gate, cut-over) is the programme; the consumer track is the
   slack. If a week forces a choice, the butler wins, and Wave A slips
   without ceremony.
2. **Search onboarding writes to ProfileDO before the Persona tool surface
   has a second client.** Sequence it after the tool surface lands (it is
   already next in the queue), or the interest-creation path gets built
   twice.
3. **Local's economics depend on sharing.** If local interests are built
   per-user instead of audience-scoped, routine cost scales with towns times
   readers and the flat-cost story breaks. The scoping decision is the
   feature.
4. **The scorecard can lie early.** Twenty readers make small denominators;
   report counts alongside rates, and resist redesigning on one bad week.
