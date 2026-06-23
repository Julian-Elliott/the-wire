/* =========================================================================
   THE WIRE — Jack's edition · Cloudflare Worker
   - Generates a daily briefing across a set of "desks" (built-in + custom)
   - Anonymous visitors get a shared briefing (cheap, one copy in KV)
   - Once a visitor customises (swipes / adds desks), they get a PERSONAL
     briefing keyed by an anonymous user id, with their preferences injected
     into each desk's prompt.
   - /api/today reads cache (builds in the background), /api/refresh forces a
     rebuild, /api/profile stores a user's desks + learned weights.
   The Anthropic API key lives ONLY here, as a Worker secret. Never in the client.
   ========================================================================= */

// ---- built-in desks ------------------------------------------------------
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

// ---- onboarding catalogue: suggested desks grouped for the "build your wire"
// picker. Built-ins reference CATS by id; topical ones become custom desks.
const CATALOGUE = [
  { name: "Sport", desks: [
    { id: "liverpool", label: "Liverpool FC", builtin: true },
    { id: "cat-prem", label: "Premier League", topic: "Premier League football — results, transfers, talking points" },
    { id: "cat-f1", label: "Formula 1", topic: "Formula 1 — race results, driver and team news, regulations" },
    { id: "cat-nfl", label: "NFL", topic: "NFL American football — games, trades, the playoff race" },
    { id: "cat-tennis", label: "Tennis", topic: "professional tennis — ATP/WTA results and Grand Slams" },
    { id: "cat-cricket", label: "Cricket", topic: "international and county cricket" },
  ]},
  { name: "Tech & Science", desks: [
    { id: "gaming", label: "Gaming", builtin: true },
    { id: "cat-ai", label: "AI", topic: "artificial intelligence — model releases, research and industry moves" },
    { id: "cat-gadgets", label: "Gadgets", topic: "consumer tech and gadget launches and reviews" },
    { id: "cat-space", label: "Space", topic: "spaceflight and astronomy" },
    { id: "cat-science", label: "Science", topic: "notable science and research breakthroughs" },
  ]},
  { name: "Money", desks: [
    { id: "markets", label: "Markets", builtin: true },
    { id: "ev", label: "EV & Battery", builtin: true },
    { id: "cat-money", label: "Personal finance", topic: "UK personal finance — savings, mortgages, bills and cost of living" },
    { id: "cat-property", label: "Property", topic: "the UK housing market and property" },
    { id: "cat-crypto", label: "Crypto", topic: "cryptocurrency and digital assets" },
  ]},
  { name: "Culture", desks: [
    { id: "cat-film", label: "Film & TV", topic: "film and television — releases, news and reviews" },
    { id: "cat-music", label: "Music", topic: "the music industry, releases and artists" },
    { id: "cat-books", label: "Books", topic: "books, authors and publishing" },
  ]},
  { name: "News", desks: [
    { id: "world", label: "World", builtin: true },
    { id: "worcester", label: "Worcester & UK", builtin: true },
    { id: "cat-politics", label: "UK Politics", topic: "UK politics and Westminster" },
    { id: "cat-health", label: "Health", topic: "health, the NHS and wellbeing" },
  ]},
];
const ITEMS_PER_DESK = 3;

const ukRule =
  "Write in British English throughout. Use £ for all money and UK conventions (dates, place names, spelling). Frame everything for a UK reader.";
const noiseRule =
  "Prioritise factual, high-signal updates a smart reader would want. Exclude opinion/comment columns, culture-war or outrage pieces, ragebait, clickbait, rumour-mill churn with no substance, and anything that's mostly someone whinging. No ads.";

// ---- desk resolution (built-ins + a user's custom desks) -----------------
function deskList(profile) {
  const enabled = profile && profile.desks && Array.isArray(profile.desks.enabled)
    ? profile.desks.enabled : null;
  const builtins = CAT_ORDER
    .filter(id => !enabled || enabled.includes(id))
    .map(id => ({ id, builtin: true, label: CATS[id].label, types: CATS[id].types }));
  const custom = (profile && profile.desks && Array.isArray(profile.desks.custom) ? profile.desks.custom : [])
    .filter(d => d && d.id && (d.topic || d.label))
    .map(d => ({
      id: String(d.id), builtin: false,
      label: String(d.label || d.topic),
      topic: String(d.topic || d.label),
      voice: d.voice ? String(d.voice) : "",
      voiceName: d.voiceName ? String(d.voiceName) : "",
      types: Array.isArray(d.types) && d.types.length ? d.types.map(String) : ["News", "Analysis", "Background", "Feature"],
    }));
  return [...builtins, ...custom];
}

