// Signals orchestration (V3_BLUEPRINT §7 + the interrupt tier §5). A cron
// polls the UK sources, turns each Trigger into a newsroom story (so the
// digest tier catches everything), and routes priority-3 triggers through
// the ProfileDO trust-ladder gate to a push — today via ntfy, the poor-man's
// APNs that proves the whole respectful-interruption thesis with zero iOS.
//
// Location: shared sources (weather/energy/carbon) poll one operator area;
// per-user planning uses each user's own lat/lon from their v2config
// (home area). No coordinates are ever stored server-side beyond config the
// user supplied.

import type { Env } from "./env";
import { pollCarbon, pollOctopus } from "./lib/signals/energy";
import { pollFloods } from "./lib/signals/floods";
import { pollPlanit } from "./lib/signals/planit";
import type { Fetcher, PollerResult, Trigger } from "./lib/signals/types";
import { pollWeather } from "./lib/signals/weather";
import { sendWebPush } from "./lib/webpush";

// Operator/default area (Worcester) for shared sources until per-user areas
// drive them. Overridable via vars.
const DEFAULT_LAT = 52.192;
const DEFAULT_LON = -2.22;

function weatherkitCreds(env: Env) {
  return env.WEATHERKIT_PRIVATE_KEY && env.WEATHERKIT_KEY_ID && env.APPLE_TEAM_ID && env.WEATHERKIT_APP_ID
    ? {
        p8: env.WEATHERKIT_PRIVATE_KEY,
        keyId: env.WEATHERKIT_KEY_ID,
        teamId: env.APPLE_TEAM_ID,
        appId: env.WEATHERKIT_APP_ID,
      }
    : undefined;
}

// Content-address a trigger's story id from its dedup key — the SAME id
// persistTriggers writes, so demotion-ledger rows join the feed by story id.
async function storyIdOf(dedupKey: string): Promise<string> {
  const idBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dedupKey));
  return [...new Uint8Array(idBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Trigger → newsroom story (via the SAME validated ingest path is overkill for
// first-party triggers; they're already trustworthy, so we write directly to
// NewsroomDO with content-addressed ids). Idempotent on the dedup key.
async function persistTriggers(env: Env, triggers: Trigger[]): Promise<number> {
  if (!triggers.length) return 0;
  const nowIso = new Date().toISOString();
  const rows = await Promise.all(
    triggers.map(async (t) => {
      const story_id = await storyIdOf(t.dedupKey);
      return {
        story_id,
        embedding: null,
        audience: t.audience ?? null,
        desk: t.desk,
        title: t.title,
        summary: t.summary,
        why: t.why,
        url: t.url,
        canon_url: t.url.toLowerCase(),
        title_key: `t:${t.desk}|${t.title.toLowerCase()}`,
        sources: [t.source],
        salience: t.priority === 3 ? 90 : t.priority === 2 ? 55 : 30,
        priority: t.priority,
        published_at: null,
        quote: null,
        editorial_read: null,
        added_at: nowIso,
      };
    }),
  );
  const stub = env.NEWSROOM.get(env.NEWSROOM.idFromName("main")) as unknown as {
    ingestBatch(rows: unknown[]): Promise<{ inserted: number }>;
  };
  return (await stub.ingestBatch(rows)).inserted;
}

export type PushFn = (t: Trigger) => Promise<unknown>;

// Poor-man's APNs: the interrupt carries its trust-UX "why".
const ntfyPush = (topic: string): PushFn => (t) =>
  fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: { Title: t.title, Priority: "urgent", Tags: "rotating_light" },
    body: `${t.summary}\n\nwhy: ${t.why}`,
  }).catch(() => {});

const vapidKeys = (env: Env) =>
  env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privatePkcs8: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? "mailto:ops@databased.business" }
    : null;

// Deliver a trigger to ONE user's browser subscriptions (Web Push). Prunes
// subscriptions the push service reports as gone (404/410). Never throws.
async function deliverWebPush(env: Env, uid: string, t: Trigger): Promise<number> {
  const vapid = vapidKeys(env);
  if (!vapid) return 0;
  const subs = await env.DB
    .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1")
    .bind(uid)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  if (!subs.results.length) return 0;
  const payload = JSON.stringify({ title: t.title, body: t.summary, why: t.why, url: t.url, gentle: (t as { gentle?: boolean }).gentle || undefined });
  let sent = 0;
  for (const s of subs.results) {
    try {
      const r = await sendWebPush(s, payload, vapid);
      if (r.ok) sent++;
      else if (r.gone) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2").bind(uid, s.endpoint).run();
      }
    } catch { /* one bad endpoint never blocks the rest */ }
  }
  return sent;
}

