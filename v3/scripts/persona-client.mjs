#!/usr/bin/env node
// Persona client admin CLI (V3_BLUEPRINT §4): register a client app and mint
// its HS256 token in one step. The token carries scopes + an optional uid pin;
// the server's client registry is the revocation surface.
//
// Usage:
//   node scripts/persona-client.mjs register <clientId> <scope,scope,...> [uid]
//   node scripts/persona-client.mjs revoke <clientId>
//
//   scopes: context:read traits:read policy:eval signals:write
//   uid (optional): pins the token to one apple:<sub> — omit for a multi-user
//   client that names the uid per call.
//
// Secrets: INGEST_SECRET (machine door) + PERSONA_JWT_SECRET, from env or
// v3/.dev.vars.

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.WIRE_BASE ?? "https://wire.databased.business";
const here = dirname(fileURLToPath(import.meta.url));

const fromDevVars = (name) => {
  if (process.env[name]) return process.env[name];
  const f = join(here, "..", ".dev.vars");
  if (existsSync(f)) {
    const m = readFileSync(f, "utf8").match(new RegExp(`^${name}\\s*=\\s*"?([^"\\n]+)"?`, "m"));
    if (m) return m[1].trim();
  }
  return null;
};

const b64url = (s) => Buffer.from(s).toString("base64url");
const [, , cmd, clientId, scopeArg, uid] = process.argv;

if (!cmd || !clientId) {
  console.error("usage: persona-client.mjs register <clientId> <scopes> [uid] | revoke <clientId>");
  process.exit(1);
}

const machineSecret = fromDevVars("INGEST_SECRET");
if (!machineSecret) {
  console.error("No INGEST_SECRET (env or v3/.dev.vars)");
  process.exit(1);
}

const admin = (body) =>
  fetch(`${BASE}/api/admin/persona-client`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${machineSecret}` },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${t}`);
    return JSON.parse(t);
  });

if (cmd === "revoke") {
  await admin({ clientId, action: "revoke" });
  console.log(`revoked ${clientId} — all its tokens now fail.`);
  process.exit(0);
}

if (cmd !== "register") {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}

const scopes = (scopeArg ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!scopes.length) {
  console.error("register needs scopes, e.g. context:read,policy:eval");
  process.exit(1);
}

await admin({ clientId, name: clientId, scopes });

const jwtSecret = fromDevVars("PERSONA_JWT_SECRET");
if (!jwtSecret) {
  console.error("Registered the client, but no PERSONA_JWT_SECRET to mint a token with.");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const claims = { iss: "wire-persona", sub: clientId, scopes, iat: now, exp: now + 90 * 86400 };
if (uid) claims.uid = uid;
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(JSON.stringify(claims));
const sig = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
const token = `${header}.${payload}.${sig}`;

console.log(`\nclient:  ${clientId}`);
console.log(`scopes:  ${scopes.join(", ")}`);
console.log(`uid pin: ${uid ?? "(none — names uid per call)"}`);
console.log(`expires: 90 days\n`);
console.log(`token (store securely — not shown again):\n${token}`);