// Turn learned weights into a desk-specific prompt hint: which of THIS desk's
// content types to favour/ease off, a tone nudge from how much the reader likes
// the desk overall, and a little of their broader cross-desk taste. This is what
// lets each desk's personality drift with what the reader likes and dislikes.
function prefHint(profile, desk) {
  const w = (profile && profile.weights) || {};
  const val = k => (typeof w[k] === "number" && isFinite(w[k])) ? w[k] : 0;
  const types = (desk && desk.types) || [];
  const likedT = types.filter(t => val(t) > 0).sort((a, b) => val(b) - val(a));
  const dislikedT = types.filter(t => val(t) < 0).sort((a, b) => val(a) - val(b));
  const deskW = desk ? val("desk:" + desk.id) : 0;

  const all = Object.keys(w).filter(k => !k.startsWith("desk:"));
  const gLiked = all.filter(k => val(k) > 0 && !types.includes(k)).sort((a, b) => val(b) - val(a)).slice(0, 6);
  const gDisliked = all.filter(k => val(k) < 0 && !types.includes(k)).sort((a, b) => val(a) - val(b)).slice(0, 6);

  let s = "";
  if (likedT.length || dislikedT.length) {
    s += "\nWithin this desk:";
    if (likedT.length) s += ` favour ${likedT.join(", ")};`;
    if (dislikedT.length) s += ` go lighter on ${dislikedT.join(", ")};`;
  }
  if (deskW >= 2) s += "\nThe reader clearly loves this desk — lean into its personality, with a touch more energy and generosity.";
  else if (deskW <= -2) s += "\nThe reader is lukewarm on this desk — dial the personality back, be more selective and matter-of-fact, and raise the bar for inclusion.";
  if (gLiked.length || gDisliked.length) {
    s += "\nTheir broader taste:";
    if (gLiked.length) s += ` they engage with ${gLiked.join(", ")};`;
    if (gDisliked.length) s += ` they skip ${gDisliked.join(", ")};`;
  }
  if (s) s += "\nLet this shape selection and tone, but relevance and accuracy come first — never fabricate, distort, or pad to match preferences.";
  return s;
}

function buildPrompt(desk, hint) {
  const types = (desk.types && desk.types.length ? desk.types : ["News", "Analysis", "Background"]).join(", ");
  const voiceName = desk.builtin
    ? `${CATS[desk.id].persona.name} (${CATS[desk.id].persona.mbti})`
    : (desk.voiceName || "the desk");
  const voiceDesc = desk.builtin ? CATS[desk.id].voice : (desk.voice || "a clear, knowledgeable, genuinely interesting correspondent");
  const voice = `Write the "summary" and "why" fields in the voice of ${voiceName}: ${voiceDesc}. The voice colours phrasing only — never alter or invent facts.`;
  const base = `${ukRule} ${noiseRule}\n${voice}${hint || ""}`;

  if (desk.builtin && desk.id === "liverpool") {
    return `Use web search for the most important Liverpool FC (men's first team) news from the last ~48 hours. Lead with confirmed/official news over rumour, and clearly tag rumours. ${base}
Return ONLY a JSON object: {"fixture":"<next fixture e.g. 'Liverpool vs Arsenal — Sat, 17:30' or null>","items":[{"title":"factual headline","summary":"<=24 words","why":"why a fan cares","contentType":"one of: ${types}","source":"publication","url":"url"}]}
Up to ${ITEMS_PER_DESK} items.`;
  }
  if (desk.builtin && desk.id === "markets") {
    return `The reader is a UK investor whose ISA holds a globally diversified, volatility-managed multi-asset fund (global equities + bonds, £/GBP-based). Use web search to explain what is moving such a portfolio now. Cover global equities (S&P 500, FTSE 100, MSCI World), bond yields and Bank of England / Fed rate expectations, and the pound. Give the actual reasons. ${base}
Return ONLY a JSON array: [{"title":"e.g. 'FTSE 100' or 'UK & US bond yields'","direction":"up|down|flat","changePct":"e.g. '+0.4%' or null","summary":"<=24 words","why":"the real reason it moved","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (desk.builtin && desk.id === "ev") {
    return `Use web search for recent (last ~2 weeks) EV, home-battery, solar, home-charging and energy-tariff news relevant to a curious UK buyer who is NOT a techie — affordable new EVs, real range, home battery storage, solar, and money saved in £. Genuinely useful and tempting, never jargon-heavy. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=26 words, plain English with a wink","why":"why a normal person should care (usually £ saved or hassle dodged)","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (desk.builtin && desk.id === "worcester") {
    return `Use web search for recent local/regional news for Worcester and Worcestershire, plus notable UK-national stories with a local-life impact (councils, roads & rail, community, local business, events, cost of living). Practical — the stuff that affects daily life. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=24 words","why":"why it matters locally","contentType":"one of: ${types}","source":"publication","url":"url"}]
${ITEMS_PER_DESK} items.`;
  }
  if (desk.builtin && desk.id === "gaming") {
    return `Use web search for the biggest video-game stories from the last ~week — lead with genuine news (industry, releases, hardware) over filler. Use £ for any UK pricing. ${base}
Return ONLY a JSON array: [{"title":"...","summary":"<=24 words","why":"why it matters","contentType":"one of: ${types}","source":"publication","url":"url"}]
Up to ${ITEMS_PER_DESK} items.`;
  }
  if (!desk.builtin) {
    return `Use web search for the most important, genuinely newsworthy updates from roughly the last week on this topic: "${desk.topic || desk.label}". Lead with substantive news and real developments over filler; clearly tag anything speculative. ${base}
Return ONLY a JSON array: [{"title":"factual headline","summary":"<=24 words","why":"why it matters to someone who follows this","contentType":"one of: ${types}","source":"publication","url":"url"}]
Up to ${ITEMS_PER_DESK} items.`;
  }
  // built-in "world" (and any fallback)
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

function normalize(items, desk) {
  return (items || [])
    .filter(x => x && x.title && x.title !== "__fixture__")
    .map(x => ({
      id: uid(), category: desk.id,
      title: String(x.title),
      summary: x.summary ? String(x.summary) : "",
      why: x.why ? String(x.why) : "",
      contentType: x.contentType ? String(x.contentType) : desk.types[0],
      source: x.source ? String(x.source) : "",
      url: x.url ? String(x.url) : "",
      direction: x.direction || null,
      changePct: x.changePct || null,
    }));
}

async function fetchDesk(env, desk, hint) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, error } = await callClaude(env, buildPrompt(desk, hint));
    if (error) { lastErr = error; continue; }
    const parsed = extractJSON(text);
    if (!parsed) { lastErr = "couldn’t parse reply"; continue; }
    let items = [], fixture = null;
    if (desk.builtin && desk.id === "liverpool" && parsed && !Array.isArray(parsed)) { items = parsed.items || []; fixture = parsed.fixture || null; }
    else if (Array.isArray(parsed)) items = parsed;
    else if (parsed && Array.isArray(parsed.items)) items = parsed.items;
    items = normalize(items, desk);
    if (items.length) return { items, fixture, status: "ok" };
    lastErr = "0 stories";
  }
  return { items: [], fixture: null, status: lastErr || "failed" };
}

