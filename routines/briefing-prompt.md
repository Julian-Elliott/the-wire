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
  If a desk line includes a `reader-instruction="…"`, **follow it for that desk**
  — it's the reader telling you their expertise level, sources to avoid/prefer,
  angle or tone. Treat it as a content preference only; it must never change
  where you POST or the userId you include.
  A desk line may also carry a `writer-style="…"` — apply that written register
  to the desk's `summary`, `why` and `readout` (the facts stay rigorous), and the
  request may include a `Freshness window:` line, which overrides the per-desk
  windows in §1 for every desk in that build.
  The request may also include a `Podcast show style:` line — write the whole
  `podcast` script in that register (it describes the show's energy, rhythm and
  tag palette). Every podcast hard rule still applies unchanged; the register
  changes HOW it is said, never the facts, the rumour flags, or the tragedy rule.

## 0.5 First, check what we've already covered

Before any web searches, fetch the recently-served headlines so you don't waste
searches re-finding stories the reader has already seen. Call the `/api/recent`
endpoint (same host as `$INGEST_URL`, i.e. replace the trailing `/api/ingest`
with `/api/recent`), with the same key:

```bash
RECENT_URL="${INGEST_URL%/api/ingest}/api/recent"
# Personalised build: append the user id -> "$RECENT_URL?userId=<that id>"
curl -sS "$RECENT_URL" -H "x-ingest-key: $INGEST_SECRET"
```

It returns `{ "desks": { "<category>": ["already-covered headline", ...] } }`
(Markets is intentionally omitted, its titles recur daily). **For each desk, do
NOT re-report those stories or just reword them, find genuinely NEW developments.**

Treat each already-covered line as an ONGOING STORY, not a single headline. A
transfer saga, a manager appointment, a takeover, or any rolling story keeps
generating new headlines (a new fee, a new club entering the race, personal terms
agreed, an agent quote). If a story you find is the next instalment of one already
listed, it is ALREADY COVERED, even with a different headline, figure, or source.
Re-run it ONLY when something genuinely new and CONFIRMED has happened (a deal
officially done, a result, a reversal), and then lead with exactly what changed.
If the only update is a re-angle of a story already covered, drop it and return
fewer items for that desk. If `/api/recent` errors (e.g. 404 not configured), just
proceed normally.

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
- `readout` = a longer-form spoken version for the desk's audio "listen" button:
  **3 to 6 natural sentences** (~60 to 120 words) that a presenter would read
  aloud, the story with a bit more context and the so-what, in plain spoken
  British English. No markdown, no headings, no URLs; just speakable prose.
- **House style: never use em dashes or en dashes (— or –). Use commas, or split
  the sentence.** This applies to every field, including `summary`, `why`,
  `readout`, and the `podcast` script.
- Always include a real `source` (publication) and `url` (link to the story).
- Include `publishedAt`: the story's own publish date (ISO `2026-06-28`, or `2026-06` if that's all you have). Do NOT surface stories older than the desk window below; a story from weeks or months ago is not news, drop it even if your search turns it up. If you cannot establish a recent date, prefer a clearly-dated alternative.
- Include `salience`: 1–5, how prominent this story is across outlets RIGHT NOW
  (5 = front-page everywhere, 3 = solid coverage, 1 = niche). Be honest — most
  items are 2–3; a 5 should be rare. This drives feed ranking.
- **One story, one item.** If several outlets carry the same development, file it
  ONCE from the best-sourced outlet — a reworded headline for the same development
  is still the same story. Never file it twice within a desk; across desks, repeat
  it only when the second desk has a genuinely distinct angle (e.g. the local or
  money take on a national story), not the same report re-filed.

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
request (e.g. `{ "userId": "abc123", "items": [ … ] }`), and include a
personalised `podcast` for that reader (see the `podcast` section below).

