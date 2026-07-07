// gzip helpers for backup objects (RUNBOOK §4). Streams API only — no
// byte-surgery libraries (the v2 MP3-header lesson generalises).

export async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  void writer.close();
  return await new Response(ds.readable).text();
}
