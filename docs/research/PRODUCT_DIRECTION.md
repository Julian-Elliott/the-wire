# The Wire — Product Direction for the Next Phase

*A decision-complete memo for Julian, sole builder. Pressure-tested against the as-built v3, eleven persona reactions, eight strategy lenses, and an adversarial verification pass. Where the verifier refuted a claim, this memo corrects it and says so.*

---

## 1. The verdict

The vision coheres — but only after you separate the two things it fuses. The strong, true core is: **a calm, ad-free, all-chosen personal-news reader that splits what you go looking for (want-to-know) from what has the right to interrupt you (need-to-know), seeded by a single act of intent rather than a wall of tabs.** That core is not aspirational; you have already built most of its machinery. The ranked feed, the per-user follow/weight/pitch model, the priority tiers, the interrupt gate with its trust-ladder, the embeddings, the consent ledger and single-object erasure — these are the hard parts, and they exist. The next phase is mostly *wiring and honest framing* of primitives you own, not a new product.

Where it is strongest is exactly where your own instincts and the personas converge: an edition that **ends** (Nadia, Brenda, Denise, Hannah, and you all named this independently), a search-to-follow onboarding that respects "all chosen" without a blank screen, and a need-to-know tier that only ever pings when something genuinely hits *this* user's stakes.

