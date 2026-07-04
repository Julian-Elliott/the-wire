# Source Strategies — how The Wire learns about the world, and what it borrows to do it better

*Research note, July 2026. Inputs: a 23-repo survey across six clusters, two academic reviews, and a full adversarial verification pass (12/12 CONFIRMED, 0 refuted — Appendix). Every adopted strategy lands in a named V3_BLUEPRINT.md component and build phase.*

---

## 1. Secrets policy

The standing rule (V3_BLUEPRINT §9) is restated and unchanged: **all API secrets live canonically in GitHub Actions secrets and are pushed to Cloudflare via `wrangler secret put` in the deploy workflow; public-safe configuration is committed `[vars]` in `wrangler.toml`; nothing is ever set in the dashboard; the Worker verifies its required config at boot and fails loudly.** Integrations stay dormant-until-secret. This review adds **zero new secrets**: every adopted strategy is either a pattern reimplemented in our own code, a keyless free-tier fetch path (r.jina.ai reader, Reddit public JSON, PlanIt, Open-Meteo, Carbon Intensity), or tooling that runs locally on the routine machine (chrome-devtools-mcp launches local Chrome; the Codex plugin authenticates via ChatGPT login — neither touches the repo's secret set). If a keyed fallback source is ever adopted later, its key follows the same GitHub-Actions-canonical path.

## 2. Academic review — the limits of learning about local events, news and sources

### 2.1 The supply problem: news deserts and the demand gap

Medill's [State of Local News 2025](https://localnewsinitiative.northwestern.edu/projects/state-of-local-news/2025/) counts 213 US news-desert counties and ~50 million Americans with one or zero local sources. The UK analogue is thinner but real: the [Media Reform Coalition](https://committees.parliament.uk/writtenevidence/107640/html/) estimates 2.5m Britons live in districts with no local newspaper and ~9m more with only one; Barclay et al.'s seven-area study ([*Journalism*, 2025](https://journals.sagepub.com/doi/10.1177/14648849241272255)) shows what that means: councils unattended, courts unreported, residents defaulting to Facebook. And "having an outlet" is a weak proxy — a masthead can exist while producing near-zero original reporting.

The demand side is worse. The News Measures Research Project analysed 16,000+ stories across 100 US communities: only **17% were actually about the community**, 43% original, 56% addressing critical information needs, and 20 communities had *zero* local stories in the sample week (Napoli et al. — method in [*Journalism Practice*, 2017](https://www.tandfonline.com/doi/abs/10.1080/17512786.2016.1146625); headline figures from the project's 2018 "Assessing Local Journalism" report, per [Nieman Lab](https://www.niemanlab.org/2018/08/an-analysis-of-16000-stories-across-100-u-s-communities-finds-very-little-actual-local-news/)). The double truth: the categories residents actually want — planning, transport, energy, weather, civic notices, exactly the §7 catalogue — are the ones journalism has abandoned, so the opportunity is real; but the same absence means there is often **no textual substrate for the routine to find**. The locality problem is supply, not summarisation.

### 2.2 What extraction gets wrong

Structured event extraction remains hard: the [TextEE re-evaluation](https://arxiv.org/pdf/2311.09562) (Huang et al., ACL Findings 2024) found inconsistent evaluation had inflated prior claims, and the [Alan Turing Institute's 2025 review](https://www.turing.ac.uk/sites/default/files/2025-07/arc_event_extraction_lit_review.pdf) confirms exact-match scoring undervalues semantically correct output. For local calendar events the known failure modes are: recurring-vs-one-off confusion, silent cancellations (pages go stale, not corrected), cross-posted listings defeating dedup, and venue geo-ambiguity — gazetteers under-cover POIs ([Hu et al., *LRE*, 2024](https://dl.acm.org/doi/10.1007/s10579-024-09730-2)); "The Red Lion" resolves to dozens of UK pubs. The interrupt tier is the highest-stakes surface for exactly these errors.

### 2.3 UK council data fragmentation

England has 300+ principal councils with no mandated machine-readable schemas for the data residents most want: the LGA/esd [open-data schemas](https://schemas.opendata.esd.org.uk/) are voluntary and patchily adopted; the transparency code mandates only spend-type datasets. Planning is the exception that proves the rule: portals are dominated by two scrape-hostile vendors (Idox, Northgate), and normalisation happens outside government — PlanIt aggregates ~400 portals into one API, which is why the blueprint leans on it. Consequence: for bin days, notices and licensing, per-council adapters or agentic scraping are unavoidable, and any one adapter rots when a council re-platforms.

### 2.4 The closing web

The Data Provenance Initiative's [Consent in Crisis](https://arxiv.org/pdf/2407.14933) (Longpre et al., 2024; 14,000-domain audit) measured a single year in which robots.txt restrictions came to cover ~5%+ of all C4 tokens and **28%+ of the most actively maintained head sources** — disproportionately news; [BuzzStream (2025)](https://www.buzzstream.com/blog/publishers-block-ai-study/) finds ~79% of top news sites now block AI bots. Cloudflare is the enforcement layer: ["Content Independence Day"](https://blog.cloudflare.com/content-independence-day-no-ai-crawl-without-compensation/) (July 2025) made AI-crawler blocking the default with pay-per-crawl (HTTP 402 as a price signal), extended in [July 2026](https://techcrunch.com/2026/07/01/cloudflares-new-policy-pushes-ai-companies-to-pay-for-publishers-content/) to mixed-use crawlers on ad-carrying pages — and The Wire is *hosted* on Cloudflare while its routine researches the web those defaults are closing. The 2023 API enclosure closed the social firehose (Twitter enterprise-priced, Reddit at [$12k per 50M calls](https://www.forbes.com/sites/barrycollins/2023/06/01/death-by-api-reddit-joins-twitter-in-pricing-out-apps/), [CrowdTangle shut August 2024](https://www.niemanlab.org/2024/03/a-window-into-facebook-closes-as-meta-sets-a-date-to-shut-down-crowdtangle/)); Nextdoor has no public read API. What remains genuinely open: the RSS long tail, [GDELT](https://www.gdeltproject.org/data.html) as a discovery (not reading) layer, and the OGL-licensed UK civic APIs the signals Worker already targets.

### 2.5 The UK legal frame for a 20-user, non-commercial, briefs-and-links-out app

**CDPA s.29A** permits copies for computational analysis of lawfully accessed works "for the sole purpose of research for a non-commercial purpose" and voids contract terms preventing it — but grants no right to communicate the copies onward; the IPO's broader TDM exception was [withdrawn in February 2023](https://www.hsfkramer.com/notes/ip/2023-03/uk-withdraws-plans-for-broader-text-and-data-mining-tdm-copyright-and-database-right-exception/). For EU publishers, **DSM Art 15** expressly excludes "private or non-commercial uses... by individual users", hyperlinking, and "very short extracts" — precisely The Wire's brief-plus-link pattern; Art 4 TDM requires honouring machine-readable opt-outs; the UK database right separately protects curated feeds. The 20-user posture helps: facts are not copyright; short original summaries linking out sit largely outside these rights; s.29A plausibly covers the ephemeral analysis copies. It does not change: ToS breach is contract, not copyright; scale reduces exposure, not legality; and the non-commercial footing evaporates the day the app charges anyone. Operationally: identify honestly (Anthropic's documented `Claude-User` UA), never spoof a browser, treat 402/403 as an answer, never circumvent a paywall, prefer sources that affirmatively publish feeds.

### 2.6 LLM research reliability

The Tow Center's [March 2025 study](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php) (8 tools, 1,600 queries) found collectively **>60% incorrect** citation answers, fabricated URLs, and premium tiers *more* confidently wrong. NewsGuard's [one-year audit](https://www.newsguardtech.com/press/newsguard-one-year-ai-audit-progress-report-finds-that-ai-models-spread-falsehoods-in-the-news-35-of-the-time/) found false-claim repetition rose 18%→35% as refusal fell to zero — web grounding traded "I don't know" for confident laundering of polluted sources. The mitigations are cheap and belong server-side: pinned URLs with liveness checks, verbatim quote verification, a two-independent-source rule for anything that would interrupt a user. A hallucinated citation should be a *rejected* brief, not a delivered one.

### 2.7 Combined implications

| Limitation (literature) | Consequence for The Wire | Our mitigation |
|---|---|---|
| News deserts (Medill 2025; MRC; Barclay et al. 2025) | Routine returns wire-copy or nothing for some patches; "local" degrades to regional | Weight primary sources (PlanIt, TfL, Carbon Intensity, council pages) via signals Worker; briefs say honestly when coverage is absent |
| Only ~17% of "local" stories actually local (Napoli et al.) | Place-name retrieval over-collects pseudo-local content | Geo-filter at ingest in NewsroomDO; require resolvable geometry before the local tier |
| Event-extraction failures: recurrence, silent cancellation, dedup, geo-ambiguity (TextEE 2024; Turing 2025; Hu et al. 2024) | Wrong or stale event briefs erode trust fastest at the interrupt tier | Re-verify events T-24h; never interrupt-tier an unverified one-off; per-user venue gazetteer in ProfileDO, ask-once-cache-forever |
| Council data heterogeneity; voluntary schemas (LGA/esd) | Bin days/notices need per-council logic; adapters rot | Prefer normalisers (PlanIt); routine as self-healing scraper; doctor/fallback routing (4.1) |
| robots.txt blocking, Cloudflare 402/403, API enclosure | Top publishers and all social signal increasingly refused | Honest UA, robots respected, 402/403 final; RSS + GDELT for discovery; open UK civic APIs; share-sheet forwarding as the only hyperlocal-group channel, always marked unverified |
| s.29A non-commercial only; database right | No commercial pivot without relicensing; no bulk article-text storage | Ephemeral analysis copies; briefs-plus-links only; documented non-commercial posture |
| >60% AI citation error (Tow 2025; NewsGuard 2025) | Hallucinated provenance in briefs | Ingest-side URL liveness + quote checks; two-source rule for priority-3 |

The pattern across all seven: 2026 punishes anonymous bulk extraction and rewards small, honest, attributed, non-republishing readers. The Wire — briefs, links, 20 users, no training — is on the survivable side of that line, provided its agent behaves like a named guest, not a crawler.

## 3. Repo review — all 23 verdicts

| Repo | What it is | Verdict | One-line reason |
|---|---|---|---|
| Panniantong/Agent-Reach | Capability layer routing per-platform reading tools: ordered primary→fallback backends + `doctor` | **ADAPT** | Probe-and-fallback pattern maps onto our UK sources; reimplement, don't install |
| mvanhorn/last30days-skill | Recency-bounded multi-source research skill: entity resolution, cluster merging, output contract | **ADAPT** | Closest repo to our engine; steal three mechanisms, reject its social/API-key sprawl |
| mattpocock/skills | Engineering-discipline agent skills | NOT-RELEVANT | Targets building software with agents, not agentic news research |
| phuryn/pm-skills | 68 PM-framework skills | NOT-RELEVANT | Zero overlap with research, source reach or recency |
| Leonxlnx/taste-skill | Anti-slop frontend prompt framework: declared read → dials → gated rules | **ADAPT** | Wrong domain, right prompt architecture for Persona-driven briefs |
| chthollyphile/folia-major | Immersive lyrics-first music player | NOT-RELEVANT | Shares only the word "taste" with the cluster |
| asgeirtj/system_prompts_leaks | Archive of leaked production system prompts, with diffs | **ADAPT** | Best corpus of preference-application policy language; mine structure, never copy text |
| JuliusBrussee/caveman | Prompt/output compression skill (~46% input cut, code/URLs byte-preserved) | **ADAPT** | Compress mechanical prompt sections for headroom; keep the podcast voice |
| lfnovo/open-notebook | Self-hosted NotebookLM alternative: transformations, three-tier context, podcasts | **ADAPT** | Stack unusable on Workers; mental models fit render cells and Persona tiers exactly |
| DeusData/codebase-memory-mcp | C binary indexing code into a SQLite graph behind MCP tools | INSPIRATION | Token-economics framing for agent-facing tools; nothing runs in prod |
| allenai/olmocr | GPU-hosted VLM PDF-to-text with release-gating benchmark | INSPIRATION | Product incompatible with Workers and budget; the eval discipline transfers |
| harvard-edge/cs249r_book | ML-systems textbook monorepo | NOT-RELEVANT | Pedagogy, not a system pattern |
| alibaba/page-agent | In-page GUI automation, text-DOM serialisation, no screenshots | INSPIRATION | Wrong runtime; DOM-text-over-screenshots technique worth keeping |
| ChromeDevTools/chrome-devtools-mcp | Official Chrome MCP server, ~51 tools, uid text snapshots | **ADOPT** | Zero-marginal-cost JS-rendered scraping; solves the no-API-source gap |
| usestrix/strix | Autonomous AI pentesting platform | NOT-RELEVANT | Its browser exists to exploit, not extract; at most a one-off pre-launch errand |
| mukul975/Anthropic-Cybersecurity-Skills | 817 security skills in progressive-disclosure format | INSPIRATION | Zero domain overlap; the skill-frontmatter organisation validates our prompt refactor |
| iptv-org/iptv | Community IPTV playlists; repo-as-database, CI-built artefacts | INSPIRATION | Content useless; versioned-registry-in-repo pattern worth stealing |
| Starmel/OpenSuperWhisper | macOS local-Whisper dictation, hold-to-record | **ADAPT** | Right architecture for iOS voice input; code non-portable |
| Zackriya-Solutions/meetily | Local meeting transcriber/summariser | NOT-RELEVANT | No meeting use case; its one good pattern is generic |
| n0-computer/iroh | Rust p2p networking, content-addressed blobs | NOT-RELEVANT | No peer-to-peer edge; content addressing already committed |
| logto-io/logto | Self-hostable OIDC IdP with MCP positioning | INSPIRATION | IdP disproportionate at N=20; scoped-token model validates §4's existing design |
| apple/container | Linux containers as VMs on Apple silicon | NOT-RELEVANT | Zero container workloads in dev or prod |
| openai/codex-plugin-cc | Official Codex-in-Claude-Code plugin: reviews, adversarial reviews | **ADOPT** (dev workflow) | Cross-model adversarial review at zero cost; the solo dev's second pair of eyes |

The rejections are part of the record: eight clean NOT-RELEVANTs failed relevance, not verification — the cheaper failure to catch now.

## 4. Adopted strategies

All verifier-CONFIRMED (Appendix). Phases per V3_BLUEPRINT §12 (1: weeks 1–4; 2: weeks 5–8; 3: weeks 9–12; Horizon: §13). "Immediate" = applies to v2 today.

**4.1 Source doctor + ordered fallback routing** *(Agent-Reach)*. Every source gets an ordered primary→fallback fetch list, genuinely probed (not just "binary exists"), with the backend-in-use recorded in brief/trigger metadata. Lands: **signals Worker adapters (§7)** + a preflight step in **briefing-prompt.md**. Phase 2. Effort: ~1.5 days. Replaces silent-failure fetching.

**4.2 Factor briefing-prompt.md into a `skills/` directory of per-source playbooks** *(Agent-Reach's SKILL.md registry + the progressive-disclosure format demonstrated by Anthropic-Cybersecurity-Skills)*. Per-source procedures ("Lewisham portal: navigate → wait_for → extract selectors X") become skill files with ~30-token frontmatter, loaded only when that source is due. Lands: **routine repo**. Phase 1. Effort: 1–2 days. Replaces monolithic prompt bloat.

**4.3 Step-0 entity resolution** *(last30days-skill)*. Resolve each user's interests into concrete sources (PlanIt areas, local outlets, feeds) *before* any fetch fires. Lands: **briefing-prompt.md** Phase 1; becomes a **ProfileDO policy the routine queries** in Phase 2. Effort: half a day, then ~1 day.

**4.4 Cross-source cluster merging + per-source cap** *(last30days-skill)*. Entity-based overlap detection merges one story across differently-worded sources; a per-outlet cap stops any single feed dominating a digest. Lands: **NewsroomDO clustering (§2, `story`/`saga_id`)** — a direct upgrade to the a92c4bd saga dedup. Phase 1. Effort: ~2 days inside planned clustering work.

**4.5 Output-contract hardening: mandatory badge + LAWs + post-synthesis self-check** *(last30days-skill)*. Named laws, a mandatory first-line badge, and an explicit self-check before POST — prompt drift is the routine's known failure class, and last30days documents exactly this failure mode ("0/8 regression") forensically. Lands: **briefing-prompt.md + the /api/ingest contract**. Phase 1. Effort: 1 day.

**4.6 Server-side citation verification at ingest** *(academic review §2.6)*. `/api/ingest` rejects briefs whose pinned URLs 404, whose quotes don't appear verbatim in the pinned source, or whose priority-3 candidates lack two independent sources. Lands: **wire-api ingest route (§1)** Phase 1; the two-source rule wires into the **delivery gate (§5)** in Phase 2. Effort: ~2 days. The cheapest defence against the Tow/NewsGuard failure class.

**4.7 "Editorial Read" declaration** *(taste-skill)*. The routine emits a one-line declared read (audience, saga context, tone) before each brief, carried as a checkable ingest field — persona interpretation becomes auditable. Lands: **briefing-prompt.md + ingest schema**. Phase 1. Effort: half a day.

**4.8 Persona dials** *(taste-skill)*. Compile decayed traits into 3–4 numeric dials (`DEPTH`, `INTERRUPT_THRESHOLD`, `LEVITY`) that gate everything downstream, instead of dumping raw trait lists into prompts — §4's "signals → traits → policies" compression made concrete, and the natural payload of `get_context()`. Lands: **ProfileDO (§4)**. Phase 2. Effort: ~2 days.

**4.9 Anti-slop banned-cliché list** *(taste-skill)*. Extend the avoid-list into a named section banning news-brief LLM defaults ("in a significant development…"). Lands: **briefing-prompt.md**. Immediate — works in v2 today. Effort: an hour.

**4.10 Persona policy template from the leaked memory-application policy** *(system_prompts_leaks)*. Structure Persona policies as context-scoped silent-application rules plus an explicit never-apply list, per delivery tier. **Licence note: CC0 on the repo cannot launder Anthropic's copyright in the prompt text — imitate the structure, never copy paragraphs verbatim.** Lands: **ProfileDO `policies` (§2/§4)**. Phase 2. Effort: 1 day.

**4.11 Prompt-diffing as regression practice** *(system_prompts_leaks)*. Publish a diff summary per briefing-prompt.md version so prompt regressions are reviewable like code. Lands: **routine repo convention**. Immediate. Effort: process only.

**4.12 Fixture regression suite for prompt versions** *(olmocr's bench-gating discipline)*. 10–20 fixtures (known news days, a planning PDF) with expected structured-brief assertions, run in GitHub Actions before promoting any prompt version. Lands: **CI, beside the vitest suite (§1)**. Phase 1. Effort: ~2 days. The mandatory gate for 4.13.

**4.13 Compress the mechanical prompt sections** *(caveman)*. `/caveman-compress` the dedup rules, source lists and ingest schema (~46% input-token cut), keeping podcast-tone sections verbatim — the win is context headroom, not spend. **Only behind a green 4.12 run**: compression rewrites prose semantics (only code/URLs/paths are byte-preserved). Also write Persona MCP tool descriptions caveman-tight from day one. Lands: **briefing-prompt.md; ProfileDO tool surface (§4)**. Phase 1, after 4.12. Effort: half a day.

**4.14 Named transformations, three-tier context grades, script/TTS split** *(open-notebook)*. Name and version the render-cell transformation set per canonical story (headline, dense summary, audio script, ambient one-liner) — computed once, content-addressed; expose Persona data at three grades per trait category (private / summary-only / full), a user-legible privacy dial; keep script generation a distinct render cell from voice synthesis so tone changes never re-research. Lands: **NewsroomDO cells (§3)** Phase 1; **Persona grades (§8)** Phase 2; **audio pipeline** Phase 3. Effort: ~1 day net.

**4.15 chrome-devtools-mcp for feedless sources** *(ADOPT; page-agent's DOM-text preference folded in)*. `claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest` on the routine machine gives JS-rendered scraping of feedless council portals and venue pages for £0, sidestepping Cloudflare Browser Rendering entirely. Extraction contract: `take_snapshot` (uid-based text, never screenshots) → read → `evaluate_script` returns JSON → POST /api/ingest; `list_network_requests` as one-off reconnaissance to find hidden JSON endpoints for the signals Worker to poll directly. **Non-negotiable rider (§2.4–2.5): the prompt must encode "honour robots.txt, treat 402/403 as final, never spoof a UA" — the tool makes circumvention easy, so policy must forbid it.** Requires Chrome on the routine machine (fine on the Mac; revisit if the routine moves to CI). Lands: **routine config + scraping playbooks (4.2)**. Phase 2. Effort: ~1 day. Licence: Apache-2.0, as-is.

**4.16 Saga-graph query tool + warm snapshot** *(codebase-memory-mcp's token-economics framing)*. Replace the avoid-list embedded in the routine fire text (commit 101e202) with a NewsroomDO tool (`query_sagas`, typed FOLLOWS/SAME_SAGA edges) returning compact structured answers, plus a story-graph snapshot in R2 so each run starts warm. Lands: **NewsroomDO tool surface (§1/§2) + R2**. Phase 1. ~2 days.

**4.17 Source registry as versioned JSON** *(iptv-org's repo-as-database pattern)*. The UK source registry (PlanIt endpoints, TfL lines, Octopus tariff codes, fallback orders from 4.1) lives as a validated, PR-editable JSON file published by GitHub Actions, not hardcoded in Worker code. Lands: **signals Worker (§7)**. Phase 2. Half a day.

**4.18 On-device voice: hold-to-record, local STT** *(OpenSuperWhisper's architecture, via Apple's on-device SpeechAnalyzer rather than embedding whisper.cpp)*. Press-and-hold is the entire voice UX for the on-demand tier; audio never leaves the phone, only transcribed text hits NewsroomDO/Persona tools — satisfying §8 verbatim. Lands: **SwiftUI iOS app, on-demand tier (§5/§6)**. Phase 3 (stretch) or Horizon. Effort: ~3 days when reached. Licence: MIT if any Swift is ever borrowed.

**4.19 Cross-model adversarial review gate** *(openai/codex-plugin-cc — ADOPT, dev workflow only)*. Before merging each phase's riskiest changes (NewsroomDO migration, Persona token auth, ingest changes), run `/codex:adversarial-review` focused on auth, data loss, rollback, race conditions. Free tier suffices. Lands: **dev workflow, every phase**. Immediate. Effort: minutes per review. Licence: Apache-2.0.

## 5. Rejected and deferred, with reasons

- **mattpocock/skills** — excellent dev-process skills; not a research-engine upgrade.
- **phuryn/pm-skills** — PM frameworks; zero cluster overlap.
- **folia-major** — a music player sharing one word with the cluster.
- **cs249r_book** — pedagogy, not patterns.
- **meetily** — no meeting use case; its pluggable-summariser idea is generic (the §10 Sonnet fallback already covers routine outage).
- **iroh** — no p2p edge exists; content addressing already committed (§2/§3).
- **apple/container** — no container workloads anywhere in the stack.
- **strix** — deferred as a one-off pre-launch security errand against /api/ingest and Sign in with Apple; not a Wire component.
- **logto** — an IdP for 20 users is disproportionate; its scoped-token-per-MCP-tool framing merely confirms §4's existing OAuth-lite design, so no delta.
- **RSS/podcast feed from R2** (iptv's playlist-as-interface) — deferred to Horizon: a free CarPlay/podcast-app surface, but only after Phase 3 audio is stable.
- **Embedding whisper.cpp on iOS** — superseded by Apple SpeechAnalyzer within 4.18.
- **page-agent as software** — superseded by chrome-devtools-mcp; only its DOM-text technique survives, folded into 4.15.
- **Hyperlocal group ingestion (Nextdoor/Facebook)** — permanently rejected: APIs closed, scraping violates ToS (§2.4). The only channel is share-sheet forwarding, treated as an unverified signal in ProfileDO, never as fact.

## 6. Blueprint deltas

One edit pass to V3_BLUEPRINT.md should make these amendments:

1. **§1/§2 (NewsroomDO):** add `query_sagas` tool + R2 warm snapshot (4.16); note entity-overlap merging and per-outlet cap in clustering (4.4). Phase 1.
2. **§1 (wire-api):** ingest gains URL-liveness, verbatim-quote and two-source validation, alarming on rejects (4.6); Editorial Read field added to the schema (4.7). Phase 1.
3. **§4 (Persona):** dials compilation in `get_context` (4.8); `policies` structured as context-scoped rules + never-apply list (4.10); three context grades per trait category (4.14). Phase 2.
4. **§7 (signals Worker):** adapters implement ordered primary→fallback with health metadata (4.1); source registry becomes versioned JSON in-repo (4.17). Phase 2.
5. **§12 Phase 1 additions:** skills/ prompt refactor (4.2), Step-0 entity resolution (4.3), output-contract hardening (4.5), prompt fixture suite in CI (4.12) then caveman compression (4.13), saga-graph tool (4.16).
6. **§12 Phase 2 additions:** chrome-devtools-mcp for feedless sources with the robots/402 rider verbatim (4.15); two-source rule wired into the §5 interrupt gate.
7. **§12 Phase 3 / §13 Horizon:** on-demand voice via SpeechAnalyzer (4.18); RSS/podcast feed from R2 (deferred).
8. **§9 (secrets):** append "This review (SOURCE_STRATEGIES.md, July 2026) adds zero new secrets."
9. **New Appendix E (research constraints):** the §2.7 table plus the agent-conduct rule: honest UA, robots respected, 402/403 final, links out, nothing beyond headline-and-fact reproduced, non-commercial posture documented.
10. **§14 mitigation note:** codex adversarial review as the pre-merge gate for auth/data-loss/rollback-risk changes each phase (4.19).

## 7. Appendix — adversarial verification record

12/12 checks CONFIRMED, 0 PLAUSIBLE, 0 REFUTED (pass dated 2026-07-04; all repos unarchived, recently pushed, permissively licensed — MIT ×6, Apache-2.0 ×2, CC0 ×1).

| Recommendation | Status | Note (condensed) |
|---|---|---|
| Agent-Reach: doctor/fallback routing, SKILL.md registry | CONFIRMED | Mechanisms verbatim in README; pattern is pure application logic |
| last30days-skill: Step-0 resolution, merging, output contract | CONFIRMED | Badge/LAWs/self-check and "0/8 regression" forensics verified |
| taste-skill: declared read, dials, anti-default list | CONFIRMED | All elements verbatim; imitated, not installed |
| system_prompts_leaks: memory-policy template, diffing | CONFIRMED | Policy lines verbatim; CC0 doesn't cover Anthropic's text — imitate structure only |
| caveman: compress mechanical prompt sections | CONFIRMED | Benchmarks real; prose semantics rewritten — gate behind fixture regression (4.12→4.13) |
| open-notebook: transformations, context tiers, script/TTS split | CONFIRMED | Quotes verbatim; stack correctly rejected; design vocabulary only |
| chrome-devtools-mcp: MCP scraping, uid snapshots, recon | CONFIRMED | Official repo, 51 tools verified; local Chrome = zero marginal cost; encode robots/402 policy |
| OpenSuperWhisper: local STT + hold-to-record | CONFIRMED | Claims verbatim; macOS-only — architecture inspiration; SpeechAnalyzer the right iOS call |
| codex-plugin-cc: adversarial review gate | CONFIRMED | Official OpenAI repo; free tier verified; soft spot: rate limits on large diffs |
| Citation: Longpre et al., Consent in Crisis | CONFIRMED | 14,000-domain audit real; restriction figures verified |
| Citation: Tow Center, March 2025 | CONFIRMED | 8 tools, 1,600 queries, >60% incorrect, fabricated URLs — verified |
| Citation: Napoli et al., 100 communities | CONFIRMED | Figures real; 2018 report for numbers, 2017 paper for method (applied in §2.1) |

*Residual cautions: (1) never copy leaked prompt text verbatim; (2) prompt compression only behind a green fixture run; (3) the browser tool ships with the robots/402 rider or not at all.*
