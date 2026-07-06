// Sign in with Apple, ported from v2 (worker.js:1485-1580): pure sign-in —
// we verify the RS256 identity token Apple form_posts back against Apple's
// published JWKS, so no .p8/client-secret is needed; just the Services ID
// (aud) and a session secret. Sessions are our own HMAC-signed tokens.

export interface AppleEnv {
  APPLE_CLIENT_ID?: string;
  APPLE_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
}

export const appleEnabled = (env: AppleEnv): boolean =>
  !!(env.APPLE_CLIENT_ID && env.SESSION_SECRET);

export function b64urlToBytes(s: string): Uint8Array {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4;
  if (pad) t += "=".repeat(4 - pad);
  const bin = atob(t);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function bytesToB64url(u: Uint8Array): string {
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const strToB64url = (s: string): string => bytesToB64url(new TextEncoder().encode(s));
export const b64urlToStr = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

export const randHex = (n = 16): string => {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
};

export function getCookie(req: Request, name: string): string | null {
  const c = req.headers.get("Cookie") ?? "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// Our own signed token (HMAC-SHA256) for the session and auth-flow cookies.
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export async function signToken(secret: string, obj: Record<string, unknown>): Promise<string> {
  const body = strToB64url(JSON.stringify(obj));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body)),
  );
  return body + "." + bytesToB64url(sig);
}

export async function verifyToken(
  secret: string | undefined,
  token: string | null,
): Promise<Record<string, unknown> | null> {
  if (!secret || !token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), b64urlToBytes(sig), new TextEncoder().encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(b64urlToStr(body));
  } catch {
    return null;
  }
  if (typeof obj.exp === "number" && Date.now() / 1000 > obj.exp) return null;
  return obj;
}

// Verify Apple's RS256 identity token against Apple's published JWKS
// (cached one hour per isolate).
interface AppleJwk { kid: string; kty: string; n: string; e: string }
let appleKeysCache: AppleJwk[] | null = null;
let appleKeysAt = 0;

async function appleKeys(): Promise<AppleJwk[]> {
  if (appleKeysCache && Date.now() - appleKeysAt < 3_600_000) return appleKeysCache;
  const res = await fetch("https://appleid.apple.com/auth/keys");
  const data = (await res.json()) as { keys?: AppleJwk[] };
  appleKeysCache = data.keys ?? [];
  appleKeysAt = Date.now();
  return appleKeysCache;
}

export interface AppleIdPayload {
  sub: string;
  email?: string;
  nonce?: string;
  iss: string;
  aud: string;
  exp?: number;
}

// expectedNonce: REQUIRED for sign-in tokens (login flow always sets one);
// pass undefined only for server-to-server event JWTs, which carry no nonce.
export async function verifyAppleIdToken(
  env: AppleEnv,
  idToken: unknown,
  expectedNonce: string | undefined,
): Promise<AppleIdPayload | null> {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header: { kid?: string };
  let payload: AppleIdPayload;
  try {
    header = JSON.parse(b64urlToStr(parts[0]));
    payload = JSON.parse(b64urlToStr(parts[1]));
  } catch {
    return null;
  }
  const jwk = (await appleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    ok = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, key,
      b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  if (payload.iss !== "https://appleid.apple.com") return null;
  if (payload.aud !== env.APPLE_CLIENT_ID) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  if (payload.nonce !== expectedNonce) return null; // both undefined for event JWTs
  return payload;
}
