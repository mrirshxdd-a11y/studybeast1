import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Manifest = { type: string; size: number; chunkSize: number; chunks: number };

// Serves admin-uploaded media (logo, QR, demo video). Files are stored as fixed-size
// chunks so large videos can be uploaded and streamed with HTTP Range support.
export default async (req: Request, context: Context) => {
  const id = context.params.id;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || "")) return new Response("Not found", { status: 404 });
  const store = getStore("media");
  const manifest = (await store.get(`m/${id}`, { type: "json" })) as Manifest | null;
  if (!manifest) return new Response("Not found", { status: 404 });

  const base = {
    "content-type": manifest.type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
  };
  const readChunk = async (n: number) => {
    const buf = await store.get(`c/${id}/${n}`, { type: "arrayBuffer" });
    if (!buf) throw new Error("Missing chunk");
    return new Uint8Array(buf);
  };

  const range = req.headers.get("range");
  const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (match && (match[1] || match[2])) {
    let start: number, end: number;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : manifest.size - 1;
    } else {
      start = Math.max(0, manifest.size - Number(match[2]));
      end = manifest.size - 1;
    }
    if (start >= manifest.size || start > end) {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${manifest.size}` } });
    }
    // Serve at most one stored chunk per response; players request the next range automatically.
    const n = Math.floor(start / manifest.chunkSize);
    const chunkStart = n * manifest.chunkSize;
    const chunk = await readChunk(n);
    end = Math.min(end, chunkStart + chunk.length - 1);
    const slice = chunk.subarray(start - chunkStart, end - chunkStart + 1);
    return new Response(slice, {
      status: 206,
      headers: { ...base, "content-length": String(slice.length), "content-range": `bytes ${start}-${end}/${manifest.size}` },
    });
  }

  if (manifest.chunks === 1) {
    const chunk = await readChunk(0);
    return new Response(chunk, { headers: { ...base, "content-length": String(chunk.length) } });
  }
  let i = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (i >= manifest.chunks) return controller.close();
      controller.enqueue(await readChunk(i++));
    },
  });
  return new Response(stream, { headers: { ...base, "content-length": String(manifest.size) } });
};

export const config: Config = { path: "/api/media/:id", method: ["GET", "HEAD"] };
