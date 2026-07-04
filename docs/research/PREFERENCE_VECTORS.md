# Preference vectors for The Wire: should we steer per-topic embedding vectors with like/dislike arithmetic?

*Research note · July 2026 · synthesised from a maths review, a SOTA survey, a visualisation study and a codebase fit-check; every load-bearing claim adversarially verified (8 confirmed, 2 plausible-with-caveats, 0 refuted).*

---

## 1. Verdict

**Advisable with modifications** — and the modifications are not optional polish; the naive version is unadvisable as literally stated. The instinct (learn a dense taste vector per topic from the swipes you already collect, score stories by cosine) is sound, cheap, and exactly the right regime for a 20-user app. But a *single global* vector updated by *raw subtraction* of dislike embeddings is Rocchio's 1971 algorithm stripped of every safeguard the IR literature bolted onto it: it collapses multimodal taste into content the user never liked, its negative term is largely wasted in the anisotropic geometry of sentence-embedding space while leaking penalties across unrelated desks, and argmax serving on a self-reinforcing vector narrows to a cone within weeks. **The one modification that matters most: keep vectors per-desk and positive-only, and handle dislikes as separate negative prototypes (a thresholded penalty term), never as subtraction from the taste vector.** Everything else — mean-centring, decay, an exploration slot, shrinkage to the passport weight — follows from that shape.

## 2. What you proposed, formally