// Route a priority-3 trigger to each active user through their gate. Every
// demotion is WRITTEN DOWN (V3_BLUEPRINT §5 trust UX): the reader shows a
// "why demoted" note, never a silent drop — including when no push channel
// is configured at all (honest degradation over fudged parity). A story
// that later passes the gate clears its demotion row: it was delivered.
// Synthetic test triggers are routed but never persisted (no feed row for
// a ledger row to join). `push` is injectable for tests; default is ntfy.
export async function routeInterrupts(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  triggers: Trigger[],
  push?: PushFn,
): Promise<{ pushed: number; heldToDigest: number }> {
  const p3 = triggers.filter((t) => t.priority === 3);
  if (!p3.length) return { pushed: 0, heldToDigest: 0 };
  const users = await env.DB.prepare("SELECT uid FROM users").all<{ uid: string }>();
  if (!users.results.length) return { pushed: 0, heldToDigest: 0 };
  // Test channel (injected) delivers to any user; in production a user's
  // personal channel is their OWN Web Push subscription. ntfy is a separate
  // OPERATOR ops signal (Julian watches the whole system) — never a user's
  // delivery channel, so it can't make a subscription-less user look reached.
  const injected = push;
  const opsNtfy = env.NTFY_TOPIC ? ntfyPush(env.NTFY_TOPIC) : undefined;
  const pushUsers = new Set(
    (await env.DB.prepare("SELECT DISTINCT user_id FROM push_subscriptions").all<{ user_id: string }>())
      .results.map((r) => r.user_id),
  );
  const nowIso = new Date().toISOString();
  const ledger: D1PreparedStatement[] = [];
  let pushed = 0;
  let heldToDigest = 0;
  for (const t of p3) {
    const storyId = t.source === "test" ? null : await storyIdOf(t.dedupKey);
    let opsFired = false; // operator ntfy fires at most once per trigger
    // An audience-scoped trigger is one user's business only — never fan
    // it out to the whole user table.
    const targets = t.audience
      ? users.results.filter((u) => u.uid === t.audience)
      : users.results;
    for (const { uid } of targets) {
      const stub = env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
        isInterruptible(priority: 1 | 2 | 3): Promise<{ decision: string; reason: string }>;
      };
      let verdict = await stub.isInterruptible(3);
      // Honest per-user channel check: no subscription = no interrupt (the
      // story still tops their ranked feed and shows this note in the digest).
      const personalChannel = !!injected || pushUsers.has(uid);
      if (verdict.decision === "interrupt" && !personalChannel) {
        verdict = { decision: "digest", reason: "turn on 🔔 alerts to be interrupted — for now it's in your digest" };
      }
      if (verdict.decision === "interrupt") {
        // Contain transport failures here so an unhandled rejection never
        // takes down the cron run.
        if (injected) ctx.waitUntil(Promise.resolve().then(() => injected(t)).catch(() => {}));
        else ctx.waitUntil(deliverWebPush(env, uid, t).catch(() => 0));
        if (opsNtfy && !injected && !opsFired) {
          ctx.waitUntil(Promise.resolve().then(() => opsNtfy(t)).catch(() => {}));
          opsFired = true;
        }
        pushed++;
        if (storyId) {
          ledger.push(
            env.DB.prepare("DELETE FROM demotion_ledger WHERE user_id = ?1 AND story_id = ?2")
              .bind(uid, storyId),
          );
        }
      } else {
        heldToDigest++;
        // First reason wins (DO NOTHING): "why wasn't I interrupted when
        // this landed" is the honest answer, not the latest state.
        if (storyId) {
          ledger.push(
            env.DB.prepare(
              `INSERT INTO demotion_ledger (user_id, story_id, decision, reason, at)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(user_id, story_id) DO NOTHING`,
            ).bind(uid, storyId, verdict.decision === "silent" ? "silent" : "digest", verdict.reason, nowIso),
          );
        }
      }
    }
  }
  if (ledger.length) await env.DB.batch(ledger);
  return { pushed, heldToDigest };
}

