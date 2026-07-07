#!/usr/bin/env node
// One-off WeatherKit credential check (PLATFORM: included with the Apple
// Developer membership, 500k calls/month). Mints the ES256 REST JWT from the
// local .p8 and asks for availability + current weather at Worcester.
//
// Usage: node scripts/weatherkit-test.mjs [lat] [lon]
// Requires: keys/AuthKey_<WEATHERKIT_KEY_ID>.p8 at the repo root, and an
// App ID matching WEATHERKIT_APP_ID with the WeatherKit capability enabled
// in the Apple portal (401s until that exists).

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEAM = "7BL94Z94QH";
const KEY_ID = "6W7Q97JL6K";
const APP_ID = "business.databased.thewire";
const [lat = "52.192", lon = "-2.22"] = process.argv.slice(2); // Worcester

const here = dirname(fileURLToPath(import.meta.url));
const pem = readFileSync(join(here, "..", "..", "keys", `AuthKey_${KEY_ID}.p8`), "utf8");
const key = createPrivateKey(pem);

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID, id: `${TEAM}.${APP_ID}` }));
const payload = b64url(JSON.stringify({ iss: TEAM, iat: now, exp: now + 3600, sub: APP_ID }));
const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
const jwt = `${header}.${payload}.${b64url(sig)}`;

const get = async (path) => {
  const res = await fetch(`https://weatherkit.apple.com/api/v1${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

const avail = await get(`/availability/${lat}/${lon}?country=GB`);
console.log("availability:", avail.status, JSON.stringify(avail.body).slice(0, 120));
if (avail.status !== 200) {
  console.error(avail.status === 401
    ? "\n401 = the App ID isn't registered yet: portal → Identifiers → + → App IDs →\n" +
      `bundle id ${APP_ID} (explicit) → tick WeatherKit (Capabilities AND App Services tabs) → register.`
    : "\nUnexpected failure — check key/team ids.");
  process.exit(1);
}
const wx = await get(`/weather/en-GB/${lat}/${lon}?dataSets=${avail.body.join(",")}&timezone=Europe/London`);
const c = wx.body?.currentWeather;
console.log("current:", wx.status, c ? `${c.temperatureApparent}°C feels-like, ${c.conditionCode}, wind ${Math.round(c.windSpeed)} km/h` : JSON.stringify(wx.body).slice(0, 200));
