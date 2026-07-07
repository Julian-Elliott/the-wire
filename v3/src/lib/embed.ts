// Workers AI embeddings at ingest (V3_BLUEPRINT §3): bge-m3 on title+lede,
// ~4.3 neurons/day of the 10,000 free daily — permanently $0 at our scale.
// GRACEFUL ABSENCE by design: if the AI binding is missing or errors, stories
// persist without vectors and clustering degrades to exact-key dedup only —
// embedding failure must never cost an edition (V3_BLUEPRINT §3 lesson).

const MODEL = "@cf/baai/bge-m3";
const LEDE_CHARS = 220;

export const embeddingInput = (title: string, summary: string): string =>
  `${title}. ${summary.slice(0, LEDE_CHARS)}`;

interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export async function embedTexts(
  ai: AiLike | undefined,
  texts: string[],
): Promise<(Float32Array | null)[]> {
  if (!ai || texts.length === 0) return texts.map(() => null);
  try {
    const res = (await ai.run(MODEL, { text: texts })) as { data?: number[][] };
    const data = res?.data;
    if (!Array.isArray(data)) return texts.map(() => null);
    return texts.map((_, i) =>
      Array.isArray(data[i]) && data[i].length > 0 ? Float32Array.from(data[i]) : null,
    );
  } catch {
    return texts.map(() => null);
  }
}
