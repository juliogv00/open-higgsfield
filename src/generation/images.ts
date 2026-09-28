import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";

const run = promisify(execFile);

/** Longest edge sent to the platform. Phone photos arrive at 4032 px; the
    models read far less, and every byte crosses the network twice. */
const MAX_EDGE = 2048;

const PASSTHROUGH = new Set(["video/mp4", "audio/wav", "audio/x-wav", "audio/mpeg"]);

export type Normalized = { bytes: Uint8Array; contentType: string };

function isHeic(name: string, type: string) {
  return /heic|heif/i.test(type) || /\.(heic|heif)$/i.test(name);
}

/* sharp's prebuilt libvips reads HEIF only as AVIF — iPhone HEVC needs a
   licensed decoder it does not ship. macOS has one: sips hands back a JPEG
   that still carries the EXIF orientation, which sharp then bakes in. */
async function heicToJpeg(bytes: Uint8Array): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "ohf-heic-"));
  try {
    const input = join(dir, "in.heic");
    const output = join(dir, "out.jpg");
    await writeFile(input, bytes);
    await run("sips", ["-s", "format", "jpeg", input, "--out", output]);
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every still becomes an upright JPEG no larger than MAX_EDGE. The platform
    is not trusted to honor EXIF rotation, so none is left for it to read. */
export async function normalizeMedia(
  bytes: Uint8Array,
  name: string,
  type: string,
): Promise<Normalized> {
  if (PASSTHROUGH.has(type)) return { bytes, contentType: type };
  if (type.startsWith("image/gif")) return { bytes, contentType: type };
  const source = isHeic(name, type) ? await heicToJpeg(bytes) : Buffer.from(bytes);
  const out = await sharp(source)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { bytes: new Uint8Array(out), contentType: "image/jpeg" };
}
