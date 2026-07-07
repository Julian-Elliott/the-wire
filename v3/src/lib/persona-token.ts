// Persona access tokens (V3_BLUEPRINT §4): OAuth-lite for one operator —
// HS256 JWTs minted by the admin CLI (scripts/persona-client.mjs), 90-day
// expiry, no refresh flow (re-mint). Scopes are noun.verb strings; a token
// may optionally be pinned to one uid. Revocation = delete the client row
// (the gate checks the registry on every call).

import { b64urlToStr, bytesToB64url, strToB64url } from "./auth";

export interface PersonaClaims {
  iss: "wire-persona";
  sub: string; // client_id
  scopes: string[];
  uid?: string; // present = token usable ONLY for this user
  iat: number;
  exp: number;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export async function mintPersonaToken(secret: string, claims: PersonaClaims): Promise<string> {
  const h = strToB64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = strToB64url(JSON.stringify(claims));
  return `${h}.${p}.${bytesToB64url(await hmac(secret, `${h}.${p}`))}`;
}

export async function verifyPersonaToken(
  secret: string | undefined,
  token: string | null,
): Promise<PersonaClaims | null> {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = bytesToB64url(await hmac(secret, `${parts[0]}.${parts[1]}`));
  // Constant-time-ish compare (same technique as machineGate).
  if (expected.length !== parts[2].length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  if (diff !== 0) return null;
  let claims: PersonaClaims;
  try {
    claims = JSON.parse(b64urlToStr(parts[1]));
  } catch {
    return null;
  }
  if (claims.iss !== "wire-persona") return null;
  if (!Array.isArray(claims.scopes)) return null;
  if (typeof claims.exp !== "number" || Date.now() / 1000 > claims.exp) return null;
  return claims;
}

// The tool catalogue, scope-gated. A client without the scope cannot even
// SEE the tool (V3_BLUEPRINT §8: scope enforcement in the tool list).
export const PERSONA_TOOLS: { name: string; scope: string; description: string }[] = [
  { name: "get_context", scope: "context:read", description: "Compact profile brief for prompt injection: name, dials, top traits, coarse state." },
  { name: "get_traits", scope: "traits:read", description: "Decayed trait values, optionally filtered by key prefix." },
  { name: "is_interruptible", scope: "policy:eval", description: "Trust-ladder verdict {interrupt|digest|silent} for a priority 1-3 candidate." },
  { name: "record_signal", scope: "signals:write", description: "Append a behavioural signal (source app, type, entity); traits update via decay-then-add." },
];