The single riskiest bet in the vision — and it is not close — is **cross-platform surfacing: "raise posts you'll like on Instagram, Facebook, Snapchat."** Verification is unambiguous: this is not a hard build, it is a *disallowed* one. There is no sanctioned API on any of the three that returns a user's incoming feed to a third party; the read paths are dead (Instagram Basic Display ended 4 December 2024), scraping a logged-in feed breaches ToS and courts CFAA exposure, and even a user's right to run a tool on *their own* feed is legally contested (the Knight Institute's Zuckerman v. Meta suit over Unfollow Everything 2.0 was in fact *dismissed* in November 2024, so that right was never even vindicated). Nine of eleven personas actively named this feature as noise or repellent — including the three it was aimed at (Kev, Maya, Meera). Kill it as specified. Section 5 gives you the defensible remnant.

Read the rest of this memo as: build the calm all-chosen reader with a real need/want split and an edition that ends; refuse the social-scraping fantasy; and hold the line on everything the evidence killed.

---

## 2. The onboarding answer

**Pure zero-defaults is the right *principle* and the wrong *implementation*.** Julian wants two things that appear to fight — "there should NOT be any default news topics, they should all be chosen" and "we don't want it to be laborious to set up." They only fight if you read "no defaults" as "a blank search box is the front door." Read it instead as "no *silent* defaults; every follow is a user's own act," and the contradiction dissolves.

Start with the correction the verifier confirmed against your own code: **you have silent defaults right now.** `getFollows()` in `profile.ts` lazy-seeds a new read from the migrated v2 `desks.enabled` list at weight 1 each. For migrated users that is legitimate — it is their prior choice carried over. But it means the "all chosen" contract is currently violated for anyone seeded that way, and the fix is a few lines: a genuinely new user gets **no follows until they act**, the migration seed applies only to existing v2 users, and the picker becomes the seeding event.

The onboarding-psychology lens is decisive on *what that act should be*, and it is backed by confirmed evidence: query formulation is the single highest-cognitive-load phase of search (Gwizdka, JASIST 2010), so a search box as the *only* door demands the hardest mental act — recalling and articulating a specific interest — in the first fifteen seconds, before the user even understands what the product does. Recognition beats recall; every mature news app opens with a tap-the-topics grid, not a blank box. Empty first states drive abandonment; pre-populated interest-pick screens drive activation (the confirmed Pinterest pattern). And at ~20 users you have *zero* collaborative signal to lean on — MIND-class rankers train on ~1M users / 24M clicks, four to five orders of magnitude beyond you — so the cold start *must* be an explicit user act. The only question is tap versus type, and the evidence says lead with the tap.

The personas make this concrete and non-negotiable:

- **Brenda (74, quietly defeated by setup):** "If screen one is instead a blank box asking 'what do you want to follow?', I'm gone before I start." She wants to tap *one* starter pack — "Around me", "Days out", "Weather & bills" — and have it fill.
- **Nadia (deleted every news app for her nerves):** "starter packs (opt-in) rescue my blank-screen freeze without sneaking defaults back in." The chip-tab wall "is literally what spikes me."
- **Hannah (90-second windows, frazzled parent):** search-as-sole-door is "risky as the only front door (blank-page problem)"; a one-tap "The Parent" pack "is what saves me."

So the recommended first-run flow, which is a ~3–4 day build reusing `setFollow`/`getFollows`/`setPitch` verbatim:

**One screen.** Headline: *"What do you actually want to know about?"* Roughly twelve plain-English desk tiles (Local news, Cost of living, UK politics, Tech, Football/[sport], Science, Weather & travel, Money, World, Culture, Health, Environment), each with a one-line "you'll get…" preview. Instruction: *"Tap 3 to start — you can change everything later."* Soft minimum of three, no maximum. **Beside the grid, not instead of it, a search box:** *"Looking for something specific? Search it"* — this is idea 3, the search-to-desk centrepiece, present as a *second* path for the minority who arrive with intent, resolving a result into "Follow this as a desk." And an **escape hatch**: *"Not sure? Start with the popular set"* → seeds a transparently *labelled* starter feed the user actively chose (a recommended feed, idea 9 — opt-in and named, therefore not a silent default).

Screen two, deferrable and skippable: a single town/postcode field for local news, asked only if they tapped Local.

This honours "all chosen" (nothing enters the feed the user didn't tap or type or explicitly pick), satisfies "not laborious" (three taps, ~15 seconds, recognition not recall), and gives you the IKEA-effect ownership without the empty-screen bounce. Search-to-seed is the fast-follow, not the gate.

---

## 3. The want-to-know / need-to-know model — the spine of the phase

Treat this seriously, because it is the organising idea of the next phase and because — verified against your own code — **it is already latent in the schema.** The one conceptual correction that makes it work: **need-to-know is not a label you stamp on a story. It is a property of the *pair* (story, user).** "Base rate rises 0.5%" is need-to-know for a tracker-mortgage holder and want-to-know trivia for a renter. Classify stories globally and you are wrong for half your twenty users. Kev is the sharpest proof: your instinct files civic/work/local as need-to-know, but *for him urgency lives on the want side* — a "here we go" transfer or an injury an hour before kickoff is the most time-critical thing in his week, and the model as drafted defines his one pingable event as unpingable. The lesson generalises: the split is per-user, computed at read time, never a fixed taxonomy.

**What already exists (verifier-confirmed against `newsroom.ts`, `signals/types.ts`, `profile.ts`):** three separate axes the vision conflates into one. `salience` (0–100, global importance), `priority` (1|2|3, delivery tier), and a per-user `audience` scoping column already used for planning-near-home. And `isInterruptible` in `profile.ts` *is already the need-to-know gate*: only priority-3 interrupts; only when coarse state is fresh (<30 min) and permissive (`open`/`commuting`); `meeting`/`asleep`/unknown/`workout` demote to digest or silent. "Push when not in focus" is built. It simply has one real p3 source today — WeatherKit severe weather.

One honesty note the verifier flagged: today `salience` is a deterministic function of `priority` (p3→90, p2→55, p1→30), so the three columns are physically separate but not yet carrying independent information. That is fine — it means the axis is *there to use*, not that it is already doing work.

So the taxonomy maps onto existing code with almost no new concepts:

| | Want-to-know | Need-to-know |
|---|---|---|
| Driver | affinity vector × desk follow | your **stakes scope** intersects the story |
| Delivery | ranked **pull** feed, always available | priority elevated → interrupt **gate** → push |
| Mechanism | `rank.ts` (built) | entity/audience match → `isInterruptible` (built) |
| Failure mode | mild irrelevance (cheap) | notification fatigue / broken trust (expensive) |

**The build** is a weekend-to-a-week of backend, not a subsystem: store 2–3 explicit stakes scopes per user in ProfileDO (mirroring `setHomeArea`), add one `impact-class` field to the routine's `briefing-prompt.md` (`{money, travel, local, employer-sector, safety, general}` — a prompt edit, no deploy), and add a per-user `stakesBump(story)` term to `rank.ts` and `routeInterrupts` that elevates priority when a story's entities/impact-class intersect the user's scope. The elevated priority hits the *unchanged* gate, still subject to the two-source rule and the daily cap (`checkDailyCap` already exists).

**How scope is set — split by axis, and this is the crux:**

- **Want-to-know → derive it.** Low friction, being wrong is harmless. The affinity vectors and follow-picker already do this.
- **Need-to-know → explicit, and that is correct, not lazy.** You must never *guess* someone's employer and then interrupt them on the guess — a wrong inference plus a push is the worst outcome you can ship. So need-to-know scope is a short explicit form:
  - **Employer** — one text field → entity, confirmed at entry (the idea-5 echo), resolved once, never inferred from behaviour.
  - **Home area** — *already stored* via `setHomeArea` (town-level, rounded ~110 m, never coordinates). Reuse verbatim. Derek and Brenda both demand town-string, not coordinates; you already do the right thing.
  - **Money commitments** — a tiny checkbox set (tracker mortgage, energy tariff, a named holding). Octopus Agile already proves the money-stakes pattern.

Priya (security engineer) draws the line you must hold: the split "only works if employer/local relevance is computed on-device or from a coarse tag I volunteer — deriving it means the server holds the person-to-employer-to-location linkage I'm trained never to hand over." Explicit-and-visible scope is not just safer, it is the thing that makes her install at all.

**Do not build a health stakes scope.** This is a hard legal no-go, verifier-CONFIRMED. Under UK/EU GDPR Article 9, health data *inferred from behaviour* is still special-category data (CJEU C-252/21 Meta v Bundeskartellamt is directly on behavioural signals; C-21/23 Lindenapotheke holds intent is irrelevant). Deriving "has diabetes" from reading patterns to push health news lands you inside Article 9 and needs explicit, specific consent — a disproportionate compliance burden at friends-and-family scale with no upside. Treat health as an *interest desk you follow*, never a stored or inferred condition.

The reason to be conservative is evidence, not timidity (verifier-CONFIRMED against Reuters DNR 2025): ~40% now avoid news (up from 29% in 2017); 79% receive no weekly alerts, and 43% of those actively switched them off over volume and irrelevance. A false need-to-know push is the single most expensive mistake in the product. Keep the two-source rule on any elevated p3, keep "held to digest with a why" as the default, and keep the daily cap.

**One refinement the personas force:** the binary is too crude at the timing edge. Meera's events are "want-to-know by topic but need-to-know by timing" — a free National Trust day this Sunday is gentle, non-urgent, but must *reach her before Saturday*. Kev's rumour is want-to-know by topic but minutes-critical. The model needs a third, quiet delivery mode between "silent pull" and "interrupt": an **ambient, non-interrupting nudge** (a digest-tier push or email, no trust-ladder gate) for perishable want-to-know. You already have digest-tier triggers (Octopus, Carbon, PlanIt); this is the same rail applied to a deadline chip.

---

## 4. Every idea, ruled on

Effort: **S** ≈ ≤2 days, **M** ≈ 3–5 days, **L** ≈ 1–2 weeks, **XL** ≈ multi-week/infeasible.

| # | Idea | Ruling | One-line why (persona + strategy grounded) | Effort |
|---|------|--------|---------------------------------------------|--------|
| 3+ | **Search-to-desk** (the centrepiece) | **BUILD NOW** — as two tiers, not "live search" | Instant free retrieval over already-embedded D1 corpus (bge-m3, ~$0), plus deferred "make it a desk" the routine researches; Denise/Priya/Maya all want declared-intent onboarding. Reject any *synchronous* metered "research now" as default. | M |
| 4 | Simpler feed UI — kill the tabs | **BUILD NOW** | Every persona from Kev to Brenda named the chip-tab wall as the bounce point; one stream + chips, zero server change, you called them overwhelming yourself. | S |
| 2 | Catch-up / "easy news" with an **end state** | **BUILD NOW** | A feed that *ends* is the one lever that changes Nadia, Brenda, Denise, Hannah *and* you; LLM-free, rides existing salience. The Explain/reading-age-8 pitch stays opt-in, never default (Kev: an insult). | S |
| 1 | "No-AI mode" | **BUILD NOW — reframed** | Literal "no AI" is incoherent (AI ranks and curates). Ship *source-first presentation* + a universal neutral provenance badge; Marion/Brenda/Nadia/Denise want the byline and the link, not a lie. Kill the phrase "no AI" in UI. | S |
| 5 | Entity correctness ("Messi"→"Lionel Messi") | **BUILD NOW — write-time only** | A confirmation echo at interest creation, resolving to a Wikidata QID stored on the interest. Brenda/Denise love the echo; Kev wants it *silent* when unambiguous. **No live infra** (Nadia/Hannah/Maya/Derek all call that over-engineering). | S |
| 12 | "When, where" | **BUILD NOW** | A field on the routine's output contract, not an entity system; near-free, essential to events/local (Derek: "'a planning meeting' is noise, '7pm Thursday, the Guildhall' is usable"). | S |
| 6 | Local news via civic-API agent search | **BUILD NOW** (audience-scoped) | Highest-delight idea for Derek/Brenda/Hannah; already half-built via PlanIt/signals. Civic APIs + honest "no coverage here", never a synthetic scraped paper. Must be shared/audience-scoped or flat-cost breaks (your own caveat). | M |
| 13 | Scorecard vs v2 / competitors | **BUILD NOW** | You can't build on vibes solo; ~80% exists (`wire_engagement`). Add a survey event + manual quarterly bake-off. Invisible to users, essential to you. | S |
| 9 | Recommended feeds / starter packs | **BUILD NOW** (packs) / **LATER** (behavioural) | Hand-curated opt-in packs rescue Brenda/Nadia/Hannah/Meera's blank screen; content-based "because you follow X", never collaborative (no signal at N=20), never a silent default. Behavioural nudges: opt-in, weekly, legible — later. | S / M |
| 10 | Events / open days / heritage | **BUILD LATER** — free/civic half only | The *wedge* for Maya/Meera/Hannah/Derek; Skiddle (free API) + Heritage Open Days + council what's-on. **REJECT** the commercial deals/sales/offers half outright — it converts a trusted feed into ad inventory and breaks the non-commercial legal footing. A maintenance treadmill (dead links, stale dates), so sequence it deliberately. | L |
| 11 | Rename to "Ivy" | **REJECT "Ivy"; rename anyway** | "The Wire" collides in-category with thewire.in (a live news publisher) — weak, undefendable mark. But "Ivy" carries knockout risk (IVYNETWORK, same Nice class) and reads generic; Kev: "sounds like a candle shop." Rename to a distinctive non-attention word. Cheap now at 20 users. | S |
| 7 | Video / images | **REJECT hosting; thumbnails only** | Rights, R2 cost, a11y liability all point one way; Nadia/Denise/Derek/Meera reject video, and it fights the calm/cheap soul. **But** Maya is right that a pure wall of text links "looks broken" — show hotlinked OG thumbnails with text fallback. Never host. | S |
| 8 | Cross-platform surfacing (IG/FB/Snap) | **REJECT as specified; build share-IN** | Infeasible and disallowed (see §5); 9/11 personas call it noise or creep, *including the three it targets*. Keep only the outbound email digest + a user-initiated "Send to The Wire" share target. | S (share-in) |

---

## 5. The honest no-gos

**Cross-platform social surfacing (idea 8) — infeasible and disallowed as specified.** This is the seductive centre of your own vision and it has to go. The verifier confirmed every wall: Instagram Basic Display API reached end-of-life 4 December 2024; the surviving Graph API serves only professional accounts and exposes *no endpoint* for a personal home feed or friends' posts. Snap deprecated its Login Kit SDKs and `fetchUserData`, leaving OAuth2 for identity only — Snap states plainly that Login Kit "does not provide access to personal user data such as private messages, shared content or contacts." Facebook has had no personal-feed read API since 2015. Scraping a logged-in feed breaches ToS and invites CFAA exposure; Meta sues extension makers who do it. And the *most* defensible framing — a user-installed extension re-ranking their *own* feed — is legally contested, not settled: the Knight Institute's Zuckerman v. Meta suit over exactly this was **dismissed in November 2024**, so the right was never vindicated. Your own `SOURCE_STRATEGIES.md` already reached this conclusion for hyperlocal groups and sanctioned only share-sheet forwarding as an unverified signal.

The defensible remnant is worth building: a **"Send to The Wire" share target** (native iOS/Android share sheet + a desktop bookmarklet). The user sees a post they like anywhere, taps Share → The Wire; you extract the entities and offer "Follow this as a desk?" Zero API, zero ToS breach, zero scraping — the user hands you the content. It satisfies the real intent ("if you find a topic you like, follow it here") and maps 1:1 onto the follow-picker. Log idea 8 as *rejected-with-reason* so it stops resurfacing. Revisit only if EU DSA interoperability rules ever mandate an export API.

**Live entity infrastructure (idea 5) — over-engineering; solve at write time.** The problem is real but the surface is tiny. It bites in exactly one place — a user typing an interest — and it is a once-per-interest write event, not a live path. The routine's own prose already emits canonical names (LLMs do this natively); topic-to-story matching already runs on embeddings, which don't care about case. Nadia, Hannah, Maya and Derek independently call standing live-collection infra over-engineering "I'd never notice." So: resolve the typed string once, echo it back when ambiguous ("Following Lionel Messi, the footballer — not the 2014 film. Right?"), resolve silently when unambiguous (Kev's demand), store the QID, done.

**One correction the verifier forced, and it matters for how you build this:** the claim that Wikidata's `wbsearchentities` allows ~100 req/s anonymously is **REFUTED**. The real 2026 limit is ~10 req/min for IP-only callers (200/min with a compliant User-Agent), and these limits are *new and deliberately restrictive*. Two consequences: (1) send a proper User-Agent with contact info; (2) a Cloudflare Worker's outbound IP is *shared across tenants*, so you can be rate-limited by other tenants' traffic regardless of your own volume. **Mitigation: cache resolved QIDs in KV/D1** (they're stable), call the API only on cache-miss. Your own volume from 20 users stays far under any limit, so the feature remains viable — but build the cache from day one, don't hit the API per search.

**"Immune to typos" — PLAUSIBLE-but-overstated; add a lexical fallback.** The search-to-desk lens implied bge-m3 cosine matching is typo-proof. It isn't. Dense embeddings give *semantic* fuzziness (synonyms, paraphrase), not *orthographic* robustness — and proper nouns are the weakest case, because a misspelt rare name tokenises into unfamiliar subwords. Your own `cluster.ts` already pairs cosine with a token-overlap guard precisely because cosine alone was insufficient for entity precision. So the search path needs a cheap lexical companion (BM25/trigram/normalised token match) alongside the embedding, not cosine alone. This is the same "cosine + token gate" pattern you already ship, extended to search.

**The £0.25/user/month figure — misattributed; don't quote it for bespoke desks.** The verifier caught this: £0.25 is the marginal *render-cache* cost per extra user, and it only holds *because users share desks and cache cells*. A bespoke per-user search-desk is occupied by one user with zero cache reuse — the blueprint itself names custom desks as the thing that re-inflates costs. On your Claude subscription it is "£0 marginal" but **capacity-bound, not cost-free**: unbounded per-user bespoke research × 3 fires/day is limited by your Claude Max weekly active-hour caps. Practical implication: cluster near-duplicate interests (cosine on interest embeddings, so "Messi" and "Lionel Messi" share one research pass), and if you ever ship a synchronous "research now" button, gate it behind sign-in, a per-user daily cap, and AI Gateway spend limits — treat it as a paid feature, never free-and-public. A public unbounded search box is a metered-bill DoS surface.

**Video hosting — reject; commercial deals — reject.** Covered in the table; the reasoning is rights, cost, a11y, and the trust frame. The one concession: hotlinked OG thumbnails (Maya's "looks broken" point is valid), never hosted media.

---

## 6. Naming

**Rename off "The Wire". Reject "Ivy". Do it now, in the next phase, while it's a 20-user subdomain and the switch is a config-plus-copy pass.**

"The Wire" is the worst kind of name for a *news* product because the collision is in-category: thewire.in is a live, prominent Indian reader-funded news publisher — your exact product class — sitting on top of the HBO show, *Wired*, and *Business Wire*. "Wire" in news is descriptive (it *is* the wire-service metaphor), so the mark is weak, effectively undefendable, and the SEO namespace is unwinnable. Fine for a private build; a liability the moment freemium implies growth.

"Ivy" is not the escape. The namespace is crowded — IVYNETWORK is a downloadable social/networking app in the same Nice class (9/42) a news app files in, so it carries genuine trademark knockout risk — and it reads generic (League schools, houseplants) with no calm-news signal. The personas are brutal and unanimous that it doesn't help: Kev ("candle shop"), Marion (a cosy first name "launders AI authorship into trust it hasn't earned — name the product, never the author"), and everyone else ranks it as bikeshedding. Marion's point is the deepest one and it should constrain the choice: **do not give the AI a human first name.** "Ivy told me Salah's fit" is precisely the false-trust move source-first is meant to prevent.

A calm personal-news brand should avoid the attention lexicon entirely — no *Wire, Buzz, Alert, Breaking, Pulse, Feed*. Aim for a short, ownable, slightly-unusual real word signalling *knowing/quiet range*. Shortlist worth a 30-minute free UK IPO + USPTO knockout search before committing: **Ken** (Scots/English "range of knowledge or sight" — "beyond my ken"; calm, brandable, near-empty in news), **Lede** (the journalist's word for the top of a story; on-domain, insider-credible; downside is niche recognition), or **Margin/Marginalia** (reading in the margins; distinctive, but watch the finance sense). Whatever you pick, it names the *product*, not a butler voice. This is a Wave-B decision, not a Wave-C one — every week you wait, the switching cost and the SEO hole grow.

---

## 7. Scorecard

You cannot instrument Apple or Google News, so don't pretend to. Build two honest instruments on top of what exists (`wire_engagement`, `/api/dev/scorecard`, `read_ledger`).

**Invert the engagement metrics.** For a calm product that ends, *fewer sessions and fewer interrupts are wins* — the opposite of every mainstream analytics default. Track four honest measures: **relevance** (read-to-served, already have it), **time-to-value** (taps to first relevant story — a new `first_relevant_story` event), **need-to-know hit rate** (survey, below), and **calm** (interrupts/day and the `interrupt_never_again` rate — lower is better). Nadia's warning is the design constraint: "don't let DAU/days-active metrics read my calm low usage as churn and try to re-hook me." A product whose success looks like disengagement in a standard dashboard needs its own scorecard or it will lie to you.

**Two additions:**

1. **A weekly one-tap micro-survey** (`survey_response` event): rotate one question — "Did we surface something you needed to know this week? (yes / no / missed it)" and "Calmer or busier than your other news app?" This is the *only* credible read on need-to-know hit rate and on calm; neither falls out of clicks.
2. **A quarterly manual bake-off**, a spreadsheet not a pipeline: pick five known-important stories that broke that quarter (a local-planning decision, a severe-weather warning) and, for the same five users, log which app surfaced each first and correctly — you vs Apple News vs Google News vs their RSS reader.

Report counts beside rates always. At 20 users a single bad week isn't a trend, and lying denominators are the failure mode. This is the discipline that lets you, solo, tell a real improvement from noise.

---

## 8. The sequenced roadmap

Sequenced for a solo builder on a £5/mo stack, ordered by delight-per-line and by unblocking dependency, and reconciled with what is already live.

**Wave A — the calm all-chosen reader (this month, all LLM-free or near-zero marginal cost).** These are the highest-leverage, lowest-risk builds and they mostly rewire primitives you own.
1. **The edition that ends** (Catch-up, capped ~7, explicit "you're done"). Your own one-thing and four personas' one-thing. Rides existing salience, no LLM. Ship first.
2. **Kill the tabs** — one stream + chips. Zero server change, removes the universal bounce point.
3. **Explicit first-run picker** ("tap 3", search box beside it, labelled popular-set escape hatch) and **rip out the silent v2 lazy-seed for new users.** Honours "all chosen".
4. **Source-first presentation + universal provenance badge.** Cheapest credibility you'll buy; the neutral line becomes a routine output field.
5. **Search-to-desk, instant tier** — query-embed + cosine over D1, *plus a lexical fallback for typos/proper nouns*, write the interest even on zero hits. Defer any synchronous "research now."
6. **Write-time entity echo** with cached Wikidata QIDs (User-Agent set, KV cache, resolve-silently-when-unambiguous).
7. **Scorecard additions** (`survey_response`, `first_relevant_story`, inverted calm metrics).

**Wave B — the need/want spine + local + naming.**
8. **Want/need as a per-user relation:** stakes scope in ProfileDO (employer/home/money, *no health*), `impact-class` in the routine prompt, `stakesBump` in `rank.ts` and `routeInterrupts`, feeding the unchanged gate. Add the **ambient nudge tier** for perishable want-to-know (Meera/Kev).
9. **Local-by-civic-API search**, audience-scoped, honest "no coverage here", town-string not coordinates.
10. **The rename** (and the knockout search) — before any audience or paid tier grows.
11. **Starter packs** (hand-curated, opt-in) and content-based recommended feeds ("because you follow X", never collaborative, never auto-followed).

**Wave C — events, share-in, and the fragile-but-valuable.**
12. **"Out & About" desk** (free/civic only — Skiddle + Heritage Open Days), want-to-know, never interrupt-tier, with T-24h re-verification. The Maya/Meera/Hannah wedge, but a maintenance treadmill — build eyes-open.
13. **Share-IN target** (the defensible remnant of idea 8).
14. Freemium plumbing (a tier flag + Stripe) only when a second genuinely compute-heavy feature ships. Principle, non-negotiable: **charge for compute, never for calm, never for need-to-know safety.** A weather warning behind a paywall would kill the premise.

**Two honest sequencing tensions to hold in view.** First, several personas' *one thing* — Hannah's morning-orientation glance, Meera's "near me this weekend" card, Derek's verified patch — depend on local + events, which land in Waves B–C, i.e. *last*. That is the right call for a solo builder (they are the highest-maintenance surfaces), but be clear-eyed that the people they'd win are waiting longest. Second, Denise's and Kev's *one thing* (a personal audio edition; an honestly-labelled rumour lane) are genuinely out of the current phase — audio-personalisation is iOS-gated and the rumour lane structurally fights your two-source rule. Name them as deliberately deferred, not forgotten.

**The single highest-leverage next build: the edition that ends.** It is the one lever that measurably changes *your own* behaviour and four independent personas', it is LLM-free and in reach this month, it costs nothing to run, and no mainstream news app offers it. The trustworthy need-to-know interrupt is the bigger long-term moat, but it is iOS-gated and fragile; the finite, self-announcing edition is the habit you can actually ship now — and it is the truest expression of what makes The Wire different from the doomscroll it's meant to replace.
