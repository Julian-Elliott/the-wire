// Weather triggers with doctor/fallback routing (SOURCE_STRATEGIES 4.1):
// WeatherKit primary (Apple-grade, included in the membership), Open-Meteo
// fallback (keyless). Whichever answers is recorded in the backend field.
// Trigger logic is shared — only the fetch differs.

import { mintAppleEs256 } from "../apple-jwt";
import type { Fetcher, PollerResult, Trigger } from "./types";

export interface WeatherPoint {
  frostMinC: number | null; // lowest apparent temp in the next ~12h
  heavyRain: boolean; // >60% precip probability window
  severe: { title: string; detail: string } | null; // official warning (p3)
}

const FROST_C = 2; // frost-on-car threshold (apparent temperature)

function triggersFor(pt: WeatherPoint, place: string): Trigger[] {
  const out: Trigger[] = [];
  // A severe-weather WARNING is the genuine interrupt-tier case (V3_BLUEPRINT
  // §5): priority 3, so it faces the trust-ladder gate.
  if (pt.severe) {
    out.push({
      source: "weather",
      desk: "weather",
      dedupKey: `weather:severe:${place}:${pt.severe.title}`,
      title: pt.severe.title,
      summary: pt.severe.detail.slice(0, 240),
      why: "official severe-weather warning for your area",
      url: "https://weather.apple.com",
      priority: 3,
      expiresHours: 12,
    });
  }
  if (pt.frostMinC != null && pt.frostMinC <= FROST_C) {
    out.push({
      source: "weather",
      desk: "weather",
      dedupKey: `weather:frost:${place}:${new Date().toISOString().slice(0, 10)}`,
      title: `Frost likely overnight (${Math.round(pt.frostMinC)}°C)`,
      summary: `Apparent temperature drops to about ${Math.round(pt.frostMinC)}°C — scrape the car, cover tender plants, bring the washing in.`,
      why: "frost forecast for your area within 12 hours",
      url: "https://weather.apple.com",
      priority: 2,
      expiresHours: 14,
    });
  }
  if (pt.heavyRain) {
    out.push({
      source: "weather",
      desk: "weather",
      // Daily bucket, same state-not-event lesson as the carbon trigger.
      dedupKey: `weather:rain:${place}:${new Date().toISOString().slice(0, 10)}`,
      title: "Heavy rain expected",
      summary: "A wet window is coming — worth the umbrella and getting washing off the line.",
      why: "high precipitation probability in the next few hours",
      url: "https://weather.apple.com",
      priority: 1,
      expiresHours: 6,
    });
  }
  return out;
}

// --- WeatherKit (primary) ---------------------------------------------------
interface WeatherKitCreds {
  p8: string;
  keyId: string;
  teamId: string;
  appId: string;
}

async function fetchWeatherKit(
  creds: WeatherKitCreds,
  lat: number,
  lon: number,
  fetcher: Fetcher,
): Promise<WeatherPoint> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = await mintAppleEs256(
    creds.p8,
    { kid: creds.keyId, id: `${creds.teamId}.${creds.appId}` },
    { iss: creds.teamId, iat: now, exp: now + 3600, sub: creds.appId },
  );
  const res = await fetcher(
    `https://weatherkit.apple.com/api/v1/weather/en-GB/${lat}/${lon}?dataSets=forecastHourly,weatherAlerts&countryCode=GB&timezone=Europe/London`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  if (!res.ok) throw new Error(`weatherkit ${res.status}`);
  const data = (await res.json()) as {
    forecastHourly?: { hours?: { temperatureApparent?: number; precipitationChance?: number }[] };
    weatherAlerts?: { alerts?: { description?: string; severity?: string }[] };
  };
  const hours = (data.forecastHourly?.hours ?? []).slice(0, 12);
  if (!hours.length) throw new Error("weatherkit empty");
  const frostMinC = Math.min(...hours.map((h) => h.temperatureApparent ?? 99));
  const heavyRain = hours.some((h) => (h.precipitationChance ?? 0) >= 0.6);
  // Only escalate genuinely serious warnings to the interrupt tier.
  const alert = (data.weatherAlerts?.alerts ?? []).find(
    (a) => a.severity === "severe" || a.severity === "extreme",
  );
  const severe = alert
    ? { title: `Weather warning: ${(alert.description ?? "severe weather").slice(0, 60)}`, detail: alert.description ?? "" }
    : null;
  return { frostMinC: frostMinC === 99 ? null : frostMinC, heavyRain, severe };
}

// --- Open-Meteo (fallback) --------------------------------------------------
async function fetchOpenMeteo(lat: number, lon: number, fetcher: Fetcher): Promise<WeatherPoint> {
  const res = await fetcher(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=apparent_temperature,precipitation_probability&forecast_hours=12&timezone=Europe%2FLondon`,
  );
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = (await res.json()) as {
    hourly?: { apparent_temperature?: number[]; precipitation_probability?: number[] };
  };
  const temps = data.hourly?.apparent_temperature ?? [];
  const precip = data.hourly?.precipitation_probability ?? [];
  if (!temps.length) throw new Error("open-meteo empty");
  return {
    frostMinC: Math.min(...temps),
    heavyRain: precip.some((p) => p >= 60),
    severe: null, // Open-Meteo has no official warnings; WeatherKit owns the p3 path
  };
}

// Exposed for unit tests: the pure trigger mapping.
export const triggersForTest = triggersFor;

export async function pollWeather(
  opts: { lat: number; lon: number; place: string; weatherkit?: WeatherKitCreds },
  fetcher: Fetcher,
): Promise<PollerResult> {
  // Doctor/fallback: try WeatherKit if credentialed, else Open-Meteo; on a
  // WeatherKit error, fall through rather than skip the poll.
  if (opts.weatherkit) {
    try {
      const pt = await fetchWeatherKit(opts.weatherkit, opts.lat, opts.lon, fetcher);
      return { backend: "weatherkit", triggers: triggersFor(pt, opts.place) };
    } catch {
      /* fall through to open-meteo */
    }
  }
  const pt = await fetchOpenMeteo(opts.lat, opts.lon, fetcher);
  return { backend: "open-meteo", triggers: triggersFor(pt, opts.place) };
}