function interleave(byCat, order) {
  const out = [], lists = order.map(c => [...(byCat[c] || [])]);
  let any = true;
  while (any) { any = false; for (const l of lists) if (l.length) { out.push(l.shift()); any = true; } }
  return out;
}

// ---- date + cache --------------------------------------------------------
function londonDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function londonHour() {
  try { return parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }).format(new Date()), 10) % 24; }
  catch (_) { return new Date().getUTCHours(); }
}
const londonSlot = () => { const h = londonHour(); return h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"; };

// Merge fresh stories into today's running feed: dedupe, keep newest first, and
// cap how many accumulate per desk over the day.
const DAILY_CAP_PER_DESK = 9;
const normTitle = t => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const itemKey = it => (it.url && String(it.url).trim())
  ? "u:" + String(it.url).trim().toLowerCase()
  : "t:" + it.category + "|" + normTitle(it.title);
function mergeItems(prior, fresh) {
  const seen = new Set(); const out = [];
  for (const it of fresh) { const k = itemKey(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  for (const it of prior) { const k = itemKey(it); if (seen.has(k)) continue; seen.add(k); out.push(it); }
  const per = {}; const capped = [];
  for (const it of out) { const n = per[it.category] = (per[it.category] || 0) + 1; if (n <= DAILY_CAP_PER_DESK) capped.push(it); }
  capped.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  return capped;
}
const SHARED_KEY = "briefing:latest";
const userBriefKey = u => `briefing:user:${u}`;
const profileKey = u => `profile:${u}`;
const cleanUid = u => (typeof u === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(u)) ? u : null;
// Looser check for the trusted ingest path: also accepts the "apple:<sub>"
// session id form (colons + dots) that cleanUid (anonymous ids only) rejects,
// so a routine's personalised build routes back to a signed-in user's feed.
const cleanUidLoose = u => (typeof u === "string" && /^[A-Za-z0-9_.:-]{8,96}$/.test(u)) ? u : null;

function isCustomised(p) {
  if (!p || !p.desks) return false;
  if (Array.isArray(p.desks.enabled)) return true;
  if (Array.isArray(p.desks.custom) && p.desks.custom.length) return true;
  if (p.weights && Object.keys(p.weights).length) return true;
  return false;
}

function sanitizeProfile(p) {
  p = p && typeof p === "object" ? p : {};
  const d = p.desks && typeof p.desks === "object" ? p.desks : {};
  const enabled = Array.isArray(d.enabled)
    ? d.enabled.filter(id => CAT_ORDER.includes(id))
    : null;
  const custom = (Array.isArray(d.custom) ? d.custom : [])
    .slice(0, 8)
    .map(x => ({
      id: (String(x.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)) || `c${Math.random().toString(36).slice(2, 8)}`,
      label: String(x.label || "").slice(0, 40),
      topic: String(x.topic || "").slice(0, 200),
      voice: String(x.voice || "").slice(0, 300),
      voiceName: String(x.voiceName || "").slice(0, 40),
      types: Array.isArray(x.types) ? x.types.slice(0, 8).map(t => String(t).slice(0, 30)) : [],
    }))
    .filter(x => x.topic || x.label);
  const weights = {};
  if (p.weights && typeof p.weights === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(p.weights)) {
      if (n++ >= 120) break;
      if (typeof v === "number" && isFinite(v)) weights[String(k).slice(0, 48)] = Math.max(-10, Math.min(10, v));
    }
  }
  return { desks: { enabled, custom }, weights };
}

// in-isolate guard so concurrent hits don't kick off duplicate builds (keyed per user)
const inflight = new Map();

async function buildBriefing(env, profile, writeKeys) {
  const desks = deskList(profile);
  const order = desks.map(d => d.id);
  // Fetch every desk in parallel — wall time is the slowest desk, not the sum.
  // Each desk gets its OWN preference hint so its personality adapts individually.
  const results = await Promise.all(desks.map(d => fetchDesk(env, d, prefHint(profile, d))));
  const byCat = {}; let fixture = null; const report = {};
  desks.forEach((d, i) => {
    const r = results[i];
    byCat[d.id] = r.items;
    report[d.id] = { n: r.items.length, status: r.status, label: d.label, builtin: !!d.builtin };
    if (d.id === "liverpool") fixture = r.fixture;
  });
  const stamp = new Date().toISOString();
  const slot = londonSlot();
  const fresh = interleave(byCat, order);
  fresh.forEach(it => { it.addedAt = stamp; it.slot = slot; });

  // Merge into today's running feed so afternoon/evening pulls ADD to the
  // morning feed (newest first) instead of replacing it. New day → start clean.
  let prior = [];
  if (env.WIRE_KV && writeKeys) {
    const existing = await readJSON(env, writeKeys.latest);
    if (existing && existing.date === londonDate() && Array.isArray(existing.items)) prior = existing.items;
  }
  const items = mergeItems(prior, fresh);

  const payload = {
    date: londonDate(), generatedAt: stamp, slot,
    items, fixture, report,
    desks: desks.map(d => ({ id: d.id, label: d.label, builtin: !!d.builtin })),
  };
  if (env.WIRE_KV && writeKeys) {
    await env.WIRE_KV.put(writeKeys.latest, JSON.stringify(payload));
    if (writeKeys.snapshot) await env.WIRE_KV.put(writeKeys.snapshot, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 5 });
  }
  return payload;
}

// Start a build if one isn't already running for this key, coalescing callers.
function startBuild(env, key, profile, writeKeys) {
  if (!inflight.has(key)) {
    const p = buildBriefing(env, profile, writeKeys).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

async function readJSON(env, key) {
  if (!env.WIRE_KV) return null;
  const raw = await env.WIRE_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Placeholder returned immediately while a build runs in the background.
const generatingShell = () => ({
  date: londonDate(), generatedAt: null, items: [], fixture: null, report: {}, desks: [], generating: true,
});

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// Resolve which cache/build a request targets: a personalised one if the user
// has saved a non-empty profile, otherwise the shared briefing.
async function resolveTarget(env, u) {
  if (u) {
    const profile = await readJSON(env, profileKey(u));
    if (isCustomised(profile)) {
      return {
        profile, key: `u:${u}`,
        writeKeys: { latest: userBriefKey(u), snapshot: `${userBriefKey(u)}:${londonDate()}` },
      };
    }
  }
  return {
    profile: null, key: "shared",
    writeKeys: { latest: SHARED_KEY, snapshot: `briefing:${londonDate()}` },
  };
}

// ---- external ingest -----------------------------------------------------
// Lets a Claude Code Routine (run on the subscription, not the metered API)
// research the shared feed with its own web search and POST the finished
// briefing here. Dormant unless INGEST_SECRET is set, so deploys are safe
// before the routine exists. See routines/SETUP.md.
const ingestEnabled = env => !!(env.INGEST_SECRET && String(env.INGEST_SECRET).length >= 16);

function timingSafeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ingestAuthed(env, request) {
  const hdr = request.headers.get("authorization") || "";
  const bearer = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7).trim() : "";
  const key = request.headers.get("x-ingest-key") || bearer;
  return ingestEnabled(env) && timingSafeEqual(key, env.INGEST_SECRET);
}

// ---- on-demand refresh: fire the shared-feed routine's API trigger --------
// Claude Code Routines expose a per-routine /fire endpoint (bearer-token auth).
// The shared feed's "Refresh" asks the routine to re-run (subscription-billed,
// its own web search) and POST a fresh briefing to /api/ingest — instead of a
// metered Anthropic API build. Dormant until ROUTINE_FIRE_URL + the secret
// ROUTINE_FIRE_TOKEN are set, so deploys stay safe. See routines/SETUP.md.
const routineFireConfigured = env => !!(env.ROUTINE_FIRE_URL && env.ROUTINE_FIRE_TOKEN);

// Fire the routine's API trigger. opts.text overrides the run instructions (used
// to ask for a personalised build); opts.rateKey gives a separate throttle
// window per target (shared vs each user) so they don't starve each other.
async function fireRoutine(env, opts) {
  opts = opts || {};
  if (!routineFireConfigured(env)) return { ok: false, reason: "not configured" };
  // Protect the routine's daily run cap: at most one fire per window per target.
  const minInterval = Number(env.ROUTINE_FIRE_MIN_SECONDS || 900);
  const nowSec = Math.floor(Date.now() / 1000);
  const rateKey = opts.rateKey || "routine:last_fire";
  if (env.WIRE_KV) {
    const last = Number(await env.WIRE_KV.get(rateKey)) || 0;
    const since = nowSec - last;
    if (last && since < minInterval) return { ok: true, throttled: true, retryInSec: minInterval - since };
  }
  const text = opts.text || `On-demand shared-feed refresh at ${new Date().toISOString()}. Re-run the briefing and POST it to /api/ingest.`;
  let res;
  try {
    res = await fetch(env.ROUTINE_FIRE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ROUTINE_FIRE_TOKEN}`,
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
  } catch (e) { return { ok: false, error: "network error" }; }
  let data = {}; try { data = await res.json(); } catch (_) {}
  if (!res.ok) return { ok: false, error: (data && data.error && data.error.message) || `HTTP ${res.status}` };
  if (env.WIRE_KV) await env.WIRE_KV.put(rateKey, String(nowSec), { expirationTtl: 86400 });
  return { ok: true, fired: true, session: data.claude_code_session_url || null };
}

// Instructions passed to the routine (via /fire `text`) to build ONE user's
// personalised desks and ingest them into that user's feed. The routine prompt
// branches on the "PERSONALISED BUILD REQUEST" marker. See routines/briefing-prompt.md.
function personalisedFireText(uid, profile) {
  const lines = deskList(profile).map(d =>
    `- category=${d.id} | desk="${d.label}"` +
    (d.builtin ? " (built-in)" : ` | topic="${d.topic}"`) +
    ` | types=${(d.types || []).join(",")}`,
  ).join("\n");
  return [
    "PERSONALISED BUILD REQUEST — ignore the shared desk table; build ONLY the desks below for this one user.",
    `userId: ${uid}`,
    "Desks to research (same rules; British English; up to 3 high-signal items each; use the category id exactly):",
    lines,
    `POST the result to $INGEST_URL exactly as usual, but include "userId": "${uid}" in the JSON body alongside "items" so it lands in this user's feed: {"userId":"${uid}","items":[...]}.`,
  ].join("\n");
}

// Trust the desk id supplied per item; assign our own ids and clamp lengths.
function normalizeIngest(items) {
  return (items || [])
    .filter(x => x && x.title && typeof x.category === "string" && x.category.trim())
    .slice(0, 200)
    .map(x => ({
      id: uid(), category: String(x.category).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40),
      title: String(x.title).slice(0, 240),
      summary: x.summary ? String(x.summary).slice(0, 400) : "",
      why: x.why ? String(x.why).slice(0, 400) : "",
      contentType: x.contentType ? String(x.contentType).slice(0, 40) : "News",
      source: x.source ? String(x.source).slice(0, 120) : "",
      url: x.url ? String(x.url).slice(0, 600) : "",
      direction: x.direction || null,
      changePct: x.changePct || null,
    }))
    .filter(x => x.category);
}

// Persist an externally-supplied briefing into the SHARED feed, merging into
// today's running feed exactly like the cron build does.
async function ingestBriefing(env, payload, target) {
  const fresh = normalizeIngest(payload && payload.items);
  const stamp = new Date().toISOString();
  const slot = londonSlot();
  fresh.forEach(it => { it.addedAt = stamp; it.slot = slot; });

  // Default target is the shared feed; a per-user target redirects the write
  // and uses that user's desks (so empty desks still show, with real labels).
  const writeKeys = target && target.latest
    ? { latest: target.latest, snapshot: target.snapshot }
    : { latest: SHARED_KEY, snapshot: `briefing:${londonDate()}` };
  const baseDesks = (target && Array.isArray(target.desks) && target.desks.length)
    ? target.desks.map(d => ({ id: d.id, label: d.label || (CATS[d.id] && CATS[d.id].label) || d.id, builtin: !!d.builtin }))
    : CAT_ORDER.map(id => ({ id, label: CATS[id].label, builtin: true }));
  const labelOf = id => { const b = baseDesks.find(d => d.id === id); return (b && b.label) || (CATS[id] && CATS[id].label) || id; };

  let prior = [];
  const existing = await readJSON(env, writeKeys.latest);
  if (existing && existing.date === londonDate() && Array.isArray(existing.items)) prior = existing.items;
  const items = mergeItems(prior, fresh);

  // Report covers the target's desks (so a desk that came back empty still shows
  // as "quiet") plus any extra categories the routine sent.
  const cats = [...new Set([...baseDesks.map(d => d.id), ...fresh.map(it => it.category)])];
  const report = {};
  for (const id of cats) {
    const n = fresh.filter(it => it.category === id).length;
    report[id] = { n, status: n ? "ok" : "0 stories", label: labelOf(id), builtin: CAT_ORDER.includes(id) };
  }
  const desks = cats.map(id => ({ id, label: labelOf(id), builtin: CAT_ORDER.includes(id) }));
  const fixture = (payload && typeof payload.fixture === "string") ? payload.fixture : null;

  const out = { date: londonDate(), generatedAt: stamp, slot, items, fixture, report, desks, source: "routine" };
  if (env.WIRE_KV) {
    await env.WIRE_KV.put(writeKeys.latest, JSON.stringify(out));
    if (writeKeys.snapshot) await env.WIRE_KV.put(writeKeys.snapshot, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 5 });
  }
  return out;
}

// ---- onboarding: cached desk "pitches" + location desk + live preview ----
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const pitchKey = id => `pitch:${id}`;
const getPitch = (env, id) => readJSON(env, pitchKey(id));
async function putPitch(env, id, pitch) {
  if (env.WIRE_KV) await env.WIRE_KV.put(pitchKey(id), JSON.stringify(pitch), { expirationTtl: 60 * 60 * 30 });
}
const pitchTopic = desk => desk.builtin ? (CATS[desk.id] ? CATS[desk.id].label : desk.label) : (desk.topic || desk.label);

async function fetchPitch(env, desk) {
  const prompt = `Use web search to find the single most interesting, genuinely newsworthy story RIGHT NOW about: "${pitchTopic(desk)}". ${ukRule} Lead with substance over filler; no clickbait. Return ONLY a JSON object: {"title":"the headline","blurb":"<=16 words on why it's worth a look","source":"publication","url":"url"}`;
  for (let a = 0; a < 2; a++) {
    const { text, error } = await callClaude(env, prompt);
    if (error) continue;
    const p = extractJSON(text);
    if (p && p.title) return { title: String(p.title), blurb: p.blurb ? String(p.blurb) : "", source: p.source ? String(p.source) : "", url: p.url ? String(p.url) : "", at: new Date().toISOString() };
  }
  return null;
}
async function fillPitches(env, desks) {
  for (let i = 0; i < desks.length; i += 6) {
    await Promise.all(desks.slice(i, i + 6).map(async d => { const p = await fetchPitch(env, d); if (p) await putPitch(env, d.id, p); }));
  }
}
function catalogueDesks() {
  const out = [];
  CATALOGUE.forEach(g => g.desks.forEach(d => out.push(d)));
  return out;
}
function locationDesk(cf) {
  const city = cf && cf.city ? String(cf.city) : null;
  const region = cf && cf.region ? String(cf.region) : null;
  const country = cf && cf.country ? String(cf.country) : null;
  if (!city && !region) return null;
  const label = city || region;
  const where = [city, region].filter(Boolean).join(", ");
  return { id: "loc-" + slug(label), label: `${label} & local`, location: true,
    topic: `local news for ${where}${country ? ` (${country})` : ""} — councils, transport, community, business and what affects daily life` };
}
async function catalogueResponse(env, request, ctx) {
  const loc = locationDesk(request.cf || {});
  const groups = CATALOGUE.map(g => ({ name: g.name, desks: g.desks.map(d => ({ ...d })) }));
  const all = []; groups.forEach(g => g.desks.forEach(d => all.push(d)));
  if (loc) all.push(loc);
  const missing = [];
  for (const d of all) {
    const p = await getPitch(env, d.id);
    if (p) d.pitch = { title: p.title, blurb: p.blurb, source: p.source, url: p.url };
    else missing.push(d);
  }
  if (missing.length && ctx) ctx.waitUntil(fillPitches(env, missing.slice(0, 10)));
  return { location: loc || null, groups };
}
async function deskPreview(env, topic) {
  topic = String(topic || "").slice(0, 200).trim();
  if (!topic) return null;
  const prompt = `For a personal news app, design a desk dedicated to: "${topic}".
First invent a persona for the desk: a short evocative name, an MBTI type, and a one-line description of its writing voice (a distinctive columnist register). ${ukRule}
Then use web search to fetch ONE current, genuinely newsworthy sample story for this desk, written in that voice.
Return ONLY a JSON object: {"label":"short desk name (<=24 chars)","persona":"Name · MBTI","voice":"one-line voice description","types":["3-6 short content-type tags"],"sample":{"title":"headline","summary":"<=24 words in the desk's voice","why":"why it matters","source":"publication","url":"url"}}`;
  for (let a = 0; a < 2; a++) {
    const { text, error } = await callClaude(env, prompt);
    if (error) continue;
    const p = extractJSON(text);
    if (p && p.label && p.sample) return p;
  }
  return null;
}

// ---- Sign in with Apple (optional; enabled only when configured) ---------
// Pure sign-in: we verify the identity token Apple returns in the form_post,
// so no .p8 / client-secret signing is needed — just the Services ID (aud)
// and a session secret. Profiles get keyed by the stable Apple `sub`.
const appleEnabled = env => !!(env.APPLE_CLIENT_ID && env.SESSION_SECRET);
const appleRedirect = env => env.APPLE_REDIRECT_URI || "https://desk.databased.business/auth/apple/callback";

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4; if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64url(u) {
  let bin = ""; for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const strToB64url = s => bytesToB64url(new TextEncoder().encode(s));
const b64urlToStr = s => new TextDecoder().decode(b64urlToBytes(s));
const randHex = (n = 16) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return [...u].map(b => b.toString(16).padStart(2, "0")).join(""); };

function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  for (const part of c.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1)); }
  return null;
}

