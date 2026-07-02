> # ⚠️ Historical design document (June 2026)
>
> **This is the pre-build design. The implementation diverged from it on its central
> decision, so read it as history, not as a description of the system.** The audio
> code that actually runs lives in the "audio" section of [`src/worker.js`](../src/worker.js)
> (`VOICE_MAP` / `episodeVoices`, `renderPodcast`, `ensurePodcastRendered`, `ttsRender`,
> `ensureBeat`). The main divergences, as built:
>
> - **§3 was inverted.** This doc chose "the routine renders the audio and uploads
>   MP3s to R2" and explicitly rejected lazy Worker rendering. The build did the
>   rejected option: **the Worker renders all audio itself**, with
>   `ELEVENLABS_API_KEY` held as a **Worker secret**. The routine ships **text only**
>   (items + podcast script via `/api/ingest`).
> - **No ffmpeg, no routine-side stitching.** Dialogue chunks are concatenated
>   **byte-level in the Worker** (MP3 frame concat plays fine in browsers). Chunks
>   pack to ≤1,800 chars on exchange boundaries, `stability: 0.35`, fixed seed,
>   concurrency 4 (`POD_RENDER_VERSION` "v5").
> - **Read-outs use Flash (`eleven_flash_v2_5`) as the only model**, rendered lazily
>   on first play and cached — not v3 pre-rendered in the routine. The podcast is
>   prewarmed at ingest (awaited in the `/api/ingest` handler), with a cold-GET
>   fallback render on `/api/podcast/today`.
> - **§2's Voice-Design flow was never built.** Voices are a hard-coded `VOICE_MAP`
>   of existing account voices (one per built-in desk, plus a dedicated `host`
>   narrator this doc never mentions); custom desks take a stable hash-pick from a
>   pool with per-episode collision avoidance.
> - **Keys and endpoints differ:** episodes live at
>   `podcast/<date>/<sha16(script)>-v5.mp3` (script-hash keys, no run-slot, **no
>   chapter manifest**); `/api/podcast/today` streams directly (`?meta=1`,
>   `?download=1`), Range is served on `/api/podcast/episode`, and `/feed.xml`,
>   `/api/beat` and `/api/style-preview` were added later. The bucket also now holds
>   `img/`, `beats/` and `previews/` prefixes.
> - **§4's cleanup wish is now real:** R2 lifecycle rules expire `img/`, `listen/`
>   and `podcast/` after **14 days** (`beats/` and `previews/` deliberately exempt).
> - **§7's cost model no longer applies:** read-outs are lazy Flash (only played
>   items bill), while the podcast renders per *unique script* up to 3×/day for the
>   shared feed **and** each active personalised user — see the README's cost section.

---

<!-- Researched from live ElevenLabs docs (June 2026) via a 6-area research workflow; reviewed against the live docs. [VERIFY] tags mark genuinely-uncertain items to confirm against your account before building. -->

---

# The Wire — Audio Feature Design (ElevenLabs)

**Status of facts:** Endpoint paths, bodies, the 2,000-char dialogue cap, the 10-voice dialogue cap, default `model_id`s, `voice_settings` defaults, pricing ($0.10/1k chars Multilingual+v3, $0.05/1k Flash), and the GenFM 2-voice cap are all confirmed verbatim from live docs (June 2026). Items flagged **[VERIFY]** below are genuinely uncertain.

---

## 1. Model + API choice

**(a) Daily multi-host podcast → Text-to-Dialogue API, `model_id: eleven_v3`.**
`POST /v1/text-to-dialogue` takes `inputs: [{text, voice_id}]` and returns one cohesive multi-voice MP3 with cross-speaker prosody — exactly the "desks discuss the day" feel. It supports up to **10 unique voice_ids**, comfortably covering 6 fixed desks + custom desks. v3 audio tags (`[laughs]`, `[excited]`, `[deadpan]`) give the banter personality.

*Rejected — GenFM Studio Podcasts (`POST /v1/studio/podcasts`):* confirmed hard-capped at **2 voices** (conversation mode = `host_voice_id` + `guest_voice_id`), the LLM writes the script (factual-drift risk on news), and it is async with a snapshot-streaming retrieval dance. We already produce the briefing in the routine, so we script it ourselves and keep full editorial + voice control. GenFM stays a documented fallback only.

