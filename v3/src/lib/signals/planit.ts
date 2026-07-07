// PlanIt planning-application triggers (SOURCE_STRATEGIES §7 build-first):
// ~400 UK portals normalised into one keyless API. "New application near
// home" is the catalogue's highest-delight-per-line alert. Polite polling:
// one radius query per user per day.

import type { Fetcher, PollerResult, Trigger } from "./types";

export async function pollPlanit(
  opts: { lat: number; lon: number; radiusKm?: number; sinceDays?: number },
  fetcher: Fetcher,
): Promise<PollerResult> {
  const radius = opts.radiusKm ?? 0.4;
  const since = new Date(Date.now() - (opts.sinceDays ?? 7) * 86400_000).toISOString().slice(0, 10);
  const res = await fetcher(
    `https://www.planit.org.uk/api/applics/json?lat=${opts.lat}&lng=${opts.lon}` +
      `&krad=${radius}&start_date=${since}&pg_sz=20&sort=-start_date`,
    { headers: { "user-agent": "the-wire/1.0 (personal, non-commercial)" } },
  );
  if (!res.ok) throw new Error(`planit ${res.status}`);
  const data = (await res.json()) as {
    records?: { name?: string; address?: string; description?: string; link?: string; app_size?: string }[];
  };
  const triggers: Trigger[] = (data.records ?? []).slice(0, 5).map((r) => ({
    source: "planit",
    desk: "planning" as const,
    dedupKey: `planning:${r.name ?? r.link ?? r.address ?? ""}`,
    title: `Planning application near you${r.app_size && r.app_size !== "Small" ? ` (${r.app_size})` : ""}`,
    summary: `${(r.description ?? "A new planning application").slice(0, 240)}${r.address ? ` — ${r.address}` : ""}`,
    why: "new planning application within a few hundred metres of home",
    url: r.link ?? "https://www.planit.org.uk",
    priority: 2 as const,
    expiresHours: 24 * 7,
  }));
  return { backend: "planit", triggers };
}