// Gentle scope-nudge (Wave B want/need) — a STRICTLY LOWER, quieter rung than
// routeInterrupts, OFF by default. Over p2 AUDIENCE triggers ONLY (a serious
// development in the user's OWN area — one uid, zero fan-out). Only fires if the
// user opted in (getScopeNudge); the gate (isInterruptible(2,{scopeNudge})) is
// narrower than p3 (open-only, ≤1/20h, asleep held); the payload is SILENT;
// every non-delivery is written to the demotion ledger exactly like p3. Never
// touches routeInterrupts or the p3 path.
export async function routeNudges(
  env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, triggers: Trigger[],
): Promise<{ nudged: number; heldToDigest: number }> {
  const cand = triggers.filter((t) => t.priority === 2 && !!t.audience);
  if (!cand.length) return { nudged: 0, heldToDigest: 0 };
  const vapid = vapidKeys(env);
  const nowIso = new Date().toISOString();
  const ledger: D1PreparedStatement[] = [];
  let nudged = 0, heldToDigest = 0;
  for (const t of cand) {
    const uid = t.audience!;
    const stub = env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
      getScopeNudge(): Promise<boolean>;
      isInterruptible(p: 1 | 2 | 3, nowMs?: number, opts?: { scopeNudge?: boolean }): Promise<{ decision: string; reason: string }>;
      markNudged(nowMs?: number): Promise<void>;
    };
    if (!(await stub.getScopeNudge())) continue; // dormant: no opt-in ⇒ zero cost, no ledger noise
    const storyId = await storyIdOf(t.dedupKey);
    let verdict = await stub.isInterruptible(2, Date.now(), { scopeNudge: true });
    const hasSub = !!vapid && (await env.DB.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ?1 LIMIT 1").bind(uid).first()) != null;
    if (verdict.decision === "interrupt" && !hasSub) {
      verdict = { decision: "digest", reason: "turn on 🔔 alerts for a gentle heads-up — for now it's in your feed" };
    }
    if (verdict.decision === "interrupt") {
      ctx.waitUntil(deliverWebPush(env, uid, { ...t, gentle: true } as Trigger & { gentle: true }).catch(() => 0));
      await stub.markNudged(); // enforce the ≤1/20h ceiling across cron runs
      nudged++;
      ledger.push(env.DB.prepare("DELETE FROM demotion_ledger WHERE user_id = ?1 AND story_id = ?2").bind(uid, storyId));
    } else {
      heldToDigest++;
      ledger.push(env.DB.prepare(
        `INSERT INTO demotion_ledger (user_id, story_id, decision, reason, at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(user_id, story_id) DO NOTHING`,
      ).bind(uid, storyId, verdict.decision === "silent" ? "silent" : "digest", verdict.reason, nowIso));
    }
  }
  if (ledger.length) await env.DB.batch(ledger);
  return { nudged, heldToDigest };
}

// Planning polls, one polite radius query per DISTINCT user home area
// (V3_BLUEPRINT §7: "planning app 250 m from home" means THEIR home).
// Users sharing a rounded area share one query; each user still gets their
// own uid-salted, audience-scoped triggers so nothing leaks into the
// global feed. Falls back to a single global operator-area poll only while
// no user has set an area (the pre-per-user behaviour, unchanged).
// One radius query per DISTINCT user home area; users sharing a rounded area
// share the query, and each gets their OWN uid-salted audience-scoped triggers
// so nothing leaks into the global feed. Shared by planning + flood pollers.
async function userAreas(env: Env): Promise<Map<string, { lat: number; lon: number; uids: string[] }>> {
  const users = await env.DB.prepare("SELECT uid FROM users").all<{ uid: string }>();
  const byArea = new Map<string, { lat: number; lon: number; uids: string[] }>();
  for (const { uid } of users.results.slice(0, 50)) {
    const stub = env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
      getHomeArea(): Promise<{ lat: number; lon: number } | null>;
    };
    const area = await stub.getHomeArea().catch(() => null);
    if (!area) continue;
    const key = `${area.lat},${area.lon}`;
    const cur = byArea.get(key) ?? { lat: area.lat, lon: area.lon, uids: [] };
    cur.uids.push(uid);
    byArea.set(key, cur);
  }
  return byArea;
}

