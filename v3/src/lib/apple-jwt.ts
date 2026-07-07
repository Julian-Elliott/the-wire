// ES256 JWT minting for Apple REST services (WeatherKit now; the pattern is
// v2's MusicKit token mint, ported). The .p8 private key never leaves the
// Worker secret; WebCrypto's raw r||s ECDSA output is exactly JWS ES256.

import { b64urlToBytes, bytesToB64url, strToB64url } from "./auth";

export async function mintAppleEs256(
  p8Pem: string,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<string> {
  const pem = p8Pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", b64urlToBytes(pem.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const body =
    strToB64url(JSON.stringify({ alg: "ES256", ...header })) +
    "." +
    strToB64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)),
  );
  return body + "." + bytesToB64url(sig);
}
