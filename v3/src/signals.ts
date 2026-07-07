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
import { pollPlanit } from "./lib/signals/planit";
import type { PollerResult, Trigger } from "./lib/signals/types";
import { pollWeather } from "./lib/signals/weather";

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

// Trigger → newsroom story (via the SAME validated ingest path is overkill for
// first-party triggers; they're already trustworthy, so we write directly to
// NewsroomDO with content-addressed ids). Idempotent on the dedup key.
async function persistTriggers(env: Env, triggers: Trigger[]): Promise<number> {
  if (!triggers.length) return 0;
  const nowIso = new Date().toISOString();
  const rows = await Promise.all(
    triggers.map(async (t) => {
      const idBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t.dedupKey));
      const story_id = [...new Uint8Array(idBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return {
        story_id,
        embedding: null,
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

// Route a priority-3 trigger to each active user through their gate.
async function routeInterrupts(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  triggers: Trigger[],
): Promise<{ pushed: number; heldToDigest: number }> {
  const p3 = triggers.filter((t) => t.priority === 3);
  if (!p3.length || !env.NTFY_TOPIC) return { pushed: 0, heldToDigest: 0 };
  const users = await env.DB.prepare("SELECT uid FROM users").all<{ uid: string }>();
  let pushed = 0;
  let heldToDigest = 0;
  for (const t of p3) {
    for (const { uid } of users.results) {
      const stub = env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
        isInterruptible(priority: 1 | 2 | 3): Promise<{ decision: string; reason: string }>;
      };
      const verdict = await stub.isInterruptible(3);
      if (verdict.decision === "interrupt") {
        // Poor-man's APNs: the interrupt carries its trust-UX "why".
        ctx.waitUntil(
          fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
            method: "POST",
            headers: { Title: t.title, Priority: "urgent", Tags: "rotating_light" },
            body: `${t.summary}\n\nwhy: ${t.why}`,
          }).catch(() => {}),
        );
        pushed++;
      } else {
        heldToDigest++;
      }
    }
  }
  return { pushed, heldToDigest };
}

export async function runSignals(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  opts?: { testInterrupt?: boolean },
): Promise<Record<string, unknown>> {
  const fetcher = (u: string, i?: RequestInit) => fetch(u, i);
  const lat = Number(env.SIGNALS_LAT ?? DEFAULT_LAT);
  const lon = Number(env.SIGNALS_LON ?? DEFAULT_LON);

  const settled = await Promise.allSettled<PollerResult>([
    pollWeather({ lat, lon, place: "home", weatherkit: weatherkitCreds(env) }, fetcher),
    pollOctopus(fetcher),
    pollCarbon(fetcher),
    pollPlanit({ lat, lon }, fetcher),
  ]);

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
  const names = ["weather", "octopus", "carbon", "planit"];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      backends[names[i]] = s.value.backend;
      triggers.push(...s.value.triggers);
    } else {
      failures.push(`${names[i]}: ${String(s.reason).slice(0, 80)}`);
    }
  });

  const inserted = await persistTriggers(env, triggers);
  const routed = await routeInterrupts(env, ctx, [...triggers, ...testTriggers]);

  const heartbeats = JSON.parse((await env.KV.get("hb:crons")) ?? "{}");
  heartbeats["signals"] = new Date().toISOString();
  await env.KV.put("hb:crons", JSON.stringify(heartbeats));

  return { backends, triggers: triggers.length, inserted, ...routed, failures };
}
