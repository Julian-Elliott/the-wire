// URL canonicalisation + date extraction, ported from v2 (worker.js canonUrl /
// urlDateSec / pubDateSec) with unchanged semantics — these were correct.

// Canonicalise a URL so the same article via different links (utm/tracking
// params, www, http vs https, trailing slash, #fragment) collapses to one key.
export function canonUrl(u: unknown): string {
  const s = String(u ?? "").trim();
  if (!s) return "";
  try {
    const url = new URL(s);
    url.protocol = "https:";
    url.hash = "";
    url.hostname = url.hostname.replace(/^www\./, "");
    const drop: string[] = [];
    url.searchParams.forEach((_, k) => {
      if (/^(utm_|fbclid|gclid|mc_|ref|cmpid|ito|amp|igshid|spm)/i.test(k)) drop.push(k);
    });
    for (const k of drop) url.searchParams.delete(k);
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return s.replace(/\/+$/, "").toLowerCase();
  }
}

export const canonHost = (u: unknown): string => {
  try {
    return new URL(String(u ?? "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const MON: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Extract a confident publication date (unix seconds) from a URL path, or null.
export function urlDateSec(u: unknown): number | null {
  const s = String(u ?? "");
  let m = s.match(/\/(20\d\d)[/-](0[1-9]|1[0-2])(?:[/-](0[1-9]|[12]\d|3[01]))?/);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 15) / 1000;
    return Number.isFinite(t) ? t : null;
  }
  m = s.match(/\/(20\d\d)\/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/([0-3]?\d)/i);
  if (m) {
    const t = Date.UTC(+m[1], MON[m[2].toLowerCase()] - 1, +m[3]) / 1000;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export const pubDateSec = (v: unknown): number | null => {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
