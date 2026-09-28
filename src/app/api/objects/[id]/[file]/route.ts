import { readFile } from "node:fs/promises";

import { objectFilePath } from "@/generation/library";

/* Thumbnails for the object library. Local files only: the path is rebuilt
   from a validated id and a two-digit file name, never taken from the URL. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; file: string }> },
) {
  const { id, file } = await params;
  try {
    const bytes = await readFile(/*turbopackIgnore: true*/ objectFilePath(id, file));
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
