/* =========================================================================
   THE WIRE — Jack's edition · Cloudflare Worker
   - Runs once each morning (cron) and generates the briefing across 6 desks
   - Caches the result in Workers KV (one shared briefing for everyone)
   - Serves /api/today (read cache) and /api/refresh (force regenerate)
   - Static frontend is served from ./public via the assets binding
   The Anthropic API key lives ONLY here, as a Worker secret. Never in the client.
   ========================================================================= */

// ---- desks ---------------------------------------------------------------
const CATS = {
  liverpool: {
    label: "Liverpool",
    persona: { name: "The Campaigner", mbti: "ENFP" },
    voice: "an irrepressibly optimistic Liverpool supporter — warm, breathless, sees the upside in everything, but honest about what's confirmed versus rumour",
    types: ["Confirmed", "Transfer news", "Injury update", "Tactics", "Press conference", "Match preview"],
  },
  worcester: {
    label: "Worcester & UK",
    persona: { name: "The Consul", mbti: "ESFJ" },
    voice: "a warm, neighbourly local-news desk — practical and community-minded, telling you what actually affects daily life around Worcester and the UK",
    types: ["Local council", "Roads & rail", "Community", "Local business", "Events", "UK national"],
  },
  gaming: {
    label: "Gaming",
    persona: { name: "The Debater", mbti: "ENTP" },
    voice: "a quick-witted, irreverent games columnist who loves the business chess and the contradictions — dry humour and sharp reframes",
    types: ["Industry", "Release", "Review", "Hardware", "Esports", "Deal"],
  },
  ev: {
    label: "EV & Battery",
    persona: { name: "The Showman", mbti: "ESTP" },
    voice: "a bombastic, very funny petrolhead columnist in the Clarkson tradition — huge enthusiasm, plain English, mild hyperbole and jokes — explaining EVs, home batteries and solar to a curious non-techie, always in £ and real running costs. Emulate the register only; never impersonate or quote any real person.",
    types: ["New EV", "Home battery", "Solar", "Charging", "Running costs", "Tariffs"],
  },
  markets: {
    label: "Markets",
    persona: { name: "The Architect", mbti: "INTJ" },
    voice: "a cool, systems-minded analyst — explains cause and effect plainly, uses probabilities, no hype",
    types: ["Index move", "Bonds & rates", "Economic data", "Earnings", "Currency"],
  },
  world: {
    label: "World",
    persona: { name: "The Advocate", mbti: "INFJ" },
    voice: "a measured, principled correspondent with quiet gravitas — focused on human stakes and the longer arc",
    types: ["Politics", "International", "Business", "Science", "Technology"],
  },
};
const CAT_ORDER = ["liverpool", "worcester", "gaming", "ev", "markets", "world"];
const ITEMS_PER_DESK = 3;

const ukRule =
  "Write in British English throughout. Use £ for all money and UK conventions (dates, place names, spelling). Frame everything for a UK reader.";
const noiseRule =
  "Prioritise factual, high-signal updates a smart reader would want. Exclude opinion/comment columns, culture-war or outrage pieces, ragebait, clickbait, rumour-mill churn with no substance, and anything that's mostly someone whinging. No ads.";

