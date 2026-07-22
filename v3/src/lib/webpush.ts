// Web Push (RFC 8291 payload encryption + RFC 8292 VAPID) on WebCrypto. The
// second half of "when I want it" — interrupts reach every user's browser,
// not just the operator's ntfy topic. Verified against the RFC 8291 §5 test
// vector (see webpush.test.ts): if that vector reproduces, the encryption is
// correct.

import { b64urlToBytes, bytesToB64url } from "./auth";

const P256 = { name: "ECDH", namedCurve: "P-256" } as const;
// workers-types quirk: the ECDH deriveBits algorithm uses `$public`, but the
// runtime uses the standard `public`. This local type keeps the runtime-
// correct shape while satisfying tsc.
type EcdhKeyDeriveParams = { name: "ECDH"; public: CryptoKey };

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.byteLength; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export interface PushSub {
  endpoint: string;
  p256dh: string; // base64url uncompressed point (65 bytes)
  auth: string; // base64url 16 bytes
}

// RFC 8291 §3.4 key/nonce derivation + §4 aes128gcm content encoding.
// opts lets the test inject the RFC's fixed ephemeral key + salt.
export async function encryptPayload(
  payload: Uint8Array,
  sub: PushSub,
  opts?: { salt?: Uint8Array; ephemeral?: CryptoKeyPair },
): Promise<Uint8Array> {
  const uaPublicRaw = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);
  const uaPublic = await crypto.subtle.importKey("raw", uaPublicRaw, P256, false, []);

  const asKeys =
    opts?.ephemeral ??
    ((await crypto.subtle.generateKey(P256, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);

  // ECDH shared secret.
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublic } as unknown as EcdhKeyDeriveParams,
    asKeys.privateKey,
    256,
  );
  const ecdh = new Uint8Array(ecdhBits);

  // PRK_key = HKDF(auth_secret, ecdh, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  const salt = opts?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // Plaintext gets a single 0x02 padding delimiter (one record, no padding).
  const plaintext = concat(payload, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public 65) | ciphertext
  const rs = new Uint8Array([0, 0, 0x10, 0x00]); // 4096
  const idlen = new Uint8Array([asPublicRaw.byteLength]);
  return concat(salt, rs, idlen, asPublicRaw, ct);
}

// RFC 8292 VAPID: an ES256 JWT { aud: origin, exp, sub } signed with the
// application server private key, plus the public key, sent as one
// Authorization: vapid header.
export async function vapidAuthHeader(
  endpoint: string,
  vapidPublicB64: string,
  vapidPrivatePkcs8B64: string,
  subject: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(utf8(JSON.stringify({ aud: origin, exp: nowSec + 12 * 3600, sub: subject })));
  const signingInput = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", b64urlToBytes(vapidPrivatePkcs8B64),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput)),
  );
  const jwt = `${signingInput}.${bytesToB64url(sig)}`;
  return `vapid t=${jwt}, k=${vapidPublicB64}`;
}

export interface VapidKeys {
  publicKey: string; // base64url uncompressed point
  privatePkcs8: string; // base64url pkcs8
  subject: string; // mailto: or https:
}

// Send one push. Returns { ok, status }; a 404/410 means the subscription is
// gone and the caller should delete it.
export async function sendWebPush(
  sub: PushSub,
  payload: string,
  vapid: VapidKeys,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ ok: boolean; status: number; gone: boolean }> {
  const body = await encryptPayload(utf8(payload), sub);
  const auth = await vapidAuthHeader(sub.endpoint, vapid.publicKey, vapid.privatePkcs8, vapid.subject);
  const res = await fetcher(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "86400",
      urgency: "high",
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
