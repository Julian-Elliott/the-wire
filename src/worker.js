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

// ---- Worker entry points -------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const headerUid = cleanUid(url.searchParams.get("u") || request.headers.get("x-user-id"));

    if (url.pathname === "/api/today") {
      try {
        const t = await resolveTarget(env, headerUid);
        const cached = await readJSON(env, t.writeKeys.latest);
        if (cached && cached.date === londonDate() && cached.items?.length) return json(cached);
        ctx.waitUntil(startBuild(env, t.key, t.profile, t.writeKeys));
        return json(cached && cached.items?.length ? { ...cached, generating: true } : generatingShell());
      } catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      try {
        let body = {}; try { body = await request.json(); } catch (_) {}
        const t = await resolveTarget(env, cleanUid(body.userId) || headerUid);
        ctx.waitUntil(startBuild(env, t.key, t.profile, t.writeKeys));
        const cached = await readJSON(env, t.writeKeys.latest);
        return json(cached && cached.items?.length ? { ...cached, generating: true } : generatingShell());
      } catch (e) { return json({ error: "generation failed", detail: String(e) }, 500); }
    }

    if (url.pathname === "/api/profile" && (request.method === "PUT" || request.method === "POST")) {
      try {
        let body = {}; try { body = await request.json(); } catch (_) {}
        const u = cleanUid(body.userId);
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
      // shared briefing for anonymous visitors
      await startBuild(env, "shared", null, { latest: SHARED_KEY, snapshot: `briefing:${londonDate()}` });
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
    })());
  },
};
