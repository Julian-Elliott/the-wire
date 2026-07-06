#!/usr/bin/env node
// v2 → v3 KV migration (V3_BLUEPRINT §11). DRY-RUN BY DEFAULT — pass --apply
// to actually POST to the v3 admin import door. Re-runnable: the import is
// idempotent server-side (real signals are never clobbered by a replay).
//
// Reads the LIVE v2 KV namespace via the locally-authed wrangler CLI
// (--remote is load-bearing: without it wrangler reads a local dev store —
// the v2 lesson that cost an afternoon). Migrates:
//   profile:apple:<sub>  -> ProfileDO config + desk weights as traits
//   aname:apple:<sub>    -> ProfileDO name (unrecoverable from Apple)
//   seen:shared          -> read_ledger rows under uid "shared"
//   seen:user:<uid>      -> read_ledger rows under that uid
// Dropped by design: anon profiles, TTL'd briefings/locks/markers.
//
// Usage:
//   node scripts/migrate-v2.mjs                 # dry run, prints the plan
//   node scripts/migrate-v2.mjs --apply         # POSTs to production
//   INGEST_SECRET=... node scripts/migrate-v2.mjs --apply
//   (secret defaults to the INGEST_SECRET line in v3/.dev.vars)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const V2_NAMESPACE = "d83154c6f90442f7a287cc1cd8938e80";
const BASE = process.env.WIRE_BASE ?? "https://wire.databased.business";
const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));

function secret() {
  if (process.env.INGEST_SECRET) return process.env.INGEST_SECRET;
  const devVars = join(here, "..", ".dev.vars");
  if (existsSync(devVars)) {
    const m = readFileSync(devVars, "utf8").match(/^INGEST_SECRET\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  }
  return null;
}

const wrangler = (...args) =>
  execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", cwd: join(here, "..") });

function listKeys() {
  const out = wrangler("kv", "key", "list", "--namespace-id", V2_NAMESPACE, "--remote");
  return JSON.parse(out).map((k) => k.name);
}

function getJSON(key) {
  try {
    const out = wrangler("kv", "key", "get", key, "--namespace-id", V2_NAMESPACE, "--remote");
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function post(path, body, sec) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sec}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const keys = listKeys();
const profileKeys = keys.filter((k) => k.startsWith("profile:apple:"));
const nameKeys = new Set(keys.filter((k) => k.startsWith("aname:apple:")));
const seenUserKeys = keys.filter((k) => k.startsWith("seen:user:apple:"));
const hasSharedSeen = keys.includes("seen:shared");

console.log(`v2 namespace: ${keys.length} keys total`);
console.log(`  apple profiles: ${profileKeys.length}`);
console.log(`  apple names:    ${nameKeys.size}`);
console.log(`  user seen recs: ${seenUserKeys.length}${hasSharedSeen ? " + shared" : ""}`);
console.log(`  mode: ${APPLY ? "APPLY (writing to " + BASE + ")" : "dry run"}\n`);

const payloads = [];

for (const pk of profileKeys) {
  const uid = pk.slice("profile:".length); // apple:<sub>
  const profile = getJSON(pk);
  if (!profile) {
    console.warn(`  ! unreadable profile ${pk} — skipped`);
    continue;
  }
  const nameKey = `aname:${uid}`;
  const name = nameKeys.has(nameKey) ? getJSON(nameKey) : null;
  const weights = profile.weights && typeof profile.weights === "object" ? profile.weights : {};
  const traits = Object.entries(weights)
    .map(([desk, w]) => ({ key: `desk.weight.${desk}`, value: Number(w) }))
    .filter((t) => Number.isFinite(t.value));
  const seenRec = seenUserKeys.includes(`seen:user:${uid}`) ? getJSON(`seen:user:${uid}`) : null;
  const seen = Array.isArray(seenRec?.recent) ? seenRec.recent : [];
  payloads.push({
    uid,
    name: typeof name === "string" ? name : name?.name ?? undefined,
    config: profile,
    traits,
    seen,
  });
}

if (hasSharedSeen) {
  const rec = getJSON("seen:shared");
  const seen = Array.isArray(rec?.recent) ? rec.recent : [];
  payloads.push({ uid: "shared", seen });
}

for (const p of payloads) {
  console.log(
    `  ${p.uid}: name=${p.name ? "yes" : "no"} traits=${p.traits?.length ?? 0} seen=${p.seen?.length ?? 0}`,
  );
}

if (!APPLY) {
  console.log("\nDry run complete. Re-run with --apply to migrate.");
  process.exit(0);
}

const sec = secret();
if (!sec) {
  console.error("No INGEST_SECRET (env or v3/.dev.vars) — cannot apply.");
  process.exit(1);
}

for (const p of payloads) {
  const res = await post("/api/admin/import-profile", p, sec);
  console.log(`  -> ${p.uid}: traitsSeeded=${res.traitsSeeded} ledgerRows=${res.ledgerRows}`);
}

console.log("\nVerify with: curl -H 'Authorization: Bearer …' '" + BASE + "/api/admin/profile?uid=<uid>'");
