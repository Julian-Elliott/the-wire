import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../src/lib/auth";

const BASE = "https://wire.databased.business";
const SECRET = "test-session-secret";

const sessionCookie = async (uid: string, name: string | null = null) =>
  "sess=" +
  encodeURIComponent(
    await signToken(SECRET, { uid, name, exp: Math.floor(Date.now() / 1000) + 3600 }),
  );

describe("session tokens", () => {
  it("round-trips and rejects tampering + expiry", async () => {
    const tok = await signToken(SECRET, { uid: "apple:x", exp: Math.floor(Date.now() / 1000) + 60 });
    expect((await verifyToken(SECRET, tok))?.uid).toBe("apple:x");
    expect(await verifyToken(SECRET, tok.slice(0, -2) + "xx")).toBeNull();
    expect(await verifyToken("wrong-secret", tok)).toBeNull();
    const expired = await signToken(SECRET, { uid: "apple:x", exp: Math.floor(Date.now() / 1000) - 1 });
    expect(await verifyToken(SECRET, expired)).toBeNull();
  });
});

describe("GET /auth/apple/login", () => {
  it("redirects to Apple with form_post + state/nonce and sets the flow cookie", async () => {
    const res = await SELF.fetch(`${BASE}/auth/apple/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.hostname).toBe("appleid.apple.com");
    expect(loc.searchParams.get("response_mode")).toBe("form_post");
    expect(loc.searchParams.get("client_id")).toBe("test.services.id");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("aflow=");
    expect(res.headers.get("set-cookie")).toContain("SameSite=None");
  });
});

describe("POST /auth/apple/callback", () => {
  it("rejects a state mismatch", async () => {
    const flow = await signToken(SECRET, { state: "real", nonce: "n", exp: Math.floor(Date.now() / 1000) + 600 });
    const form = new FormData();
    form.set("state", "forged");
    form.set("id_token", "junk");
    const res = await SELF.fetch(`${BASE}/auth/apple/callback`, {
      method: "POST",
      headers: { cookie: `aflow=${encodeURIComponent(flow)}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });
  it("rejects a garbage identity token even with valid state", async () => {
    const flow = await signToken(SECRET, { state: "s1", nonce: "n1", exp: Math.floor(Date.now() / 1000) + 600 });
    const form = new FormData();
    form.set("state", "s1");
    form.set("id_token", "not.a.jwt");
    const res = await SELF.fetch(`${BASE}/auth/apple/callback`, {
      method: "POST",
      headers: { cookie: `aflow=${encodeURIComponent(flow)}` },
      body: form,
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/apple/events", () => {
  it("rejects unsigned/garbage payloads", async () => {
    const res = await SELF.fetch(`${BASE}/auth/apple/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "not.a.jwt" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("session revocation (timestamp-based)", () => {
  const kv = () => (env as Record<string, any>).KV as KVNamespace;

  it("a session issued BEFORE the revocation dies; a later re-auth survives", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldCookie =
      "sess=" + encodeURIComponent(await signToken(SECRET, { uid: "apple:rev1", iat: now - 100, exp: now + 3600 }));
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: oldCookie } })).status).toBe(200);

    // Apple revokes now: the pre-existing session must stop working.
    await kv().put("revoked:apple:rev1", String(now));
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: oldCookie } })).status).toBe(401);

    // The user re-authorises: a fresh session (iat after the revocation) works
    // again with no key deletion — the permanent-lockout bug is fixed.
    const freshCookie =
      "sess=" + encodeURIComponent(await signToken(SECRET, { uid: "apple:rev1", iat: now + 10, exp: now + 3600 }));
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: freshCookie } })).status).toBe(200);
  });
});

describe("malformed cookies never 500 (review fix)", () => {
  it("a broken percent-escape is treated as no session, not a crash", async () => {
    const res = await SELF.fetch(`${BASE}/api/me`, { headers: { cookie: "sess=%zz%" } });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me", () => {
  it("401s anonymously; identifies a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/me`)).status).toBe(401);
    const res = await SELF.fetch(`${BASE}/api/me`, {
      headers: { cookie: await sessionCookie("apple:me-test", "Julian") },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.uid).toBe("apple:me-test");
    expect(b.name).toBe("Julian");
  });
});

describe("POST /api/read", () => {
  it("requires a session and writes canonical ledger keys", async () => {
    const anon = await SELF.fetch(`${BASE}/api/read`, { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);

    const cookie = await sessionCookie("apple:read-test");
    const res = await SELF.fetch(`${BASE}/api/read`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.example.com/story?utm_source=x",
        desk: "world",
        title: "A story I read",
        state: "read",
      }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.key).toBe("u:https://example.com/story"); // canonical, utm stripped

    // Upsert: dismissing later overwrites the state, not a second row.
    await SELF.fetch(`${BASE}/api/read`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/story", state: "dismissed" }),
    });
    const rows = await ((env as Record<string, any>).DB as D1Database)
      .prepare("SELECT state FROM read_ledger WHERE user_id = 'apple:read-test'")
      .all();
    expect(rows.results).toHaveLength(1);
    expect((rows.results[0] as Record<string, unknown>).state).toBe("dismissed");
  });

  it("rejects junk states", async () => {
    const res = await SELF.fetch(`${BASE}/api/read`, {
      method: "POST",
      headers: { cookie: await sessionCookie("apple:read-test-2"), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/x", state: "hidden" }),
    });
    expect(res.status).toBe(400);
  });
});
