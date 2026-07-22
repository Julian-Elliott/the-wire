import { describe, expect, it } from "vitest";
import { b64urlToBytes, bytesToB64url } from "../src/lib/auth";
import { encryptPayload, vapidAuthHeader, type PushSub } from "../src/lib/webpush";

type EcdhKeyDeriveParams = { name: "ECDH"; public: CryptoKey };

const concat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.byteLength, 0));
  let o = 0; for (const x of a) { out.set(x, o); o += x.byteLength; }
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

// A REAL receiver subscription, valid by construction (no hand-copied curve
// points): generate an ECDH keypair, take its raw public point + a random
// auth secret. Encrypt with the lib, decrypt here with the private key.
async function makeReceiver() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: PushSub = { endpoint: "https://push.example/x", p256dh: bytesToB64url(pubRaw), auth: bytesToB64url(auth) };
  return { kp, pubRaw, auth, sub };
}

// Independent RFC 8291 decryptor, straight from the spec.
async function decrypt(body: Uint8Array, uaPrivate: CryptoKey, uaPubRaw: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublicRaw = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const asPublic = await crypto.subtle.importKey("raw", asPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPublic } as unknown as EcdhKeyDeriveParams, uaPrivate, 256));
  const ikm = await hkdf(auth, ecdh, concat(utf8("WebPush: info\0"), uaPubRaw, asPublicRaw), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ct));
  // Strip the trailing 0x02 single-record delimiter.
  const end = pt[pt.length - 1] === 0x02 ? pt.length - 1 : pt.length;
  return new TextDecoder().decode(pt.subarray(0, end));
}

describe("RFC 8291 payload encryption", () => {
  it("a real receiver decrypts the lib's ciphertext to the exact plaintext", async () => {
    const { kp, pubRaw, auth, sub } = await makeReceiver();
    const msg = "When I grow up, I want to be a watermelon";
    const body = await encryptPayload(utf8(msg), sub);
    // aes128gcm header shape: salt(16) rs(4) idlen(1)=65 key(65) ct.
    expect(body[20]).toBe(65);
    expect(body.byteLength).toBeGreaterThan(16 + 4 + 1 + 65 + 16);
    expect(await decrypt(body, kp.privateKey, pubRaw, auth)).toBe(msg);
  });

  it("round-trips unicode JSON payloads", async () => {
    const { kp, pubRaw, auth, sub } = await makeReceiver();
    const msg = JSON.stringify({ title: "Frost warning ❄️", body: "Scrape the car — bring the washing in" });
    const body = await encryptPayload(utf8(msg), sub);
    expect(await decrypt(body, kp.privateKey, pubRaw, auth)).toBe(msg);
  });

  it("each encryption uses a fresh salt + ephemeral key (ciphertexts differ)", async () => {
    const { sub } = await makeReceiver();
    const a = await encryptPayload(utf8("same"), sub);
    const b = await encryptPayload(utf8("same"), sub);
    expect(bytesToB64url(a)).not.toBe(bytesToB64url(b));
  });
});

describe("RFC 8292 VAPID header", () => {
  it("produces vapid t=<ES256 JWT>, k=<public>, aud = push-service ORIGIN", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey) as ArrayBuffer));
    const pub = bytesToB64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
    const h = await vapidAuthHeader("https://fcm.googleapis.com/fcm/send/abc", pub, pkcs8, "mailto:ops@databased.business");
    expect(h).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const jwtBody = h.split("t=")[1].split(",")[0].split(".")[1];
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(jwtBody)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    // And the JWT signature verifies under the public key.
    const [hh, bb, ss] = h.split("t=")[1].split(",")[0].split(".");
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, kp.publicKey, b64urlToBytes(ss), utf8(`${hh}.${bb}`),
    );
    expect(ok).toBe(true);
  });
});
