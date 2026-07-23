import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { extractEntities, resolveEntity, entityEcho, warmEntities } from "../src/lib/entities";

// Wikidata is never hit for real (hermetic env): a fake fetch returns canned
// wbsearchentities JSON so the accept-only-when-unambiguous logic is provable.
const KV = () => (env as Record<string, any>).KV;
const wd = (search: any[], capture?: (url: string, init: any) => void) =>
  (async (url: string, init?: any) => {
    if (capture) capture(url, init);
    return new Response(JSON.stringify({ search }), { status: 200 });
  }) as any;
const hit = (label: string, matchText: string, type = "alias", description = "") =>
  ({ label, description, match: { type, text: matchText } });
const throwFetch = (() => { throw new Error("should not fetch"); }) as any;

describe("extractEntities", () => {
  it("pulls capitalised proper-noun runs", () => {
    const e = extractEntities("Lionel Messi signs for Inter Miami");
    expect(e).toContain("Lionel Messi");
    expect(e).toContain("Inter Miami");
  });
  it("skips known non-entity capitalised words", () => {
    expect(extractEntities("The Best New Phones")).not.toContain("Best");
    expect(extractEntities("Used electric cars soar")).not.toContain("Used");
  });
});

describe("resolveEntity — cache-first, unambiguous-only", () => {
  it("resolves an exact alias match, caches it, and never re-fetches", async () => {
    let calls = 0;
    const label = await resolveEntity(env as any, "Messi", wd([hit("Lionel Messi", "Messi")], () => calls++));
    expect(label).toBe("Lionel Messi");
    expect(calls).toBe(1);
    expect(await resolveEntity(env as any, "Messi", throwFetch)).toBe("Lionel Messi"); // cache hit, no network
  });
  it("resolves the real-world ambiguous list: Messina(prefix) + family-name + Lionel Messi(alias)", async () => {
    // Mirrors the ACTUAL Wikidata response order for "Messi".
    const label = await resolveEntity(env as any, "Messix", wd([
      hit("Messina", "Messina", "label", "Italian comune in Sicily"), // prefix — text != query
      hit("Messix", "Messix", "label", "family name"), // exact label but a pseudo-entity
      hit("Lionel Messix", "Messix", "alias", "Argentine footballer"), // the real subject
    ]));
    expect(label).toBe("Lionel Messix");
  });
  it("does NOT echo when the query is itself a canonical entity (Jordan the country wins over Michael Jordan)", async () => {
    const label = await resolveEntity(env as any, "Jordanx", wd([
      hit("Jordanx", "Jordanx", "label", "country in the Middle East"), // query IS the canonical label
      hit("Michael Jordanx", "Jordanx", "alias", "American basketball player"),
    ]));
    expect(label).toBe("Jordanx"); // returned, but == query ⇒ entityEcho shows nothing
    expect(await entityEcho(env as any, "Jordanx")).toBeNull();
  });
  it("stays silent on a genuinely ambiguous alias (two distinct canonical labels)", async () => {
    expect(await resolveEntity(env as any, "novaq", wd([
      hit("Nova Scotia", "novaq", "alias", "province"),
      hit("Nova Lima", "novaq", "alias", "city in Brazil"),
    ]))).toBeNull();
  });
  it("rejects a fuzzy (non-exact-name) top hit", async () => {
    expect(await resolveEntity(env as any, "zlatanx", wd([hit("Zlatan Ibrahimovic", "Zlatan")]))).toBeNull();
  });
  it("rejects a disambiguation page and negative-caches it", async () => {
    expect(await resolveEntity(env as any, "Mercuryx", wd([hit("Mercuryx", "Mercuryx", "label", "disambiguation page")]))).toBeNull();
    expect(await resolveEntity(env as any, "Mercuryx", throwFetch)).toBeNull(); // negative cached
  });
  it("returns null on no hits and on a non-ok response", async () => {
    expect(await resolveEntity(env as any, "asdfghjklq", wd([]))).toBeNull();
    expect(await resolveEntity(env as any, "brokenq", (async () => new Response("", { status: 500 })) as any)).toBeNull();
  });
  it("does NOT negative-cache a transient failure — the term is retried next time", async () => {
    const term = "transientz";
    // First attempt hits a 503 (transient) → null, but nothing cached.
    expect(await resolveEntity(env as any, term, (async () => new Response("", { status: 503 })) as any)).toBeNull();
    // Next attempt actually fetches (proving no poison "" was cached) and resolves.
    let calls = 0;
    expect(await resolveEntity(env as any, term, wd([hit("Transient Co", "Transientz")], () => calls++))).toBe("Transient Co");
    expect(calls).toBe(1);
  });
  it("skips extraction for a SHOUTY all-caps headline (no wasted budget)", async () => {
    expect(extractEntities("BREAKING MARKET TURMOIL DEEPENS TODAY")).toEqual([]);
  });
  it("sends a descriptive User-Agent", async () => {
    let ua = "";
    await resolveEntity(env as any, "Toyotaz", wd([hit("Toyota", "Toyotaz")], (_u, init) => { ua = init.headers["user-agent"]; }));
    expect(ua).toContain("TheWire");
    expect(ua).toContain("wire.databased.business");
  });
});

describe("entityEcho — pure cache read", () => {
  it("echoes only a canonical label that differs from the query", async () => {
    await KV().put("ent:kane", "Harry Kane");
    await KV().put("ent:tesla motors", "Tesla, Inc.");
    expect(await entityEcho(env as any, "Kane")).toBe("Harry Kane");
    await KV().put("ent:apple", "apple"); // same as query ⇒ no echo
    expect(await entityEcho(env as any, "Apple")).toBeNull();
    expect(await entityEcho(env as any, "neverseenterm")).toBeNull(); // absent ⇒ no echo
  });
});

describe("warmEntities — write-time, hard-capped", () => {
  it("never exceeds the lookup cap and skips already-cached terms", async () => {
    let calls = 0;
    const res = await warmEntities(
      env as any,
      ["Neymarz and Mbappez meet", "Haalandz returns", "Vinicius scores"],
      2,
      wd([hit("X", "nomatch")], () => calls++),
    );
    expect(res.calls).toBeLessThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(2);
  });
});
