// Environment Agency real-time flood warnings (local-by-civic, Wave B): free,
// keyless, official UK-government open data, queried by lat/long. A flood
// warning near home is the archetypal need-to-know, so severity maps straight
// onto the trust ladder: SEVERE (severityLevel 1, "danger to life") →
// priority-3 interrupt-eligible; a WARNING (2, "flooding expected") →
// priority-2 need-to-know; an ALERT (3, "flooding possible") → the feed;
// "no longer in force" (4) is dropped. Graceful: any failure costs no edition.

import type { Fetcher, PollerResult, Trigger } from "./types";

interface FloodItem {
  "@id"?: string;
  description?: string;
  message?: string;
  severity?: string;
  severityLevel?: number;
  floodAreaID?: string;
  floodArea?: { riverOrSea?: string; county?: string };
}

export async function pollFloods(
  opts: { lat: number; lon: number; distKm?: number },
  fetcher: Fetcher,
): Promise<PollerResult> {
  const dist = opts.distKm ?? 15; // flood catchments are broader than a planning radius
  const res = await fetcher(
    `https://environment.data.gov.uk/flood-monitoring/id/floods?lat=${opts.lat}&long=${opts.lon}&dist=${dist}`,
    { headers: { "user-agent": "the-wire/1.0 (personal, non-commercial)" } },
  );
  if (!res.ok) throw new Error(`floods ${res.status}`);
  const data = (await res.json()) as { items?: FloodItem[] };
  const items = Array.isArray(data.items) ? data.items : [];
  const triggers: Trigger[] = [];
  for (const f of items.slice(0, 8)) {
    const lvl = Number(f.severityLevel);
    if (!(lvl >= 1 && lvl <= 3)) continue; // 4 = no longer in force; missing/other = skip
    const priority = (lvl === 1 ? 3 : lvl === 2 ? 2 : 1) as 1 | 2 | 3;
    const where = String(f.description || f.floodArea?.riverOrSea || f.floodArea?.county || "your area").slice(0, 120);
    const label = f.severity || (lvl === 1 ? "Severe flood warning" : lvl === 2 ? "Flood warning" : "Flood alert");
    triggers.push({
      source: "environment-agency",
      desk: "weather",
      dedupKey: `flood:${f.floodAreaID ?? f["@id"] ?? where}`,
      title: `${label}: ${where}`,
      summary: String(f.message ?? f.description ?? "A flood warning is in force near you.").slice(0, 240),
      why: lvl === 1
        ? "SEVERE flood warning near your home — danger to life"
        : lvl === 2 ? "flood warning in force near your home" : "flood alert near your home",
      url: "https://check-for-flooding.service.gov.uk",
      priority,
      expiresHours: 24,
    });
  }
  return { backend: "environment-agency", triggers };
}