// Our own signed token (HMAC-SHA256) for the session cookie and the auth-flow cookie.
async function hmacKey(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(env, obj) {
  const body = strToB64url(JSON.stringify(obj));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body)));
  return body + "." + bytesToB64url(sig);
}
async function verifyToken(env, token) {
  if (!env.SESSION_SECRET || !token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlToBytes(sig), new TextEncoder().encode(body)); } catch (_) { return null; }
  if (!ok) return null;
  let obj; try { obj = JSON.parse(b64urlToStr(body)); } catch (_) { return null; }
  if (obj.exp && Date.now() / 1000 > obj.exp) return null;
  return obj;
}

// Verify Apple's RS256 identity token against Apple's published JWKS.
let _appleKeys = null, _appleKeysAt = 0;
async function appleKeys() {
  if (_appleKeys && Date.now() - _appleKeysAt < 3600_000) return _appleKeys;
  const res = await fetch("https://appleid.apple.com/auth/keys");
  const data = await res.json();
  _appleKeys = data.keys || []; _appleKeysAt = Date.now();
  return _appleKeys;
}
async function verifyAppleIdToken(env, idToken, expectedNonce) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split("."); if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(b64urlToStr(parts[0])); payload = JSON.parse(b64urlToStr(parts[1])); } catch (_) { return null; }
  const jwk = (await appleKeys()).find(k => k.kid === header.kid);
  if (!jwk) return null;
  let key, ok = false;
  try {
    key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch (_) { return null; }
  if (!ok) return null;
  if (payload.iss !== "https://appleid.apple.com") return null;
  if (payload.aud !== env.APPLE_CLIENT_ID) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  if (expectedNonce && payload.nonce !== expectedNonce) return null;
  return payload;
}