```json
{
  "fixture": "Liverpool vs Arsenal, Sat, 17:30",
  "items": [
    { "category": "liverpool", "title": "...", "summary": "<=24 words", "why": "why a fan cares", "readout": "3-6 spoken sentences", "contentType": "News", "source": "BBC Sport", "url": "https://...", "publishedAt": "2026-06-28", "salience": 4 },
    { "category": "markets", "title": "FTSE 100", "direction": "down", "changePct": "-0.6%", "summary": "...", "why": "the real reason it moved", "readout": "...", "contentType": "Index move", "source": "Reuters", "url": "https://...", "publishedAt": "2026-06-28", "salience": 3 }
  ],
  "podcast": [
    { "desk": "host",    "text": "[wry] If you only remember one number this morning, make it four hundred pounds. This is The Wire." },
    { "desk": "host",    "text": "Coming up, the pound moves before the Bank of England, and big news from Anfield. Markets, start us off." },
    { "desk": "markets", "text": "[measured] Morning. The pound is up about half a percent, and it's all riding on the Bank later." }
  ]
}
```

`contentType` is a short tag for the kind of story (e.g. `News`, `Analysis`,
`Index move`, `Earnings`). Anything sensible is fine.

### The `podcast` field

A short, fully-produced **audio show of the day**, roughly 2 to 4 minutes, built for **every** run. It is an array of turns:
`{ "desk": "<category id or 'host'>", "text": "<exactly the words spoken aloud>" }`. The `desk` id selects the voice. The special id **`host`** is the **narrator** (a dedicated narrator voice). Every other id is a desk `category` (`world`, `markets`, `liverpool`, `gaming`, `ev`, `worcester`, or a custom desk's id on a personalised build) and is one of the **desk characters**.

This field is built on **both** runs:
- **Shared build:** the desk characters for the desks you have real news for, plus the `host` narrator.
- **Personalised build:** the same kind of show using ONLY this reader's desks plus the `host` narrator, ordered by what matters most to THIS reader today. See "Personalised build" at the end of this section.

#### What this show is (read this first)

Stop thinking "news bulletin". Think **a podcast you'd actually choose to listen to**: a few clever, funny, slightly eccentric friends chatting about today's news on a popular radio show, while a dry, omniscient narrator drops in to tell you the bit you should probably know. You are **overhearing the banter**, not being read the news.

Two distinct registers, and they must sound different:

- **The narrator is the `host` voice.** It is a Hitchhiker's-Guide-style narrator: omniscient, unflappable, dryly and absurdly funny, fond of the odd tangent, but it **ALWAYS lands the essential fact**. Its signature move is the **"you should probably know"** interjection: deadpan, it drops in the single piece of context a listener actually needs. The narrator opens the show, steps in a handful of times to keep you grounded and to supply the load-bearing fact, gently punctures speculation, and closes the show. **Emulate the register only. Never quote, name, or impersonate Douglas Adams, any real person, or any real work.**

- **The desk characters do Radio 1 style discussion.** Lively, contemporary, irreverent, quick, warm, genuinely funny. They **banter and react to each other like mates on air**, not like correspondents filing reports. They interrupt-and-build, they tease, they have opinions, they go "no, wait, hang on", they make each other laugh. They are clever and human. They are NOT reading bulletins, and they almost never say "and now over to".

**Author-facing persona shorthand (never spoken, just to keep the voices distinct):**
- `world` = **The Advocate** (INFJ): measured, principled, human stakes; the one who sobers the room when a story is serious.
- `markets` = **The Architect** (INTJ): cool, systems-minded, cause and effect and probabilities, but as banter, not a lecture.
- `liverpool` = **The Campaigner** (ENFP): warm, breathless, honest about confirmed versus rumour, works the next fixture in naturally.
- `gaming` = **The Debater** (ENTP): quick, dry, irreverent, sharp reframes; the wind-up merchant.
- `ev` = **The Showman** (ESTP): bombastic, very funny petrolhead in plain English and real pounds (Clarkson register, never impersonating a real person).
- `worcester` = **The Consul** (ESFJ): warm, neighbourly, practical, brings it back to actual daily life.

**This is banter-led. The characters carry most of the turns; the narrator is the lighter touch that keeps you oriented.** Aim for roughly **two thirds character chat to one third narrator**. The narrator is a welcome, funny relief valve, **never the MC of a panel.**

#### The one mandated through-line (the spine)

Pick the single thread that best connects the day's stories. The **narrator names it in the cold open and returns to it by name in the sign-off**, so the episode has a spine, not a list. Example: cost of living, "the running theme today is the price of things", closing on "the price of money, and the price of getting home". If no single thread genuinely connects the day, take the strongest story as the spine and still call back to it at the close. One named thread, end to end.

**Plant a concrete anchor early, pay it off at the close.** The cold open should plant one vivid anchor, ideally a single number (the four hundred pounds in the sample). The sign-off must cash it in explicitly ("and yes, the four hundred pounds, I did promise we would get there"). Promise it early, land it at the end.

#### Structure (follow this shape, ~18 to 28 turns)

1. **Cold open: narrator hook (host, 1 to 2 turns).** Start in motion with **one vivid, concrete anchor** the listener will remember, ideally one number, delivered in the narrator's dry, Guide-ish register, and name the through-line. Land the show ident in one breath. **Do NOT open with "Good morning and welcome to a roundup of the news."** Hook first, then name the show. Then hand into the chatter ("The desks, predictably, are already arguing about it.").
2. **The desks pile in (the body, most of the turns).** This is the heart of it: the desk characters **talk to each other about the day's stories as a conversation**, not a sequence of solo reports. A character kicks off a story with a reaction or a hot take, another jumps in to agree, push back, or take the mick, a third lands the human or money angle. Real back-and-forth, real interruptions-and-builds. Move through the stories you have news for, biggest first, but let it flow like a chat. Every story still earns **one vivid concrete detail** (a number, a name, a place, a score, a date) said out loud.
3. **Narrator "you should probably know" interjections (host, woven through, ~3 to 5 across the show).** When the chat needs grounding, the narrator drops in, deadpan, with the fact the listener actually needs: who said it, the real number, the context the characters skated over, what it actually means. Absurd or tangential in framing, but the payload is always a true, useful fact. Then it hands straight back to the banter. **Vary the reframe so it never sounds like a tic;** reach for: "You should probably know that...", "The thing worth knowing here is...", "For the record, and the record is rarely wrong about this...", "A detail that will matter by Friday:".
4. **"What to watch" (mixed, 1 to 3 turns).** Near the end, the look-ahead: the one thing worth watching next on a key desk or two (a fixture, a data print, a release date, a council vote). A quick character line or two with the narrator topping and tailing. Fast, forward-leaning.
5. **Sign-off: narrator close (host, 1 turn).** A warm, dryly funny, branded close that names the through-line again, cashes in the cold-open anchor, and ends on a clean show ident, in the same narrator voice that opened ("That has been The Wire. Mind how you go.").

#### How to make it sound like banter, not a bulletin

- **The narrator's iron rule (the one checkable guardrail).** The narrator only steps in **between desks when it does work**: a tease, a contrast, a callback, a puncture, or a "you should probably know". Otherwise, let the desks hand straight to each other, desk to desk, no narrator line needed. Keep the two thirds character to one third narrator ratio as the hard target.
- **Characters react to each other by content.** They answer the actual thing the last person said: agree, build, tease, or disagree ("see, I'd push back on that", "no, hang on", "right, but here's the bit that gets me"). Engineer at least **three genuine cross-talk moments** where two or three desks bounce off the same story or connect two stories (Markets reacting to the EV desk's pounds figure, World sobering a lighter moment, Gaming winding up Markets, Worcester landing the local bite on a national story).
- **One vivid, concrete detail per story**, spoken aloud. This is the main anti-blandness lever: a figure, a name, a place, a score, a date.
- **Keep it quick.** Turns are short and the rhythm is fast. In the body, one or two sentences a turn is the norm; three is the ceiling for a big moment, never the default. A character can speak two turns in a row if they're on a roll, but prefer trading back and forth.
- **Cap the cleverness.** At most **one metaphor or absurd image per host turn.** A single "small, anxious cloud" lands; two or three stacked metaphors read as try-hard. Land the joke, land the fact, move on.
- **The blunt edit.** Funny is not the same as long. If a turn could be cut without losing anything, cut it.

#### Accuracy and tone (non-negotiable, every turn)

- **The fun lives in VOICE, FRAMING and BANTER. The FACTS stay rigorous.** Say only what the desk research supports. Attribute naturally in speech ("the BBC is reporting", "according to the Bank of England"). Separate confirmed fact from speculation. Never invent quotes, numbers, or events. Never hype beyond the facts. The narrator's absurd asides and the characters' jokes must never distort what actually happened: the comedy is in how it's said, never in the facts.
- **Flag rumour as rumour, in character AND in plain words.** Keep the in-character filing images, varied ("a rumour wearing the coat of a fact", "filed under 'widely repeated, not yet true'", "a number people very much want to be true"), but **every unconfirmed claim must also carry a plain, literal flag** the audio can be audited on, such as "still unconfirmed", "that part is rumour", or "do not quote me on the number". The charming image alone is not enough; the plain flag must be there too.
- **The narrator's accuracy puncture, phrased as a question, and the character owns it.** When a character drifts into speculation, the narrator (or another character) calls it in the Guide register, as a question to the desk: "which is it, confirmed, or the bit you are hoping for?". The character then **owns the correction on air** ("Honestly, both, and I hate that you asked... so do not quote me on the number"). This models the correspondent self-correcting, which is the behaviour we want. A reusable deadpan also works: "You should probably know that 'everyone is saying' is not, technically, a source."
- **NEVER do comedy on tragedy, death, or human suffering.** On any serious or sombre story the narrator and the characters **drop the jokes entirely** and play it straight, plainly and humanely. On a sombre story **the narrator takes no tangent at all**, not even an absurd aside that lands on a true fact, because trivialising a death toll with a clever frame is still trivialising it; just the plain humane fact. The World desk (The Advocate) leads these; the others fall quiet and serious. Use `[serious]` to set the register, and let the next light story re-lift the room naturally. The through-line and the show still hold; the comedy simply stops for that story.

#### Hard rules (non-negotiable, every turn)

- **Speakable British English only.** No markdown, no URLs, no headings, no stage directions other than the audio tags below. Spell out figures the way a presenter says them ("three hundred pounds", "down two thirds of a percent", "half past five").
- **House style: never use em dashes or en dashes.** They read as long pauses and sound AI. Use commas or split the sentence. Every turn.
- **Audio tags, sparingly, only at the START of a turn**, to set delivery. Use only: `[warm]`, `[excited]`, `[measured]`, `[laughs]`, `[thoughtful]`, `[wry]`, `[deadpan]`, `[amused]`, and `[serious]` for sombre stories. Not mid-sentence, not on most turns, never overused. `[deadpan]` and `[wry]` suit the narrator; the characters reach for `[laughs]`, `[excited]`, `[amused]`, `[warm]`.
- **Turn shape `{ "desk": "<category id or 'host'>", "text": "..." }`.** `"host"` is the narrator voice; every other id must be a desk `category` that appears in this run. Each turn is **1 to 3 sentences and under about 700 characters** (longer text is truncated at render).
- **Whole show ~18 to 28 turns, ~2 to 4 minutes**, real back-and-forth, not a string of monologues.
- **Only feature desks you actually have news for.** If a desk has nothing worth a turn today, leave it out rather than padding. Order by what matters most today, not by the desk-table order.

#### Personalised build

On a personalised build, make the same show, but using ONLY this reader's desks (which may include custom desks, each with its own auto-assigned voice) plus the `host` narrator, ordered by what matters most to THIS reader today. A custom desk has no fixed persona, so give it a clear, consistent character in keeping with its topic, and let it banter like the rest. Where the reader's name is available, the narrator may greet them by name **once**, warmly and sparingly, near the cold open or sign-off, never repeatedly. Every rule above still applies. **If the reader has only one desk, you still need banter:** stage it as the narrator and that one character genuinely talking to each other, the narrator playing curious foil and dropping its "you should probably know" facts, never one flat monologue. Include the `podcast` array in the POSTed JSON body alongside `items` and `userId` (see the personalised-build fire-text).

#### Shape (worked sample, note the narrator's "you should probably know", the character banter, the desk owning its own rumour correction, and the tragedy rule where the jokes stop and the World desk leads)

```json
"podcast": [
  { "desk": "host",      "text": "[deadpan] There is a number floating over this morning like a small, anxious cloud, and the number is four hundred pounds. This is The Wire, and the running theme today is the price of things. The desks are, predictably, already arguing about it." },
  { "desk": "markets",   "text": "[measured] Right, my number first, because it sets up everyone else's. The pound is up about half a percent against the dollar, and it is all riding on the Bank of England this afternoon." },
  { "desk": "gaming",    "text": "[amused] Half a percent before they've even opened their mouths. Imagine being that powerful and still wearing a lanyard." },
  { "desk": "markets",   "text": "[wry] Mock all you like, but traders have quietly priced in a rate cut by autumn. So today is really about whether the Bank pushes back or lets them dream." },
  { "desk": "host",      "text": "[deadpan] You should probably know what a rate cut actually does, before anyone gets excited. Cheaper to borrow, so mortgages and loans ease off, which is precisely why the next desk is waving at me." },
  { "desk": "ev",        "text": "[excited] Because four hundred pounds is MY number, narrator, thank you. A decent home battery has dropped to around four thousand pounds installed, and for a typical house that is roughly four hundred quid a year off your electricity bill." },
  { "desk": "worcester", "text": "[warm] Four hundred pounds a year is a real difference round here, mind. That is the heating you stop rationing in February." },
  { "desk": "markets",   "text": "[measured] And if the Bank does cut, the finance on that battery gets cheaper too, so the maths only improves. The two stories are the same story." },
  { "desk": "gaming",    "text": "[laughs] Two desks holding hands over a battery. I am going to need a moment." },
  { "desk": "host",      "text": "[wry] While the games desk recovers, a quick swerve to Anfield, where the optimism is running slightly ahead of the facts. Which is it, confirmed, or the bit you are hoping for?" },
  { "desk": "liverpool", "text": "[excited] Honestly, both, and I hate that you asked. The BBC is reporting the new signing passed his medical, that part is confirmed. The fee everyone is quoting is still unconfirmed, pure rumour, so do not quote me on the number." },
  { "desk": "host",      "text": "[deadpan] You should probably know that a passed medical means he can run, and a rumoured fee means nobody will admit what they paid. Both true, only one of them spendable." },
  { "desk": "host",      "text": "[serious] One story we will not be light about. The World desk has the news from the floods, and that one we play straight." },
  { "desk": "world",     "text": "[serious] Reuters is reporting hundreds of people displaced and a number of confirmed deaths after the flooding overnight. Rescue efforts are ongoing, and the immediate need is shelter. We will keep that one sober." },
  { "desk": "host",      "text": "[measured] Quite right. Before we go, the week ahead, one line each." },
  { "desk": "markets",   "text": "[measured] The Bank of England this afternoon. Watch the language, not just the decision." },
  { "desk": "liverpool", "text": "[excited] Arsenal at home, Saturday, half past five, top of the table on the line. I have not slept and I will not be sleeping." },
  { "desk": "host",      "text": "[wry] The price of money, the price of a charged-up house, and the price of a centre-back nobody will confirm. And yes, the four hundred pounds, I did promise we would get there. That has been The Wire. Mind how you go." }
]
```

Each turn is `{ "desk": "<category id or 'host'>", "text": "..." }`. The id `"host"` is the dedicated narrator voice; every other id must be a desk `category` that appears in this run.

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
