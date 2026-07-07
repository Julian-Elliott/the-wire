import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintPersonaToken } from "../src/lib/persona-token";

const BASE = "https://wire.databased.business";
const SECRET = "test-persona-secret";

const mint = (over: Partial<Parameters<typeof mintPersonaToken>[1]> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return mintPersonaToken(SECRET, {
    iss: "wire-persona", sub: "the-wire", scopes: ["context:read", "policy:eval", "signals:write", "traits:read"],
    iat: now, exp: now + 3600, ...over,
  });
};

const register = (clientId: string, scopes: string[]) =>
  SELF.fetch(`${BASE}/api/admin/persona-client`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
    body: JSON.stringify({ clientId, name: clientId, scopes }),
  });

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("Persona tool surface", () => {
  it("unregistered client tokens are rejected even when well-signed", async () => {
    const tok = await mint({ sub: "ghost-client" });
    const res = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:p1`, { headers: bearer(tok) });
    expect(res.status).toBe(401); // no registry row
  });

  it("registered client can read context and it is audited", async () => {
    await register("the-wire", ["context:read", "signals:write"]);
    const tok = await mint({ sub: "the-wire", scopes: ["context:read", "signals:write"] });

    // Seed a signal so the profile has something.
    await SELF.fetch(`${BASE}/api/persona/record_signal`, {
      method: "POST",
      headers: { ...bearer(tok), "content-type": "application/json" },
      body: JSON.stringify({ uid: "apple:persona-user", type: "story.read", entity: "world" }),
    });

    const res = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:persona-user`, { headers: bearer(tok) });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.context.dials).toHaveProperty("DEPTH");
    expect(b.context.topDesks.some((d: any) => d.desk === "world")).toBe(true);
  });

  it("enforces scopes: a context-only token cannot eval policy", async () => {
    await register("reader-only", ["context:read"]);
    const tok = await mint({ sub: "reader-only", scopes: ["context:read"] });
    const res = await SELF.fetch(`${BASE}/api/persona/is_interruptible?uid=apple:x&priority=3`, { headers: bearer(tok) });
    expect(res.status).toBe(403);
    // The tool list hides what the scope can't reach.
    const tools = await SELF.fetch(`${BASE}/api/persona/tools`, { headers: bearer(tok) });
    const tb = (await tools.json()) as Record<string, any>;
    expect(tb.tools.map((t: any) => t.name)).toEqual(["get_context"]);
  });

  it("a uid-pinned token cannot act on another user", async () => {
    await register("pinned", ["context:read"]);
    const tok = await mint({ sub: "pinned", scopes: ["context:read"], uid: "apple:owner" });
    const own = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:owner`, { headers: bearer(tok) });
    expect(own.status).toBe(200);
    const other = await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:someone-else`, { headers: bearer(tok) });
    expect(other.status).toBe(403);
  });

  it("revoking the client row kills its tokens immediately", async () => {
    await register("temp", ["context:read"]);
    const tok = await mint({ sub: "temp", scopes: ["context:read"] });
    expect((await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:z`, { headers: bearer(tok) })).status).toBe(200);
    await SELF.fetch(`${BASE}/api/admin/persona-client`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ clientId: "temp", action: "revoke" }),
    });
    expect((await SELF.fetch(`${BASE}/api/persona/get_context?uid=apple:z`, { headers: bearer(tok) })).status).toBe(401);
  });

  it("is_interruptible returns the trust-ladder verdict", async () => {
    await register("dj", ["policy:eval"]);
    const tok = await mint({ sub: "dj", scopes: ["policy:eval"] });
    const res = await SELF.fetch(`${BASE}/api/persona/is_interruptible?uid=apple:dj-user&priority=2`, { headers: bearer(tok) });
    const b = (await res.json()) as Record<string, any>;
    expect(b.decision).toBe("digest"); // priority < 3 never interrupts
  });
});
