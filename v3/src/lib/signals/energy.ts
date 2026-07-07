// Energy triggers (SOURCE_STRATEGIES §7): Octopus Agile cheap-window +
// National Grid carbon intensity. Both keyless. Priority stays low —
// energy is a digest nudge, never an interrupt.

import type { Fetcher, PollerResult, Trigger } from "./types";

const CHEAP_P_PER_KWH = 5; // "electricity is cheap" threshold
const CHEAP_MIN_SLOTS = 2; // at least an hour of it (2× 30-min slots)

// Octopus Agile half-hourly unit rates (inc VAT), default region C = London.
export async function pollOctopus(
  fetcher: Fetcher,
  product = "AGILE-24-10-01",
  tariff = "E-1R-AGILE-24-10-01-C",
): Promise<PollerResult> {
  const res = await fetcher(
    `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/`,
  );
  if (!res.ok) throw new Error(`octopus ${res.status}`);
  const data = (await res.json()) as {
    results?: { value_inc_vat: number; valid_from: string; valid_to: string }[];
  };
  const now = Date.now();
  const upcoming = (data.results ?? [])
    .filter((r) => Date.parse(r.valid_to) > now)
    .sort((a, b) => Date.parse(a.valid_from) - Date.parse(b.valid_from));
  const cheap = upcoming.filter((r) => r.value_inc_vat <= CHEAP_P_PER_KWH);
  const triggers: Trigger[] = [];
  if (cheap.length >= CHEAP_MIN_SLOTS) {
    const from = new Date(cheap[0].valid_from).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    });
    const cheapest = Math.min(...cheap.map((r) => r.value_inc_vat));
    triggers.push({
      source: "octopus",
      desk: "energy",
      dedupKey: `energy:agile:${cheap[0].valid_from}`,
      title: `Cheap electricity from ${from} (${cheapest.toFixed(1)}p/kWh)`,
      summary: `Agile drops to ${cheapest.toFixed(1)}p/kWh — run the dishwasher, washing machine or car charge in the cheap window.`,
      why: `Agile unit rate falls to ${cheapest.toFixed(1)}p/kWh`,
      url: "https://octopus.energy/dashboard/",
      priority: 1,
      expiresHours: 6,
    });
  }
  return { backend: "octopus", triggers };
}

// National Grid ESO carbon intensity — "grid is green, run the appliances".
export async function pollCarbon(fetcher: Fetcher): Promise<PollerResult> {
  const res = await fetcher("https://api.carbonintensity.org.uk/intensity");
  if (!res.ok) throw new Error(`carbon ${res.status}`);
  const data = (await res.json()) as {
    data?: { intensity: { actual: number | null; forecast: number; index: string } }[];
  };
  const cur = data.data?.[0]?.intensity;
  const triggers: Trigger[] = [];
  if (cur && (cur.index === "very low" || cur.index === "low")) {
    triggers.push({
      source: "carbon",
      desk: "energy",
      // STATE, not event: an all-night green grid is ONE fact per day, not
      // one story per hour (first-edition lesson — hour-bucketing spammed
      // five identical cards).
      dedupKey: `energy:carbon:${new Date().toISOString().slice(0, 10)}`,
      title: "The grid is green right now",
      summary: `Carbon intensity is ${cur.index} (${cur.actual ?? cur.forecast} gCO₂/kWh) — a good moment for the wash or the car.`,
      why: `grid carbon intensity is ${cur.index}`,
      url: "https://carbonintensity.org.uk",
      priority: 1,
      expiresHours: 2,
    });
  }
  return { backend: "carbon", triggers };
}