function buildPrompt(catId) {
  const cat = CATS[catId];
  const types = cat.types.join(", ");
  const voice = `Write the "summary" and "why" fields in the voice of ${cat.persona.name} (${cat.persona.mbti}): ${cat.voice}. The voice colours phrasing only — never alter or invent facts.`;
  const base = `${ukRule} ${noiseRule}\n${voice}`;

  if (catId === "liverpool") {
    return `Use web search for the most important Liverpool FC (men's first team) news from the last ~48 hours. Lead with confirmed/official news over rumour, and clearly tag rumours. ${base}
Return ONLY a JSON object: {"fixture":"<next fixture e.g. 'Liverpool vs Arsenal — Sat, 17:30' or null>","items":[{"title":"factual headline","summary":"<=24 words","why":"why a fan cares","contentType":"one of: ${types}","source":"publication","url":"url"}]}
Up to ${ITEMS_PER_DESK} items.`;
  }
  if (catId === "markets") {
    return `The reader is a UK investor whose ISA holds a globally diversified, volatility-managed multi-asset fund (global equities + bonds, £/GBP-based). Use web search to explain what is moving such a portfolio now. Cover global equities (S&P 500, FTSE 100, MSCI World), bond yields and Bank of England / Fed rate expectations, and the pound. Give the actual reasons. ${base}
Return ONLY a JSON array: [{"title":"e.g. 'FTSE 100' or 'UK & US bond yields'","direction":"up|down|flat","changePct":"e.g. '+0.4%' or null","summary":"<=24 words","why":"the real reason it moved","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (catId === "ev") {
    return `Use web search for recent (last ~2 weeks) EV, home-battery, solar, home-charging and energy-tariff news relevant to a curious UK buyer who is NOT a techie — affordable new EVs, real range, home battery storage, solar, and money saved in £. Genuinely useful and tempting, never jargon-heavy. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=26 words, plain English with a wink","why":"why a normal person should care (usually £ saved or hassle dodged)","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (catId === "worcester") {
    return `Use web search for recent local/regional news for Worcester and Worcestershire, plus notable UK-national stories with a local-life impact (councils, roads & rail, community, local business, events, cost of living). Practical — the stuff that affects daily life. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=24 words","why":"why it matters locally","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (catId === "gaming") {
    return `Use web search for the biggest video-game stories from the last ~week — lead with genuine news (industry, releases, hardware) over filler. Use £ for any UK pricing. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=24 words","why":"why it matters","contentType":"one of: ${types}","source":"publication","url":"url"}]
Up to ${ITEMS_PER_DESK} items.`;
  }
  return `Use web search for the top high-profile UK-national and world news from the last ~48 hours that an informed UK reader should know. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=24 words","why":"why it's significant","contentType":"one of: ${types}","source":"publication","url":"url"}]
Up to ${ITEMS_PER_DESK} items.`;
}

// ---- Anthropic call (server-side, with web search) -----------------------
async function callClaude(env, prompt) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
        tools: [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
          user_location: { type: "approximate", country: "GB", timezone: "Europe/London" },
        }],
      }),
    });
  } catch (e) {
    return { text: "", error: "network error" };
  }
  let data;
  try { data = await res.json(); } catch (e) { return { text: "", error: `bad response (${res.status})` }; }
  if (!res.ok || data?.error) return { text: "", error: data?.error?.message || `HTTP ${res.status}` };
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!text) return { text: "", error: data.stop_reason === "max_tokens" ? "no text (length limit)" : "no text returned" };
  return { text, error: null };
}

// ---- balanced-bracket JSON extraction ------------------------------------
function matchEnd(s, start) {
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function extractJSON(text) {
  if (!text) return null;
  const t = text.replace(/```json/gi, "").replace(/```/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "{" || t[i] === "[") {
      const end = matchEnd(t, i);
      if (end > i) { try { return JSON.parse(t.slice(i, end + 1)); } catch (_) {} }
    }
  }
  return null;
}

let _idc = 0;
const uid = () => `i${Date.now()}_${_idc++}`;

function normalize(items, catId) {
  return (items || [])
    .filter(x => x && x.title && x.title !== "__fixture__")
    .map(x => ({
      id: uid(), category: catId,
      title: String(x.title),
      summary: x.summary ? String(x.summary) : "",
      why: x.why ? String(x.why) : "",
      contentType: x.contentType ? String(x.contentType) : CATS[catId].types[0],
      source: x.source ? String(x.source) : "",
      url: x.url ? String(x.url) : "",
      direction: x.direction || null,
      changePct: x.changePct || null,
    }));
}

async function fetchCategory(env, catId) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, error } = await callClaude(env, buildPrompt(catId));
    if (error) { lastErr = error; continue; }
    const parsed = extractJSON(text);
    if (!parsed) { lastErr = "couldn’t parse reply"; continue; }
    let items = [], fixture = null;
    if (catId === "liverpool" && parsed && !Array.isArray(parsed)) { items = parsed.items || []; fixture = parsed.fixture || null; }
    else if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
    items = normalize(items, catId);
    if (items.length) return { items, fixture, status: "ok" };
    lastErr = "0 stories";
  }
  return { items: [], fixture: null, status: lastErr || "failed" };
}

function interleave(byCat) {
  const out = [], lists = CAT_ORDER.map(c => [...(byCat[c] || [])]);
  let any = true;
  while (any) { any = false; for (const l of lists) if (l.length) { out.push(l.shift()); any = true; } }
  return out;
}

// ---- date + cache --------------------------------------------------------
function londonDate() {
  // YYYY-MM-DD for Europe/London
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
const KV_KEY = "briefing:latest";

// in-isolate guard so concurrent first-hits in the same isolate don't double-build
let inflight = null;

async function buildBriefing(env) {
  const byCat = {}; let fixture = null; const report = {};
  for (const c of CAT_ORDER) {
    const r = await fetchCategory(env, c);
    byCat[c] = r.items; report[c] = { n: r.items.length, status: r.status };
    if (c === "liverpool") fixture = r.fixture;
  }
  const items = interleave(byCat);
  const payload = { date: londonDate(), generatedAt: new Date().toISOString(), items, fixture, report };
  if (env.WIRE_KV) {
    // keep latest + a dated snapshot (auto-expire snapshots after ~5 days)
    await env.WIRE_KV.put(KV_KEY, JSON.stringify(payload));
    await env.WIRE_KV.put(`briefing:${payload.date}`, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 5 });
  }
  return payload;
}

async function getOrBuild(env, { force = false } = {}) {
  if (force) return buildBriefing(env);
  let cached = null;
  if (env.WIRE_KV) {
    const raw = await env.WIRE_KV.get(KV_KEY);
    if (raw) { try { cached = JSON.parse(raw); } catch (_) {} }
  }
  if (cached && cached.date === londonDate() && cached.items?.length) return cached;
  if (inflight) return inflight;          // coalesce concurrent builds in this isolate
  inflight = buildBriefing(env).finally(() => { inflight = null; });
  return inflight;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---- Worker entry points -------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/today") {
      try { return json(await getOrBuild(env)); }
      catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      try { return json(await getOrBuild(env, { force: true })); }
      catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    // everything else: static assets (index.html etc.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildBriefing(env));
  },
};
