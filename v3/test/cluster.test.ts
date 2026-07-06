import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DUP_COSINE, SAGA_COSINE, blobToVec, clusterCandidate, cosine, sharesEntityProxy, vecToBlob,
} from "../src/lib/cluster";
import type { StoredStory } from "../src/newsroom";

const vec = (...n: number[]) => Float32Array.from(n);

describe("cosine + blob round-trip", () => {
  it("computes cosine correctly", () => {
    expect(cosine(vec(1, 0), vec(1, 0))).toBeCloseTo(1, 6);
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6);
    expect(cosine(vec(1, 1), vec(1, 0))).toBeCloseTo(Math.SQRT1_2, 6);
  });
  it("round-trips vectors through BLOB encoding", () => {
    const v = vec(0.25, -1.5, 3.125);
    expect([...blobToVec(vecToBlob(v))!]).toEqual([...v]);
    expect(blobToVec(null)).toBeNull();
    expect(blobToVec(new Uint8Array([1, 2, 3]))).toBeNull(); // not float-aligned
  });
});

describe("clusterCandidate verdicts", () => {
  const recent = [
    { story_id: "s1", saga_id: null, desk: "world", title: "Summit reaches climate agreement", vec: vec(1, 0, 0) },
    { story_id: "s2", saga_id: "saga-x", desk: "world", title: "Minister resigns over leaked memo", vec: vec(0, 1, 0) },
  ];

  it("no vector => new (graceful absence)", () => {
    expect(clusterCandidate({ desk: "world", title: "Anything", vec: null }, recent).kind).toBe("new");
  });

  it("near-identical same-desk story is a duplicate, inheriting the saga root", () => {
    const v = clusterCandidate(
      { desk: "world", title: "Summit reaches final climate agreement", vec: vec(0.999, 0.01, 0) },
      recent,
    );
    expect(v.kind).toBe("duplicate");
    expect(v.sagaId).toBe("s1"); // saga root = matched story when it has no saga yet
  });

  it("same development below the dup bar chains into the saga", () => {
    // cosine ~0.89: between SAGA (0.85) and DUP (0.93)
    const v = clusterCandidate(
      { desk: "world", title: "Climate agreement fallout continues", vec: vec(0.9, 0.436, 0) },
      recent,
    );
    expect(v.kind).toBe("saga");
    expect(v.sagaId).toBe("s1");
  });

  it("existing saga ids propagate", () => {
    const v = clusterCandidate(
      { desk: "world", title: "Minister resignation aftermath deepens", vec: vec(0, 0.995, 0.1) },
      recent,
    );
    expect(v.sagaId).toBe("saga-x");
  });

  it("high cosine WITHOUT a shared significant title token stays new (entity proxy)", () => {
    const v = clusterCandidate(
      { desk: "world", title: "Utterly unrelated words here", vec: vec(0.999, 0.01, 0) },
      recent,
    );
    expect(v.kind).toBe("new");
  });

  it("near-identical story on a DIFFERENT desk is saga, not duplicate", () => {
    const v = clusterCandidate(
      { desk: "ev", title: "Summit reaches climate agreement for EVs", vec: vec(0.999, 0.01, 0) },
      recent,
    );
    expect(v.kind).toBe("saga");
  });

  it("thresholds are ordered sanely", () => {
    expect(DUP_COSINE).toBeGreaterThan(SAGA_COSINE);
  });
});

describe("NewsroomDO clustering (synthetic vectors, direct RPC)", () => {
  const row = (id: string, title: string, v: Float32Array | null, over: Partial<StoredStory> = {}): StoredStory => ({
    story_id: id,
    embedding: v,
    desk: "world",
    title,
    summary: "s",
    why: null,
    url: `https://example.com/${id}`,
    canon_url: `https://example.com/${id}`,
    title_key: `t:world|${title.toLowerCase()}`,
    sources: [],
    salience: 50,
    priority: 1,
    published_at: null,
    quote: null,
    editorial_read: null,
    added_at: new Date().toISOString(),
    ...over,
  });

  const stub = () => {
    const ns = (env as Record<string, any>).NEWSROOM;
    return ns.get(ns.idFromName("cluster-test")) as any;
  };

  it("chains a follow-up into a saga and drops a near-identical repeat", async () => {
    const n = stub();
    const base = await n.ingestBatch([row("c1", "Reactor deal signed with consortium", vec(1, 0, 0))]);
    expect(base.inserted).toBe(1);

    const followUp = await n.ingestBatch([
      row("c2", "Reactor deal faces first legal challenge", vec(0.9, 0.436, 0)),
    ]);
    expect(followUp.inserted).toBe(1);
    expect(followUp.sagaLinked).toBe(1);

    const repeat = await n.ingestBatch([
      row("c3", "Reactor deal signed with the consortium", vec(0.999, 0.01, 0)),
    ]);
    expect(repeat.inserted).toBe(0);
    expect(repeat.clusterDups).toBe(1);

    const feed = await n.feed(10);
    const c2 = feed.find((s: any) => s.story_id === "c2");
    expect(c2?.saga_id).toBe("c1");
  });

  it("stories without vectors still insert (embedding failure never costs an edition)", async () => {
    const n = stub();
    const res = await n.ingestBatch([row("c4", "Completely separate development entirely", null)]);
    expect(res.inserted).toBe(1);
  });
});