The proposal is **Rocchio relevance feedback** (Rocchio, 1971, in Salton's *SMART Retrieval System*), reborn on dense embeddings instead of tf–idf vectors:

```
u ← α·u + β·mean({x : liked}) − γ·mean({x : disliked})
```

with the online form `u ← (1−η)·u + η·x` per event — an exponential moving average of liked embeddings; a centroid tracker, nothing more. The lineage matters because the failure modes are documented, not hypothetical. The canonical weights (Buckley, Salton & Allan 1994; Manning et al., *IIR* §9.1.1) are **α=1, β=0.75, γ=0.15**: the negative term was found marginally useful at best, many systems set γ=0 outright, and Ide's "dec-hi" variant subtracts only the single highest-ranked non-relevant item. Joachims (ICML 1997) showed Rocchio is a generative heuristic — it estimates class means and ignores covariance — and the follow-up (Joachims 1998, ECML) showed discriminative learners dominate it on the same features.

The instinct is nonetheless correct in three ways. First, the regime: at N≈20 users and ~40 stories/day there is zero exploitable collaborative signal (MIND-class neural rankers train on 1M users and 24M clicks — verified), so content-based scoring on frozen embeddings plus lightweight per-user statistics is the *correct* answer, not a compromise. Second, the machinery already exists: the v3 trait-update rule `w ← w·e^(−Δt/τ) + η·signal` is component-wise identical to a decayed-mean user embedding, and story embeddings in D1 are already committed for clustering — preference vectors ride the same embedding at zero extra cost. Third, cosine scoring catches semantic similarity the user never verbalised, which the passport's free-text notes cannot.

## 3. Three failure modes of the naive version

All worked examples below were independently recomputed by the adversarial verifier and reproduce exactly.

### 3.1 Multimodal collapse: the centroid ranks mush above everything you liked

A mean of a multimodal set lies between the modes, near neither. Suppose a user's likes split into chip-design stories **a** = (1, 0) and privacy-law stories **b** = (0, 1). The centroid **u** = (0.5, 0.5) gives cos(u, a) = cos(u, b) = **0.707**, but a never-liked "middle" item — generic tech-policy roundup mush, **m** = (0.707, 0.707) — scores cos(u, m) = **1.000**. The centroid ranks content the user has never engaged with *above every story they actually liked*; indeed any unit item strictly inside the 90° wedge between the modes out-scores both of them.

This is exactly why Pinterest's **PinnerSage** (Pal et al., KDD 2020) refuses to average: it Ward-clusters each user's history and keeps multiple medoid embeddings per user, reporting that a single averaged embedding lands in regions containing nothing the user ever interacted with. At our scale the same idea comes one level up for free: **per-desk vectors** — the passport already partitions taste by desk — with a bifurcation check (silhouette on ≥10 likes) if a desk's likes split in two.

### 3.2 Negative subtraction is inefficient and leaky in anisotropic space

Sentence-embedding spaces are anisotropic: vectors occupy a narrow cone around a large common mean μ (Ethayarajh, EMNLP 2019; Gao et al. 2019). Cosines between *unrelated* texts sit around 0.68–0.8 for ada-002-class models, compressing the usable range to roughly [0.7, 1.0]. Write x = μ + δx with ‖μ‖ ≫ ‖δx‖: the discriminative signal lives entirely in the tiny δ residuals.

Numerically, with μ = (3, 0), a liked item x⁺ = (3, 0.5) and a *maximally opposed* disliked item x⁻ = (3, −0.5) still have cos(x⁺, x⁻) = **0.946**. Set u = x⁺ and apply a hefty γ = 0.3: u′ = u − 0.3·x⁻ = (2.1, 0.65) gives cos(u′, x⁻) = **0.894** — the hated item still scores "highly similar", because ~86% of the subtracted vector's norm was spent shaving the shared μ. (The verifier's precise correction: the subtraction is not *inert* — here it widens the positive–negative gap from 0.054 to 0.097 — but it is grossly inefficient and score-compressed.) After **mean-centring** (Mu & Viswanath's "All-but-the-Top", ICLR 2018; equivalently BERT-whitening), the residuals x̃⁺ = (0, 0.5) and x̃⁻ = (0, −0.5) have cos = **−1.0**. Subtract the rolling story-corpus mean before doing any vector geometry, or the geometry is fiction.

Worse, the one direction a dislike does move along is not purely topical. Let u = (1, 1, 0) encode chips + cycling, and let the user dislike one hype-flavoured chips story n = (0.71, 0, 0.71), where dimension 3 is "hype" style. After u′ = u − 0.6·n = (0.574, 1, −0.426), a *cycling* story sharing only the style dimension, x = (0, 0.71, 0.71), drops from cos = **0.50 → 0.33**, and chips overall drops **0.71 → 0.47**: one bad angle on one story punished an unrelated desk. And a handful of dislikes cannot carve a decision boundary anyway — each constrains one direction, leaving the other 767 (for bge-base) untouched.

Production practice agrees: nobody subtracts vectors. Twitter's open-sourced heavy ranker weighted explicit negative feedback at −74 against +0.5 for a like (~150:1, verified against the released scoring weights); a TikTok RecSys 2025 case study feeds denoised explicit negatives as *model signals*. Dislikes belong as **labels and features in the scorer**, scoped to the neighbourhood of the disliked item — never as geometry applied to the taste vector.

### 3.3 Feedback-loop narrowing

With serving rule x_t = argmax cos(u_t, x) and update u_{t+1} = u_t + β·x_t on like, any u* whose nearest content direction is self-consistent satisfies u_{t+1} ∝ u_t: the vector grows along its own direction and the served distribution shrinks to one cone. You only observe feedback on what you serve, so unexplored modes get zero gradient forever — the classic degenerate feedback loop (Jiang et al., AIES 2019; Chaney et al., RecSys 2018). The standard escapes are **decay** (u ← u·e^(−Δt/τ), τ ≈ 2–4 weeks, so a degenerate point needs continual re-confirmation and dead interests fade) and **exploration** — canonically LinUCB on Yahoo! Front Page *news* recommendation (Li et al., WWW 2010, +12.5% CTR over a context-free bandit; verified), with Thompson sampling (Chapelle & Li, NeurIPS 2011) matching it at a fraction of the implementation cost.

There is also a plain **sample-size gate**. At ~16 items/day and ~25% swipe rate, roughly 4 events/day across ~8 desks ≈ **0.5 events/desk/day**. Centroid angular error scales as √(d_eff/n); with post-whitening effective dimension plausibly 10–30, a desk needs on the order of **20–30 positives** before its cosine out-ranks the scalar desk weight it replaces — 6–10 weeks per desk *as a lower bound* (the verifier notes the event rate includes dislikes and d_eff is assumed, not measured; treat the threshold as tunable and pin it down by replaying logged swipes). With decay running, a tail desk may *never* graduate. Hence a design requirement: **shrink to the passport desk weight until a desk has ~20 positives.**

## 4. The recommended design for The Wire at N≈20

Five components, each mapped to where it lives in the v3 blueprint per the fit-check.

**1. Per-desk positive centroids with exponential decay — as traits in ProfileDO.** Store `key = desk.vec.<desk>`, value a float32 (or int8-quantised) blob in the ProfileDO's SQLite; 12 desks ≈ 9–36 KB. The update `v ← v·e^(−Δt/τ) + η·e_story` on likes only reuses the trait-decay machinery verbatim — the decay alarm owns the multiplicative term, `record_signal` delivers the additive term, `evidence_count` doubles as the cold-start gate. **Only liked embeddings ever touch v**, and all embeddings are mean-centred against the rolling story-corpus mean first (§3.2). The KV profile snapshot (~3 KB) cannot carry the vectors; use a separate `profile:{uid}:vecs` key or an L4→ProfileDO RPC.

**2. Dislikes as separate negative prototypes.** Cluster dislike embeddings exactly like likes and keep dislike medoids n_i per user. Score:

```
s(x) = cos(u_desk, x) − λ · max(0, maxᵢ cos(nᵢ, x) − τ_sim)
```

with λ ≈ 2–3 (dislikes are rarer and more informative — Twitter's 150:1 is the industry anchor) and τ_sim ≈ 0.6 so the penalty fires only on stories genuinely near a disliked one. A single dislike dents a neighbourhood; it never warps the taste vector or leaks across desks.

**3. Upgrade path: a per-desk linear scorer.** Once a user has **≥ ~50 labelled events** (the verifier's correction to the source's optimistic ~30 — in the strong-regularisation limit at n=30 the ridge solution direction collapses back to the Rocchio mean-difference, so there is no win that early), fit a small regularised logistic/ridge w — not on raw 768-d embeddings but on ~10 hand-built features (max-like-similarity, dislike penalty, desk passport weight, recency, source, saga-continuation flag). The gradient updates only on mis-scored items and weights directions by discriminative value — the thing Rocchio structurally cannot do. Validate the switch per-user by offline replay AUC before flipping it.

**4. Thompson-sampling exploration.** Reserve 1–2 of the 16 daily slots for off-vector picks. The proper version is per-user Bayesian linear regression over the same ~10 features: sample w ~ N(μ, Σ) each edition, rank by x·w, conjugate closed-form update on click/ignore/dislike. Roughly 30 lines of code, state is one μ/Σ pair per user, prior = the passport weights — so it works from day one, self-corrects a stale passport, and subsumes learning λ and the passport-vs-behaviour blend.

**5. Division of labour: vectors rank, the passport renders.** Cosine scoring is the trait-affinity factor in L4 assembly, which stays LLM-free ("desk weight × salience × recency × trait affinity" — the first and last factors collapse into one cosine term): 16 stories × 768 dims ≈ 12k multiply-adds per user, microseconds. The **notes** still go to the routine prompt as reader-instruction; the **avoid list** stays dedup; and since the scalar desk weights also feed the LLM tone path (`tasteOf`, `prefHint`, `deskLean`, v3's `get_pitch_level`), keep a **derived scalar per desk** (decayed positive count, or centroid-cosine mapped to 0–3) as the pitch input. The vector is ranking-only. The hybrid is itself SOTA at this scale: instruction-prompted LLM reranking is competitive precisely in low-data settings (Hou et al., ECIR 2024), and vectors shrinking 40 candidates to ~12 before Claude reranks/renders the final 6–8 also cuts prompt tokens ~3×.

**Embeddings and cost.** Embed title+lede at ingest via Workers AI — a one-line `[ai]` binding in `wrangler.toml`. `bge-m3` (1024-d, $0.012/M tokens) is the pragmatic pick; ~3–12k tokens/day costs well under $0.001/day inside the 10k-neuron free tier (pricing verified against live Cloudflare docs). Store vectors as blobs in D1 and brute-force cosine in JS — at ~800 user–story pairs/day (~1.2M FLOPs) Vectorize adds nothing until ~100k+ vectors.

## 5. The 2D dev chart

Worth building, but built *stably* and labelled *honestly*.

**Recipe:** L2-normalise → mean-centre → drop the top common component ("all-but-the-top", Mu & Viswanath 2018 — without this, anisotropy gives one blob in a corner) → fit 2-component **PCA once** on ~500–1000 story embeddings spanning a few weeks and all desks → **freeze the basis** and ship `{basis_ver, μ, common_dir, W, explained_variance}` as ~6 KB of JSON. Project each day's stories and every desk vector through the same frozen pipeline. Render as SVG: desk-coloured points, **liked filled / skipped-disliked hollow**, per-desk arrow from the origin (the corpus mean after centring) to the projected desk vector, tooltip showing the headline *and the true native-space cosine*.

**Why frozen PCA and not UMAP/t-SNE:** the hard requirement is that day-over-day movement means *preference change, not projection jitter*. At n≈300 the neighbour-graph methods are at their most unstable — refitting daily would make desks "move" for projection reasons alone; t-SNE's inter-cluster distances are meaningless; PaCMAP's own release notes warn the same point can map to a different place across fits. PCA's transform is closed-form and deterministic (`y = W(x−μ)`, one 2×d matmul), shares an identical basis across days, and is ~30 lines of vanilla JS. Refit only when the embedding model changes, bumping `basis_ver` (mirroring the `POD_RENDER_VERSION` habit).

**Print the caveat on the chart:** *"This chart preserves neighbourhoods, not distances or angles; two PCs carry ~10–25% of variance (actual % in footer); an arrow can point away from a story it genuinely matches — every ranking decision reads native-space cosine, never this projection."* Johnson–Lindenstrauss makes any 2D map of 768-d cosine geometry quantitatively wrong by construction; it is a debugging aid, never the model.

**Build the boring views first, though.** The scatter answers "what does the space look like"; the operative question — *is the vector learning anything?* — is answered better in native space: (1) **per-desk similarity histograms**, liked-vs-skipped distributions of cos(u_desk, story) with the separation AUC printed as a number (AUC ≈ 0.5 = the vector has learned nothing; AUC drift over days is the single most decision-useful tuning signal — about an hour of work); (2) a **compass bar view** of today's edition, stories sorted by cosine and coloured after the fact by behaviour. Then the scatter, for intuition and demos.

**Effort:** fit script ~50 lines; `GET /api/dev/projection` ~80–100 lines (gate: Apple session + an `ADMIN_SUBS` allowlist var — there is no admin role today); static `public/dev.html` ~200 lines of SVG. **Half a day to a day, zero new infrastructure.**

## 6. Alternatives considered and rejected

- **Single global preference vector.** Fails §3.1 outright; politics + F1 + biotech average to nowhere. Per-desk (and per-cluster, PinnerSage-style, if a desk bifurcates) is the fix at every scale.
- **Matrix factorisation / two-tower / MIND-class neural rankers.** Data-starved by three to five orders of magnitude: trained on 1M users and 24M clicks; 20 users × 20–60 events/month would memorise noise. Wrong regime, full stop.
- **Vector-database infrastructure (Vectorize/ANN).** At ~800 pairs/day of brute-force cosine (microseconds), an ANN index adds latency, cost and a moving part to solve a problem that appears at ~100k+ vectors. D1 blobs + a JS loop.
- **Pure-LLM preference prompting as a *replacement* for vectors.** Rejected as a replacement, retained as the rendering half of the hybrid. Prompted preferences handle negation, conditionals and compositional taste ("chip-industry geopolitics but not earnings coverage") that vectors cannot express — a legitimate ECIR-2024-validated technique at N=20 — but LLM scoring of all 40×20 pairs is slow, non-deterministic, unauditable and token-expensive. Vectors score everything cheaply and deterministically; Claude reranks and renders the shortlist.

## 7. Build order

Each step is independently shippable, with its acceptance signal:

1. **Embed at ingest.** Add the `[ai]` binding; embed title+lede with bge-m3 at `POST /api/ingest`; store blobs in D1; maintain the rolling corpus mean. *Accept: every new story row has a vector; the corpus-mean key updates daily.* (Already blueprint-committed for clustering — it just moves first.)
2. **Log per-event signals.** Today the client ships an aggregated profile, so the server never sees (item, action) pairs. Route swipes through `record_signal`; add a strong-like affordance (star/long-press) distinct from mark-read. *Accept: (uid, story_id, action, ts) rows accrue server-side.*
3. **Positive centroids + compass bars.** Per-desk decayed centroids in ProfileDO traits; shrinkage to the passport weight below ~20 positives; ship the AUC histogram and compass-bar views first. *Accept: on the most active desks, liked-vs-skipped AUC > 0.5 and rising.*
4. **Dislike prototypes.** Cluster dislikes; add the thresholded penalty to L4 scoring. *Accept: replayed dislike-neighbourhood stories drop in rank; unrelated desks unmoved.*
5. **Dev scatter.** Frozen-PCA `/dev` page per §5. *Accept: renders with basis version, explained-variance footer, native-cosine tooltips.*
6. **Linear scorer.** Per-user logistic/ridge over ~10 features once a user passes ~50 events. *Accept: offline replay AUC(logistic) > AUC(centroid) for that user before switching.*
7. **Thompson sampling.** Bayesian linear layer with passport prior; 1–2 exploration slots per edition. *Accept: exploration-slot click-through tracked separately; posterior visibly tightens over 2–4 weeks.*

## 8. Appendix

### Notation

**u** — per-desk preference vector; **x** / e_story — story embedding; **μ** — corpus common mean (anisotropy component), removed by centring; δx — residual after centring, where the signal lives; **n_i** — dislike-cluster medoids; τ — decay time-constant (2–4 weeks); τ_sim — dislike-penalty threshold (≈0.6); λ — dislike penalty weight (≈2–3); η — learning rate; d_eff — post-whitening effective intra-desk dimension (assumed 10–30, to be measured); AUC — liked-vs-skipped cosine separation.

### Verified claims table (adversarial verification)

| Claim | Status | Note |
|---|---|---|
| Rocchio (1971); weights α=1, β=0.75, γ=0.15; negative term marginal; Ide dec-hi | Confirmed | Discriminative-dominance result is Joachims 1998 (ECML), not 1997 |
| Multimodal collapse: cos(u,a)=0.707 vs cos(u,m)=1.000; PinnerSage clusters, never averages | Confirmed | Understated: any item in the full 90° wedge beats both modes |
| Anisotropy: cos(x⁺,x⁻)=0.946; after subtraction 0.894; after centring −1.0 | Confirmed | "Rankings barely change" overstated — subtraction is inefficient (~86% wasted on μ), not inert; centring still the fix |
| Collateral damage: cycling 0.50→0.33, chips 0.71→0.47 from one dislike | Confirmed | Recomputed exactly |
| Logistic beats Rocchio at ~30 labels | Plausible | Doubtful at n=30 (strong-ridge limit *is* the Rocchio direction); use ~50+ and offline replay |
| Degenerate feedback loops; LinUCB +12.5% CTR; Thompson sampling | Confirmed | All citations real; τ≈21d is a design choice, not derived |
| ~0.5 events/desk/day; 20–30 positives (6–10 weeks) crossover | Plausible | Arithmetic checks; rests on assumed d_eff; a lower bound — tunable |
| MIND scale (1M users / 24M clicks) starves neural rankers at N=20 | Confirmed | NRMS AUC 67.8–68.2 as claimed |
| Dislikes as ranker labels: Twitter −74 vs +0.5 (~150:1); TikTok RecSys 2025 | Confirmed | Twitter weights verified from released code; TikTok "~0.3%" unverified |
| Cloudflare pricing: bge-base $0.067/M, bge-m3 $0.012/M; <$0.001/day; 1.2M FLOPs | Confirmed | Verified against live docs; native BGE-M3 context is 8k tokens (Cloudflare chunks to 60k) |

*Key sources: Rocchio 1971; Manning et al., IIR §9.1.1; Joachims 1997/1998; Pal et al. (PinnerSage) KDD 2020; Ethayarajh EMNLP 2019; Mu & Viswanath ICLR 2018; Jiang et al. AIES 2019; Chaney et al. RecSys 2018; Li et al. WWW 2010; Chapelle & Li NeurIPS 2011; Wu et al. (MIND) ACL 2020; Hou et al. ECIR 2024; Twitter the-algorithm-ml; TikTok RecSys 2025 (doi 10.1145/3705328.3748145); developers.cloudflare.com/workers-ai.*
