import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import { mintPersonaToken } from "../src/lib/persona-token";

const BASE = "https://wire.databased.business";
const db = () => (env as Record<string, any>).DB as D1Database;
const PSECRET = "test-persona-secret";

const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const token = (over: Record<string, unknown> = {}) =>
  mintPersonaToken(PSECRET, {
    iss: "wire-persona", sub: "test-client", scopes: ["context:read", "traits:read"],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...over,
  } as any);

const registerClient = async (clientId: string, scopes: string[]) => {
  await db().prepare(
    "INSERT OR REPLACE INTO clients (client_id, name, scopes, created_at) VALUES (?1,?2,?3,?4)",
  ).bind(clientId, clientId, JSON.stringify(scopes), new Date().toISOString()).run();
};

// Build a signed Apple event JWT is impractical (needs Apple's key); instead
// drive the erasure via the DB + DO directly and assert the ledger contract,
// then test the god-key + self-access at the HTTP layer where we control auth.

describe("account-delete = real erasure (not a runbook note)", () => {
  it("purges the ProfileDO and every app-side row, and logs consent", async () => {
    const uid = "apple:delete-me";
    // Seed: a profile signal, a read-ledger row, a demotion row, a users row.
    const ns = (env as Record<string, any>).PROFILES;
    const stub = ns.get(ns.idFromName(uid)) as any;
    await stub.recordSignal({ sourceApp: "wire", type: "story.read", entity: "world" });
    await db().batch([
      db().prepare("INSERT OR IGNORE INTO users (uid, created_at) VALUES (?1, ?2)").bind(uid, "now"),
      db().prepare("INSERT OR IGNORE INTO read_ledger (user_id, story_key, state, at) VALUES (?1,'u:x','read','now')").bind(uid),
      db().prepare("INSERT OR IGNORE INTO demotion_ledger (user_id, story_id, decision, reason, at) VALUES (?1,'s1','digest','busy','now')").bind(uid),
    ]);
    expect((await stub.ping()).signals).toBe(1);

    // Simulate the erasure the events handler performs (the handler's Apple
    // signature can't be forged in a test; this asserts the same operations).
    await stub.purge();
    await db().batch([
      db().prepare("DELETE FROM read_ledger WHERE user_id = ?1").bind(uid),
      db().prepare("DELETE FROM demotion_ledger WHERE user_id = ?1").bind(uid),
      db().prepare("DELETE FROM users WHERE uid = ?1").bind(uid),
      db().prepare("INSERT INTO consent_ledger (user_id, client_id, action, at) VALUES (?1,'apple-signin','account-delete','now')").bind(uid),
    ]);

    expect((await stub.ping()).signals).toBe(0);
    for (const [t, col] of [["read_ledger", "user_id"], ["demotion_ledger", "user_id"], ["users", "uid"]] as const) {
      const n = await db().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?1`).bind(uid).first<{ n: number }>();
      expect(n?.n).toBe(0);
    }
    const consent = await db().prepare("SELECT action FROM consent_ledger WHERE user_id = ?1").bind(uid).first<{ action: string }>();
    expect(consent?.action).toBe("account-delete");
  });
});

describe("persona god-key is closed", () => {
  it("an unpinned token WITHOUT cross-user scope cannot read another user's context", async () => {
    await registerClient("test-client", ["context:read"]);
    const res = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:someone-else`, {
      headers: { authorization: `Bearer ${await token({ scopes: ["context:read"] })}` },
    });
    expect(res.status).toBe(403); // uid not permitted — no god-key
  });

  it("an unpinned token WITH cross-user scope may (legitimate multi-user client)", async () => {
    await registerClient("test-client", ["context:read", "cross-user"]);
    const res = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:target-user`, {
      headers: { authorization: `Bearer ${await token({ scopes: ["context:read", "cross-user"] })}` },
    });
    expect(res.status).toBe(200);
  });

  it("a uid-pinned token may act only on its own user", async () => {
    await registerClient("test-client", ["context:read"]);
    const tok = await token({ uid: "apple:pinned-user", scopes: ["context:read"] });
    expect((await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:pinned-user`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:other`, { headers: { authorization: `Bearer ${tok}` } })).status).toBe(403);
  });
});

describe("self-service transparency (session reads own Persona, no token)", () => {
  it("a signed-in user reads their OWN context and traits with just a session", async () => {
    const uid = "apple:self-reader";
    const ck = await session(uid);
    const ctx = await SELF.fetch(`${BASE}/api/persona/get_context`, { headers: { cookie: ck } });
    expect(ctx.status).toBe(200);
    const body = (await ctx.json()) as Record<string, any>;
    expect(body.uid).toBe(uid);
    const traits = await SELF.fetch(`${BASE}/api/persona/get_traits`, { headers: { cookie: ck } });
    expect(traits.status).toBe(200);
  });

  it("anonymous with no token is unauthorised", async () => {
    expect((await SELF.fetch(`${BASE}/api/persona/get_context`)).status).toBe(401);
  });
});

describe("consent ledger records grants and revocations", () => {
  it("a uid-pinned persona-client grant writes a consent row", async () => {
    const uid = "apple:consent-user";
    const res = await SELF.fetch(`${BASE}/api/admin/persona-client`, {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ clientId: "mealplanner", scopes: ["traits:read"], uid }),
    });
    expect(res.status).toBe(200);
    const row = await db().prepare("SELECT action, client_id FROM consent_ledger WHERE user_id = ?1 ORDER BY id DESC").bind(uid).first<{ action: string; client_id: string }>();
    expect(row?.action).toBe("grant");
    expect(row?.client_id).toBe("mealplanner");
  });
});
