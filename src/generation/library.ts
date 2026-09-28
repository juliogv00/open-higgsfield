import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/* Reference sets live on this disk, not on the platform: its uploads are
   tagged `retention=temporary`, so a set is re-uploaded every time it is used
   rather than trusted to a URL that will expire. */
export const LIBRARY_ROOT =
  process.env.OHF_LIBRARY_DIR ??
  join(homedir(), "Library/Application Support/OpenHiggsfield/objetos");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^\d{2}\.jpg$/;

export type ObjectSet = {
  id: string;
  name: string;
  createdAt: string;
  files: string[];
};

export function objectId(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "objeto";
}

export function assertObjectId(id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid object id");
  return id;
}

export function objectFilePath(id: string, file: string): string {
  if (!FILE_RE.test(file)) throw new Error("Invalid object file");
  return join(LIBRARY_ROOT, assertObjectId(id), file);
}

export async function listObjectSets(): Promise<ObjectSet[]> {
  let entries: string[];
  try {
    entries = await readdir(/*turbopackIgnore: true*/ LIBRARY_ROOT);
  } catch {
    return [];
  }
  const sets = await Promise.all(
    entries.filter((entry) => ID_RE.test(entry)).map((id) => readObjectSet(id).catch(() => null)),
  );
  return sets
    .filter((set): set is ObjectSet => set !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readObjectSet(id: string): Promise<ObjectSet> {
  const dir = join(LIBRARY_ROOT, assertObjectId(id));
  const meta = JSON.parse(await readFile(/*turbopackIgnore: true*/ join(dir, "meta.json"), "utf8")) as {
    name?: string;
    createdAt?: string;
  };
  const files = (await readdir(/*turbopackIgnore: true*/ dir)).filter((file) => FILE_RE.test(file)).sort();
  return { id, name: meta.name ?? id, createdAt: meta.createdAt ?? "", files };
}

export async function writeObjectSet(name: string, images: Uint8Array[]): Promise<ObjectSet> {
  const base = objectId(name);
  const taken = new Set((await listObjectSets()).map((set) => set.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const dir = join(/*turbopackIgnore: true*/ LIBRARY_ROOT, id);
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const createdAt = new Date().toISOString();
  await writeFile(/*turbopackIgnore: true*/ join(dir, "meta.json"), JSON.stringify({ name, createdAt }, null, 1));
  await Promise.all(
    images.map((bytes, index) =>
      writeFile(/*turbopackIgnore: true*/ join(dir, `${String(index + 1).padStart(2, "0")}.jpg`), bytes),
    ),
  );
  return readObjectSet(id);
}

export async function removeObjectSet(id: string): Promise<void> {
  await rm(/*turbopackIgnore: true*/ join(LIBRARY_ROOT, assertObjectId(id)), { recursive: true, force: true });
}
