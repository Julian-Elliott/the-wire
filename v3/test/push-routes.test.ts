import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";

const BASE = "https://wire.databased.business";
const db = () => (env as Record<string, any>).DB as D1Database;
const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

describe("Web Push subscription routes", () => {
  it("vapid-public returns the key (or 503 when unset)", async () => {
    const res = await SELF.fetch(`${BASE}/api/push/vapid-public`);
    // The test env doesn't set VAPID_PUBLIC_KEY, so 503 is the correct dormant state.
    expect([200, 503]).toContain(res.status);
  });

  it("subscribe requires a session", async () => {
    const res = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/x", keys: { p256dh: "a", auth: "b" } }),
    });
    expect(res.status).toBe(401);
  });

  it("stores a valid subscription and upserts on the same endpoint", async () => {
    const uid = "apple:push-user";
    const ck = await session(uid);
    const body = (p256dh: string) => JSON.stringify({ endpoint: "https://push.example/abc", keys: { p256dh, auth: "authsecret" } });
    const post = (p256dh: string) => SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", cookie: ck }, body: body(p256dh),
    });
    expect((await post("key1")).status).toBe(200);
    expect((await post("key2")).status).toBe(200); // same endpoint → upsert, not a 2nd row
    const rows = await db().prepare("SELECT p256dh FROM push_subscriptions WHERE user_id = ?1").bind(uid).all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as any).p256dh).toBe("key2");
  });

  it("rejects a non-https endpoint", async () => {
    const res = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", cookie: await session("apple:push-user-2") },
      body: JSON.stringify({ endpoint: "http://insecure/x", keys: { p256dh: "a", auth: "b" } }),
    });
    expect(res.status).toBe(400);
  });

  it("unsubscribe removes the user's subscriptions", async () => {
    const uid = "apple:push-user-3";
    const ck = await session(uid);
    await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST", headers: { "content-type": "application/json", cookie: ck },
      body: JSON.stringify({ endpoint: "https://push.example/z", keys: { p256dh: "k", auth: "a" } }),
    });
    await SELF.fetch(`${BASE}/api/push/unsubscribe`, { method: "POST", headers: { cookie: ck }, body: "{}" });
    const rows = await db().prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ?1").bind(uid).all();
    expect(rows.results).toHaveLength(0);
  });
});