// The signed-in user's id (from the session cookie), if any.
async function sessionUid(env, request) {
  const s = await verifyToken(env, getCookie(request, "sess"));
  return s && s.uid ? s.uid : null;
}

// ---- Worker entry points -------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const queryUid = cleanUid(url.searchParams.get("u") || request.headers.get("x-user-id"));
    // A signed-in user's id (from the session cookie) overrides the anonymous one.
    const sUid = await sessionUid(env, request);
    const headerUid = sUid || queryUid;

    // ---- Sign in with Apple endpoints (no-ops unless configured) ----------
    if (url.pathname === "/api/me") {
      const s = await verifyToken(env, getCookie(request, "sess"));
      return json({ appleEnabled: appleEnabled(env), signedIn: !!s, email: (s && s.email) || null, name: (s && s.name) || null });
    }
    if (url.pathname === "/api/profile" && request.method === "GET") {
      const u = headerUid;
      return json({ profile: u ? await readJSON(env, profileKey(u)) : null });
    }
    if (url.pathname === "/auth/apple/login") {
      if (!appleEnabled(env)) return new Response("Sign-in not configured", { status: 404 });
      const u = cleanUid(url.searchParams.get("u")) || "";
      const state = randHex(), nonce = randHex();
      const flow = await signToken(env, { state, nonce, u, exp: Math.floor(Date.now() / 1000) + 600 });
      const p = new URLSearchParams({
        response_type: "code id_token", response_mode: "form_post",
        client_id: env.APPLE_CLIENT_ID, redirect_uri: appleRedirect(env),
        scope: "name email", state, nonce,
      });
      const h = new Headers({ "Location": "https://appleid.apple.com/auth/authorize?" + p.toString() });
      h.append("Set-Cookie", `aflow=${encodeURIComponent(flow)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=600`);
      return new Response(null, { status: 302, headers: h });
    }
    if (url.pathname === "/auth/apple/callback" && request.method === "POST") {
      if (!appleEnabled(env)) return new Response("Sign-in not configured", { status: 404 });
      let form; try { form = await request.formData(); } catch (_) { return new Response("Bad request", { status: 400 }); }
      const flow = await verifyToken(env, getCookie(request, "aflow"));
      if (!flow || flow.state !== form.get("state")) return new Response("Invalid sign-in state", { status: 400 });
      const payload = await verifyAppleIdToken(env, form.get("id_token"), flow.nonce);
      if (!payload || !payload.sub) return new Response("Invalid identity token", { status: 401 });
      const appleUid = "apple:" + payload.sub;
      // First sign-in: link the anonymous profile so swipes/desks carry over.
      if (flow.u && env.WIRE_KV) {
        const existing = await readJSON(env, profileKey(appleUid));
        const anon = await readJSON(env, profileKey(flow.u));
        if (!existing && anon) await env.WIRE_KV.put(profileKey(appleUid), JSON.stringify(anon));
      }
      // Apple sends the user's name only on the FIRST authorisation — capture and
      // persist it so the greeting can use it on later sign-ins too.
      let name = null;
      try { const u = JSON.parse(form.get("user") || "null"); if (u && u.name) name = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ").trim() || null; } catch (_) {}
      if (name && env.WIRE_KV) await env.WIRE_KV.put(`aname:${appleUid}`, JSON.stringify({ name }));
      else { const saved = await readJSON(env, `aname:${appleUid}`); name = (saved && saved.name) || null; }
      const sess = await signToken(env, { uid: appleUid, email: payload.email || null, name, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 });
      const h = new Headers({ "Location": "/" });
      h.append("Set-Cookie", `sess=${encodeURIComponent(sess)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}`);
      h.append("Set-Cookie", `aflow=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`);
      return new Response(null, { status: 302, headers: h });
    }
    if (url.pathname === "/auth/apple/logout") {
      const h = new Headers({ "Location": "/" });
      h.append("Set-Cookie", `sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
      return new Response(null, { status: 302, headers: h });
    }
    // Apple domain-ownership verification file (set APPLE_DOMAIN_ASSOCIATION).
    if (url.pathname === "/.well-known/apple-developer-domain-association.txt" && env.APPLE_DOMAIN_ASSOCIATION) {
      return new Response(env.APPLE_DOMAIN_ASSOCIATION, { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/api/catalogue") {
      try { return json(await catalogueResponse(env, request, ctx)); }
      catch (e) { return json({ error: "catalogue failed", detail: String(e) }, 500); }
    }
    if (url.pathname === "/api/desk-preview" && request.method === "POST") {
      try {
        let body = {}; try { body = await request.json(); } catch (_) {}
        const preview = await deskPreview(env, body.topic);
        if (!preview) return json({ error: "Couldn't build a preview — try rewording the topic." }, 502);
        return json(preview);
      } catch (e) { return json({ error: "preview failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/today") {
      try {
        const t = await resolveTarget(env, headerUid);
        const cached = await readJSON(env, t.writeKeys.latest);
        // A completed build for today is fresh even if it produced zero items
        // (e.g. web search disabled → empty desks). `generatedAt` is only set by
        // a real build; the generating shell leaves it null. Returning it lets
        // the client show the per-desk report instead of spinning forever.
        const useRoutine = String(env.FEED_SOURCE || "").toLowerCase() === "routine";
        const hasItems = !!(cached && cached.items && cached.items.length);
        // A completed build for today is normally fresh even with zero items.
        // But in routine mode a zero-item feed is a stale *failure* (e.g. the old
        // metered-API "credit balance" errors that completed with no stories) —
        // treat it as not-fresh so the routine rebuilds and the errors clear.
        const fresh = cached && cached.date === londonDate() && cached.generatedAt
          && !(useRoutine && !hasItems);
        if (fresh) return json(cached);
        // When the routine owns generation, never trigger a metered API build
        // here. A personalised feed nudges the routine (throttled); the shared
        // feed is populated by the routine's schedule + refresh.
        if (useRoutine && routineFireConfigured(env)) {
          if (t.key !== "shared") {
            ctx.waitUntil(fireRoutine(env, {
              text: personalisedFireText(t.key.slice(2), t.profile),
              rateKey: `routine:last_fire:${t.key}`,
            }));
          }
          return json(hasItems ? { ...cached, generating: true } : generatingShell());
        }
        ctx.waitUntil(startBuild(env, t.key, t.profile, t.writeKeys));
        return json(hasItems ? { ...cached, generating: true } : generatingShell());
      } catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      try {
        let body = {}; try { body = await request.json(); } catch (_) {}
        const t = await resolveTarget(env, sUid || cleanUid(body.userId) || queryUid);
        // When the Claude Routine owns generation, refresh fires its API trigger
        // (subscription-billed) instead of a metered Anthropic API build — for
        // the shared feed AND a signed-in user's personalised desks (the routine
        // is told which desks + which user to build, throttled per target).
        const useRoutine = String(env.FEED_SOURCE || "").toLowerCase() === "routine";
        if (useRoutine && routineFireConfigured(env)) {
          const refresh = t.key === "shared"
            ? await fireRoutine(env, {})
            : await fireRoutine(env, {
                text: personalisedFireText(t.key.slice(2), t.profile),
                rateKey: `routine:last_fire:${t.key}`,
              });
          const cached = await readJSON(env, t.writeKeys.latest);
          return json({ ...(cached || generatingShell()), generating: true, refresh });
        }
        ctx.waitUntil(startBuild(env, t.key, t.profile, t.writeKeys));
        const cached = await readJSON(env, t.writeKeys.latest);
        return json(cached && cached.items?.length ? { ...cached, generating: true } : generatingShell());
      } catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    // A Claude Code Routine POSTs the finished shared briefing here (see
    // routines/SETUP.md). Dormant until INGEST_SECRET is set.
    if (url.pathname === "/api/ingest" && request.method === "POST") {
      if (!ingestEnabled(env)) return json({ error: "ingest not configured" }, 404);
      if (!ingestAuthed(env, request)) return json({ error: "unauthorized" }, 401);
      let body = {}; try { body = await request.json(); } catch (_) { return json({ error: "invalid JSON body" }, 400); }
      if (!Array.isArray(body.items)) return json({ error: "expected { items: [...] }" }, 400);
      try {
        // An optional userId routes the briefing into that user's personalised
        // feed (a routine fired by their refresh); without it, the shared feed.
        // Loose check so signed-in "apple:<sub>" ids (colons/dots) route too.
        const uid = cleanUidLoose(body.userId);
        let target = null;
        if (uid) {
          const profile = await readJSON(env, profileKey(uid));
          target = { latest: userBriefKey(uid), snapshot: `${userBriefKey(uid)}:${londonDate()}`, desks: deskList(profile) };
        }
        const out = await ingestBriefing(env, body, target);
        return json({ ok: true, date: out.date, slot: out.slot, accepted: out.items.length, target: uid ? `user:${uid}` : "shared", report: out.report });
      } catch (e) { return json({ error: "ingest failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/profile" && (request.method === "PUT" || request.method === "POST")) {
      try {
        let body = {}; try { body = await request.json(); } catch (_) {}
        const u = sUid || cleanUid(body.userId);
        if (!u) return json({ error: "missing or invalid userId" }, 400);
        const profile = sanitizeProfile(body.profile);
        if (env.WIRE_KV) await env.WIRE_KV.put(profileKey(u), JSON.stringify(profile));
        // Only regenerate when the desk SET changes (not on every swipe sync).
        if (body.regenerate) {
          const writeKeys = { latest: userBriefKey(u), snapshot: `${userBriefKey(u)}:${londonDate()}` };
          ctx.waitUntil(startBuild(env, `u:${u}`, profile, writeKeys));
          return json({ ok: true, generating: true });
        }
        return json({ ok: true });
      } catch (e) { return json({ error: "profile save failed", detail: String(e) }, 500); }
    }

    // everything else: static assets (index.html etc.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // shared briefing for anonymous visitors — skipped when a Claude Routine
      // owns the shared feed (FEED_SOURCE="routine"), so the cron doesn't
      // overwrite the routine's output with a metered API build.
      const useRoutine = String(env.FEED_SOURCE || "").toLowerCase() === "routine";
      if (!useRoutine) {
        await startBuild(env, "shared", null, { latest: SHARED_KEY, snapshot: `briefing:${londonDate()}` });
      }
      // then each known personalised user
      if (env.WIRE_KV) {
        try {
          const list = await env.WIRE_KV.list({ prefix: "profile:" });
          for (const k of list.keys) {
            const u = k.name.slice("profile:".length);
            const profile = await readJSON(env, profileKey(u));
            if (!isCustomised(profile)) continue;
            await startBuild(env, `u:${u}`, profile, { latest: userBriefKey(u), snapshot: `${userBriefKey(u)}:${londonDate()}` });
          }
        } catch (_) {}
      }
      // Refresh onboarding pitches once a day (morning run only) to bound cost.
      if (londonSlot() === "morning") { try { await fillPitches(env, catalogueDesks()); } catch (_) {} }
    })());
  },
};
