import { Hono } from "hono";
import { REQUIRED_BINDINGS, type Env } from "./env";

export { NewsroomDO } from "./newsroom";
export { ProfileDO } from "./profile";

const app = new Hono<{ Bindings: Env }>();

// Boot verification (V3_BLUEPRINT §9): fail loudly, not silently, on any
// missing binding. Runs once per isolate via lazy memoisation.
let bootChecked = false;
app.use("*", async (c, next) => {
  if (!bootChecked) {
    const missing = REQUIRED_BINDINGS.filter((k) => !(k in c.env) || c.env[k] == null);
    if (missing.length) {
      return c.json({ ok: false, error: `missing bindings: ${missing.join(", ")}` }, 500);
    }
    bootChecked = true;
  }
  await next();
});

type Probe = "ok" | "fail" | "timeout";

async function probe(fn: () => Promise<unknown>, ms = 500): Promise<Probe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("__timeout__")), ms);
      }),
    ]);
    return "ok";
  } catch (e) {
    return e instanceof Error && e.message === "__timeout__" ? "timeout" : "fail";
  } finally {
    clearTimeout(timer ?? null);
  }
}

// Health contract (RUNBOOK §3): single JSON, 503 if any store check is red.
// Fields land as their features do — null means "not applicable yet",
// never "unknown but fine".
app.get("/api/health", async (c) => {
  const [kv, d1, r2] = await Promise.all([
    probe(() => c.env.KV.get("hb:ingest")),
    probe(() => c.env.DB.prepare("SELECT 1").first()),
    probe(() => c.env.BACKUPS.head("health-probe")),
  ]);

  const lastIngest = kv === "ok" ? await c.env.KV.get("hb:ingest") : null;
  const cronHeartbeats =
    kv === "ok" ? JSON.parse((await c.env.KV.get("hb:crons")) ?? "{}") : {};

  const ok = kv === "ok" && d1 === "ok" && r2 === "ok";
  return c.json(
    {
      ok,
      version: c.env.CF_VERSION_METADATA?.id ?? "dev",
      checks: { kv, d1, r2 },
      last_ingest: lastIngest,
      newest_story_age_h: null, // wired to NewsroomDO.stats() once ingest lands
      crons: cronHeartbeats,
      audio_spend_mtd_gbp: null, // wired with the audio pipeline (Phase 3)
      audio_cap_pct: null,
    },
    ok ? 200 : 503,
  );
});

app.get("/", (c) =>
  c.json({
    service: "wire-api",
    status: "under construction — The Wire v3 foundation",
    blueprint: "https://github.com/Julian-Elliott/the-wire/blob/main/docs/V3_BLUEPRINT.md",
  }),
);

app.notFound((c) => c.json({ ok: false, error: "not found" }, 404));

export default app;