**(b) Per-item "listen" read-outs → standard TTS, `POST /v1/text-to-speech/{voice_id}`, `model_id: eleven_v3`.**
One voice, so dialogue adds nothing, and single-voice TTS allows far more chars per request (~3–5k vs dialogue's 2k). Because these are pre-generated and cached during the routine, v3's higher latency is irrelevant and we take its best-quality output. **Fallback:** swap `model_id: eleven_flash_v2_5` (half price, 40k chars, ~75ms) if volume/cost ever bites.

---

## 2. Voice plan

**Voice source:** Voice-Design one bespoke voice per desk **once, at setup** (not in the 3×/day routine).
- `POST /v1/text-to-voice/design` with a tailored `voice_description` + fixed `seed` → returns 3 previews each with a `generated_voice_id`.
- `POST /v1/text-to-voice` with the chosen `generated_voice_id` → permanent `voice_id`.

Why Voice Design over premade library voices: **all Default/premade voices expire Dec 31 2026**; designed voices are retained in perpetuity — essential for durable per-desk identity. [VERIFY: that expiry date against live docs before relying on it.]

**Desk → voice_description sketches:**
| Desk | Description sketch |
|---|---|
| Liverpool FC | warm, energetic middle-aged Scouse male football pundit |
| Worcester/UK | measured, friendly British regional broadcaster |
| Gaming | upbeat younger enthusiast, fast cadence |
| EV & Battery | crisp, techy, mid-30s explainer |
| Markets | crisp, measured British female financial anchor |
| World | calm, authoritative, neutral broadcaster |

**Storage / assignment:** a `desk → voice_id` map in worker config (not a secret — voice_ids aren't sensitive), e.g. KV key `voicemap` or a checked-in `voices.json`. Each desk also gets a saved `voice_settings` signature (vary `stability`/`style`/`speed`) via `POST /v1/voices/{voice_id}/settings/edit` so even similar designs sound differentiated.

**Custom desks:** at desk-creation time, run the same two-step design flow once, persist the new `voice_id` into the map. If a custom desk has no voice yet, fall back to the "World" voice.

**[VERIFY]** v3's `voice_settings`: the dialogue `settings` object only documents `stability` (default 0.5). For standard TTS under v3, `similarity_boost`/`style`/`use_speaker_boost`/`speed` are documented but v3 was alpha — confirm they behave under `eleven_v3` before tuning hard. Use `stability` 0.5 (Natural) as the safe default; ~0.0 (Creative) for livelier banter.

---

## 3. Where generation happens

**The routine renders the audio itself and uploads MP3s to R2** — for both the podcast and per-item read-outs. The routine is a full Claude Code cloud session with curl, network, and env vars; it already POSTs the briefing to `/api/ingest`. Reasons:

- **Key safety:** the `xi-api-key` never touches the browser or the Worker hot path.
- **Chunk-and-stitch belongs in the routine.** The dialogue 2,000-char cap *forces* multiple sequential requests + MP3 concatenation for a full episode. The routine has `ffmpeg`/`cat` for MP3 concat; a Worker would be a poor place to orchestrate N sequential ElevenLabs calls + stitching within request limits.
- **Cost/latency:** generate once per day, cache; browser playback is then a static R2 fetch with zero per-play API cost or latency.

**Reject option (i) "write scripts as text, Worker renders lazily":** would push the ElevenLabs key + multi-call orchestration + stitching into the Worker, add cold-start latency on first play, and risk per-play cost amplification. **Choose option (ii): routine renders + uploads.**

The Worker's only job is to **serve cached R2 objects** and return 404/“not ready” if absent.

---

## 4. Caching / storage

**Audio lives in an R2 bucket** (`wire-audio`), bound to the Worker. Not KV (objects >25 MB, and R2 streams + supports range requests for audio seeking). Not ElevenLabs history (set `enable_logging=false` for zero-retention; we own the bytes).

**Keys (R2 object paths):**
- Podcast: `podcast/<YYYY-MM-DD>/<runSlot>.mp3` (runSlot = morning/midday/evening), plus `podcast/<date>/<slot>.json` for the chapter/segment manifest.
- Per-item: `listen/<itemId>/<voiceId>/<sha256(text)[:16]>.mp3` — content-addressed so identical text never regenerates; voice in the key so re-voicing a desk doesn't collide.

**Browser fetch:** Worker routes
- `GET /api/podcast/today` → 302/stream the latest podcast MP3 (or its manifest).
- `GET /api/listen/<itemId>` → look up the item's cached MP3 in R2, stream it with `Content-Type: audio/mpeg`, `Accept-Ranges: bytes`, `Cache-Control: public, max-age=86400`. 404 if not generated.

**Cleanup:** R2 lifecycle rule to expire `podcast/` and `listen/` objects after ~7–14 days. The routine can also delete prior-day objects at the start of its run.

---

## 5. Concrete request shapes

**Podcast segment (one chunk, ≤2,000 chars total across inputs):**
```
POST https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128&enable_logging=false
xi-api-key: $ELEVENLABS_API_KEY
Content-Type: application/json

{
  "model_id": "eleven_v3",
  "settings": { "stability": 0.5 },
  "seed": 1234,
  "apply_text_normalization": "auto",
  "inputs": [
    { "voice_id": "<liverpool_vid>", "text": "[excited] Right, massive night at Anfield..." },
    { "voice_id": "<markets_vid>",   "text": "[deadpan] And somehow that moved the betting markets more than the Fed did." }
  ]
}
```
→ `200 application/octet-stream` (MP3 bytes). Repeat per segment; `cat`/`ffmpeg -f concat` the segment MP3s into the day's episode; upload to R2.

**Per-item read-out:**
```
POST https://api.elevenlabs.io/v1/text-to-speech/<deskHostVoiceId>?output_format=mp3_44100_128&enable_logging=false
xi-api-key: $ELEVENLABS_API_KEY
Content-Type: application/json

{
  "model_id": "eleven_v3",
  "text": "[thoughtful] Here's the longer read on today's battery story... (>=250 chars)",
  "voice_settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": true, "speed": 1.0 },
  "seed": 42,
  "apply_text_normalization": "auto"
}
```
→ `200 application/octet-stream`. Keep read-out text **≥250 chars** (v3 is unreliable on short prompts — the longer-form item text already satisfies this). If an item exceeds the v3 char ceiling, split and use `previous_text`/`next_text` for continuity, then concat.

**Setup-only voice design (run once per desk):**
```
POST /v1/text-to-voice/design   { "voice_description": "...", "model_id": "eleven_ttv_v3", "seed": <n>, "text": "<100-1000 char preview>" }
POST /v1/text-to-voice          { "voice_name": "Liverpool Desk", "voice_description": "...", "generated_voice_id": "<from preview>" }
```

---

## 6. Build plan for The Wire

**Routine prompt changes:**
1. After building the briefing JSON, **write a multi-desk podcast script**: ordered turns tagged with `voice_id` per desk, segmented so each dialogue request ≤2,000 chars; sprinkle v3 audio tags (one vibe tag per turn, reactions sparingly, em-dash handoffs).
2. For each news item, write a **≥250-char longer-form read-out** in the owning desk's voice.
3. Render: loop dialogue segments → concat → upload `podcast/<date>/<slot>.mp3` + manifest; loop items → `POST text-to-speech` → upload `listen/<itemId>/<voiceId>/<hash>.mp3`. Use a fixed `seed` per chunk for reproducible re-runs. **Throttle concurrency to plan limit** [VERIFY: Creator ~5, Pro ~10 — confirmed only from secondary sources] to avoid 429s.
4. Continue POSTing the briefing JSON to `/api/ingest`, now including per-item audio R2 keys + podcast key so the client knows what's playable.

**New Worker endpoints:**
- `GET /api/podcast/today` → latest episode MP3 (+ `/api/podcast/today/manifest`).
- `GET /api/listen/<itemId>` → cached read-out MP3 from R2 (range-enabled), 404 if absent.

**Wiring:**
- R2 bucket `wire-audio` bound in `wrangler` config; lifecycle expiry rule.
- `ELEVENLABS_API_KEY` as a **routine env var/secret only** (never a Worker secret — Worker never calls ElevenLabs).
- `voices.json` (desk→voice_id map) checked in or in KV.

**Client UI:**
- **Podcast player:** sticky audio element sourced from `/api/podcast/today`; chapter markers from the manifest; show "generating…" if 404.
- **Per-pill listen button:** on click, fetch `/api/listen/<itemId>`; play returned MP3; cache the blob URL in-memory (and rely on `Cache-Control` for HTTP cache). Disabled state if not yet generated.

---

## 7. Cost & latency estimate, and owner dependencies

**Cost (confirmed pricing: v3 $0.10/1k chars, Flash $0.05/1k):**
- Podcast ~6–8 min ≈ 6,000–9,000 chars → ~$0.60–$0.90/episode on v3.
- Per-item read-outs: say 20 items × ~600 chars = 12,000 chars → ~$1.20/run on v3 (or ~$0.60 on Flash).
- **Per run ≈ $1.80–$2.10; 3×/day ≈ $5.40–$6.30/day ≈ ~$160–$190/month** on v3.
- **Plan fit:** v3 bills as Multilingual-tier characters. ~30k chars/run × 3 = ~90k/day ≈ **2.7M chars/month** → exceeds Pro's 990k. Either (a) move per-item read-outs to **Flash** and/or generate the podcast once/day not 3× (drops to ~well under 1M), landing on **Pro ($99)**, or (b) a Scale/usage-based plan. **Recommendation: podcast once daily + Flash read-outs** to fit ~Creator/Pro economics.

**Latency:** all batch in the routine; irrelevant to the browser (static R2 serve). Routine run adds maybe 1–3 min of synthesis depending on chunk count and concurrency throttle.

**Owner dependencies needed before build:**
1. **ElevenLabs API key** on a **paid plan** (Voice Library/Design + commercial use require paid; Pro recommended for char volume).
2. **Voice choices** — sign off the per-desk `voice_description`s, then run the one-time design flow and lock the `voice_id` map (mind the per-plan **voice-slot limit** for 6+ desks + custom).
3. **R2 bucket** (`wire-audio`) + binding + lifecycle rule.

**Flag before building (verify against live account/docs):**
- Exact v3 per-character credit cost / any promo multiplier (pricing page lists tier rates, not a v3 line item).
- Plan **concurrency** limits (429 throttling) — only from secondary sources.
- v3 `voice_settings` behavior beyond `stability` (alpha caveat) and the Default-voice **Dec 31 2026 expiry** date.
- Exact v3 single-request char ceiling (docs say 3,000 in one place, 5,000 in another) — confirm at runtime via `GET /v1/models`.