// Turn a per-area poll into per-user audience-scoped tasks (uid-salted dedup).
const perUserAreaTasks = (
  byArea: Map<string, { lat: number; lon: number; uids: string[] }>,
  poll: (a: { lat: number; lon: number }) => Promise<PollerResult>,
) =>
  [...byArea.values()].slice(0, 20).map((a) => async (): Promise<PollerResult> => {
    const res = await poll({ lat: a.lat, lon: a.lon });
    return {
      backend: res.backend,
      triggers: a.uids.flatMap((uid) =>
        res.triggers.map((t) => ({ ...t, audience: uid, dedupKey: `${uid}:${t.dedupKey}` })),
      ),
    };
  });

async function planningTasks(
  env: Env,
  fetcher: Fetcher,
  fallback: { lat: number; lon: number },
): Promise<Array<() => Promise<PollerResult>>> {
  const byArea = await userAreas(env);
  if (!byArea.size) return [() => pollPlanit(fallback, fetcher)];
  return perUserAreaTasks(byArea, (a) => pollPlanit(a, fetcher));
}

// Flood warnings are inherently local — NO global fallback (a flood 15 km from
// the operator is irrelevant to a user elsewhere), so only per-user areas poll.
async function floodTasks(env: Env, fetcher: Fetcher): Promise<Array<() => Promise<PollerResult>>> {
  const byArea = await userAreas(env);
  if (!byArea.size) return [];
  return perUserAreaTasks(byArea, (a) => pollFloods(a, fetcher));
}

export async function runSignals(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  opts?: { testInterrupt?: boolean },
): Promise<Record<string, unknown>> {
  const fetcher = (u: string, i?: RequestInit) => fetch(u, i);
  const lat = Number(env.SIGNALS_LAT ?? DEFAULT_LAT);
  const lon = Number(env.SIGNALS_LON ?? DEFAULT_LON);

  const tasks: Array<{ name: string; run: () => Promise<PollerResult> }> = [
    { name: "weather", run: () => pollWeather({ lat, lon, place: "home", weatherkit: weatherkitCreds(env) }, fetcher) },
    { name: "octopus", run: () => pollOctopus(fetcher) },
    { name: "carbon", run: () => pollCarbon(fetcher) },
    ...(await planningTasks(env, fetcher, { lat, lon })).map((run, i) => ({
      name: i === 0 ? "planit" : `planit:${i + 1}`,
      run,
    })),
    ...(await floodTasks(env, fetcher)).map((run, i) => ({
      name: i === 0 ? "floods" : `floods:${i + 1}`,
      run,
    })),
  ];
  const settled = await Promise.allSettled<PollerResult>(tasks.map((t) => t.run()));

  const triggers: Trigger[] = [];
  // A one-off synthetic priority-3 to prove the gate→push chain end to end
  // (labelled; never persisted to the feed, only routed).
  const testTriggers: Trigger[] = opts?.testInterrupt
    ? [{
        source: "test", desk: "weather",
        dedupKey: `test:${Date.now()}`,
        title: "TEST: severe weather warning",
        summary: "This is a test of The Wire's interrupt tier — if it reached your phone, the gate let it through.",
        why: "manual interrupt-tier test",
        url: "https://wire.databased.business",
        priority: 3, expiresHours: 1,
      }]
    : [];
  const backends: Record<string, string> = {};
  const failures: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      backends[tasks[i].name] = s.value.backend;
      triggers.push(...s.value.triggers);
    } else {
      failures.push(`${tasks[i].name}: ${String(s.reason).slice(0, 80)}`);
    }
  });

  const inserted = await persistTriggers(env, triggers);
  const routed = await routeInterrupts(env, ctx, [...triggers, ...testTriggers]);
  // Dormant gentle nudge (Wave B): p2 audience triggers already persisted above,
  // so a nudged story joins the feed + ledger exactly like a p3. No-op unless a
  // user opted in.
  const nudged = await routeNudges(env, ctx, triggers);

  const heartbeats = JSON.parse((await env.KV.get("hb:crons")) ?? "{}");
  heartbeats["signals"] = new Date().toISOString();
  await env.KV.put("hb:crons", JSON.stringify(heartbeats));

  return { backends, triggers: triggers.length, inserted, ...routed, nudges: nudged.nudged, failures };
}
