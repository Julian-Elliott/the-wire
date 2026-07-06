import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://wire.databased.business";

const post = (path: string, body: unknown, secret = "test-secret") =>
  SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

describe("POST /api/admin/import-profile", () => {
  it("rejects bad auth and bad uids", async () => {
    expect((await post("/api/admin/import-profile", { uid: "apple:x" }, "nope")).status).toBe(401);
    const bad = await post("/api/admin/import-profile", { uid: "../etc" });
    expect(bad.status).toBe(400);
  });

  it("imports config, name, weight traits and seen records", async () => {
    const uid = "apple:migr-test-1";
    const res = await post("/api/admin/import-profile", {
      uid,
      name: "Julian",
      config: { desks: { enabled: ["world", "liverpool"] }, notes: "no crypto", window: "48h" },
      traits: [
        { key: "desk.weight.liverpool", value: 3 },
        { key: "desk.weight.world", value: 1 },
        { key: "not.a.desk.weight", value: 9 }, // ignored: wrong prefix
      ],
      seen: [
        { c: "world", t: "A story we already served", u: "https://example.com/served?utm_source=x", at: 1751500000 },
        { c: "world", t: "Another served story with no url", at: 1751500001 },
      ],
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.traitsSeeded).toBe(2);
    expect(b.ledgerRows).toBe(2);

    // Verify via the admin summary + the ledger directly.
    const sum = await SELF.fetch(`${BASE}/api/admin/profile?uid=${uid}`, {
      headers: { authorization: "Bearer test-secret" },
    });
    const s = (await sum.json()) as Record<string, any>;
    expect(s.name).toBe("Julian");
    expect(s.hasConfig).toBe(true);
    expect(s.traits).toBe(2);
    expect(s.ledgerRows).toBe(2);

    const row = await ((env as Record<string, any>).DB as D1Database)
      .prepare("SELECT story_key, state FROM read_ledger WHERE user_id = ?1 ORDER BY story_key")
      .bind(uid)
      .all();
    expect(row.results).toHaveLength(2);
    expect((row.results[0] as Record<string, unknown>).state).toBe("seen");
    // URL-bearing entries key on the CANONICAL url (utm stripped).
    expect(String((row.results[1] as Record<string, unknown>).story_key)).toBe(
      "u:https://example.com/served",
    );
  });

  it("replays never clobber real signal evidence", async () => {
    const uid = "apple:migr-test-2";
    await post("/api/admin/import-profile", {
      uid,
      traits: [{ key: "desk.weight.gaming", value: 1 }],
    });
    // A real signal arrives, raising evidence above zero…
    const ns = (env as Record<string, any>).PROFILES;
    const stub = ns.get(ns.idFromName(uid)) as any;
    await stub.recordSignal({ sourceApp: "wire", type: "story.read", entity: "gaming" });
    const before = (await stub.getTraits("desk.weight.gaming"))[0].value;
    // …then the migration is replayed with a different weight.
    const replay = await post("/api/admin/import-profile", {
      uid,
      traits: [{ key: "desk.weight.gaming", value: 3 }],
    });
    expect(((await replay.json()) as Record<string, any>).traitsSeeded).toBe(0);
    const after = (await stub.getTraits("desk.weight.gaming"))[0].value;
    expect(after).toBeCloseTo(before, 3);
  });

  it("shared seen records land under uid shared without touching a ProfileDO", async () => {
    const res = await post("/api/admin/import-profile", {
      uid: "shared",
      seen: [{ c: "world", t: "Shared feed story everyone saw", u: "https://example.com/shared-1", at: 1751500002 }],
    });
    const b = (await res.json()) as Record<string, any>;
    expect(b.ledgerRows).toBe(1);
  });
});
