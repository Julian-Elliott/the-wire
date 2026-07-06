// Ingest validation (V3_BLUEPRINT §1, SOURCE_STRATEGIES 4.6/4.7): the
// cheapest defence against the Tow/NewsGuard failure class — hallucinated
// provenance. Rejects alarm rather than silently drop.
//
//  - URL liveness: every pinned URL must answer. 401/402/403 count as ALIVE
//    (paywalled/refused is an answer — the article exists; Appendix E says
//    treat 402/403 as final, not as licence to retry). Dead = network error,
//    404/410, or 5xx. The timeout covers headers AND body.
//  - Quote verification: verifiable only against a 2xx body. A quote we
//    CANNOT verify (paywall, bodyless response, slow body) is STRIPPED and
//    reported — the item survives, the unverified words do not. Rejection is
//    reserved for quotes provably absent from a readable source.
//  - Two-source rule: priority-3 (interrupt candidates) need two independent
//    hosts AND the second source must itself be live; otherwise they are
//    DEMOTED to priority 2 and flagged — a single voice never interrupts.

import { canonHost } from "./urls";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface IngestItem {
  category: string;
  title: string;
  summary: string;
  url: string;
  sources?: string[];
  salience?: number;
  priority?: 1 | 2 | 3;
  publishedAt?: string;
  quote?: string;
  why?: string;
}

export interface ValidationOutcome {
  ok: IngestItem[];
  rejected: { item: IngestItem; reason: string }[];
  demoted: { item: IngestItem; from: number; to: number; reason: string }[];
  unverified: { item: IngestItem; reason: string }[]; // quotes stripped, item kept
}

const HEAD_BYTES = 256 * 1024;

const normWs = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Strip tags crudely: enough for verbatim-quote matching without an HTML parser.
const stripTags = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');

async function readHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (got < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, Math.min(value.byteLength, maxBytes - got));
    chunks.push(take);
    got += take.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

export interface LivenessResult {
  alive: boolean;
  status: number;
  bodyText?: string; // captured only for 2xx responses when a quote needs checking
}

export async function checkLiveness(
  url: string,
  wantBody: boolean,
  fetcher: Fetcher,
  timeoutMs = 5000,
): Promise<LivenessResult> {
  const ctl = new AbortController();
  // One deadline for the WHOLE exchange: a server that returns headers then
  // trickles the body must not hang the ingest request (review finding).
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: { accept: "text/html,*/*" },
    });
    const alive =
      res.ok || res.status === 401 || res.status === 402 || res.status === 403 || res.status === 304;
    let bodyText: string | undefined;
    if (res.ok && wantBody && res.body) {
      // Quote text is only meaningful on a readable 2xx body — a 403
      // challenge page can never contain the quote (review finding).
      try {
        bodyText = await readHead(res, HEAD_BYTES);
      } catch {
        bodyText = undefined; // slow/aborted body → quote unverifiable, NOT dead
      }
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { alive, status: res.status, bodyText };
  } catch {
    return { alive: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function quoteAppears(quote: string, pageText: string): boolean {
  const q = normWs(quote.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  if (q.length < 8) return true; // too short to verify meaningfully
  const hay = normWs(stripTags(pageText).replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  return hay.includes(q);
}

export function independentHosts(item: IngestItem): string[] {
  const hosts = new Set<string>();
  const h0 = canonHost(item.url);
  if (h0) hosts.add(h0);
  for (const s of item.sources ?? []) {
    const h = canonHost(s);
    if (h) hosts.add(h);
  }
  return [...hosts];
}

const firstIndependentSource = (item: IngestItem): string | undefined => {
  const h0 = canonHost(item.url);
  return (item.sources ?? []).find((s) => {
    const h = canonHost(s);
    return h && h !== h0;
  });
};

// Validate a batch: liveness for every item (bounded concurrency), quote
// check where a quote is pinned, two-source verification for priority 3.
export async function validateBatch(
  items: IngestItem[],
  fetcher: Fetcher,
  opts?: { concurrency?: number; skipNetwork?: boolean },
): Promise<ValidationOutcome> {
  const out: ValidationOutcome = { ok: [], rejected: [], demoted: [], unverified: [] };
  const conc = Math.max(1, Math.min(opts?.concurrency ?? 5, 6)); // Workers: 6 simultaneous connections

  // Host-count half of the two-source rule: pure, no network.
  const staged: IngestItem[] = [];
  for (const item of items) {
    if (item.priority === 3 && independentHosts(item).length < 2) {
      out.demoted.push({ item: { ...item, priority: 2 }, from: 3, to: 2, reason: "two-source-rule" });
      staged.push({ ...item, priority: 2 });
    } else {
      staged.push(item);
    }
  }

  if (opts?.skipNetwork) {
    out.ok.push(...staged);
    return out;
  }

  let i = 0;
  const workers = Array.from({ length: conc }, async () => {
    while (i < staged.length) {
      const item = staged[i++];
      const wantBody = !!item.quote;
      const live = await checkLiveness(item.url, wantBody, fetcher);
      if (!live.alive) {
        out.rejected.push({ item, reason: `url-dead:${live.status}` });
        continue;
      }

      let accepted = item;

      // Quote policy (review finding): verify against 2xx bodies only;
      // unverifiable quotes are stripped, never trusted and never fatal.
      if (item.quote) {
        if (live.bodyText === undefined) {
          const { quote: _dropped, ...rest } = item;
          accepted = rest as IngestItem;
          out.unverified.push({ item, reason: `quote-unverifiable:${live.status}` });
        } else if (!quoteAppears(item.quote, live.bodyText)) {
          out.rejected.push({ item, reason: "quote-not-found" });
          continue;
        }
      }

      // Network half of the two-source rule (review finding): the second
      // host must actually answer, or a fabricated source keeps priority 3.
      if (accepted.priority === 3) {
        const second = firstIndependentSource(accepted);
        const secondLive = second ? await checkLiveness(second, false, fetcher) : { alive: false };
        if (!secondLive.alive) {
          out.demoted.push({ item: { ...accepted, priority: 2 }, from: 3, to: 2, reason: "second-source-dead" });
          accepted = { ...accepted, priority: 2 };
        }
      }

      out.ok.push(accepted);
    }
  });
  await Promise.all(workers);
  return out;
}
