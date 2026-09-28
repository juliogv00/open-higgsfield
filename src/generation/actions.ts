"use server";

import { readFile } from "node:fs/promises";

import { cookies } from "next/headers";

import { getModel, parseSettings } from "./catalog";
import type { GenerationPlane } from "./catalog/types";
import {
  MissingCredentialsError,
  PLATFORM_KEY_COOKIE,
  PLATFORM_KEY_COOKIE_OPTIONS,
  decodeCredentials,
  encodeCredentials,
  parseCredentialInput,
} from "./credentials";
import { normalizeMedia } from "./images";
import { readKeychainKey } from "./keychain";
import {
  listObjectSets,
  objectFilePath,
  readObjectSet,
  removeObjectSet,
  writeObjectSet,
} from "./library";
import type { ObjectSet } from "./library";
import { createPlatformClient } from "./platform";
import type { Character, StatusResult } from "./platform";
import {
  CHARACTER_TRAINING_CREDITS,
  CREDIT_EUR,
  logEvent,
  priceFor,
  reserveSpend,
  spendToday,
} from "./spend";
import { toPlatform } from "./to-platform";

/** Photos Higgsfield asks for to train a face: at least 5, 20+ recommended. */
const CHARACTER_MIN_PHOTOS = 5;
const CHARACTER_MAX_PHOTOS = 80;
const UPLOAD_MAX_BYTES = 40 * 1024 * 1024;

export async function savePlatformCredentials(data: unknown) {
  const { apiKey } = parseCredentialInput(data);
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, encodeCredentials(apiKey), PLATFORM_KEY_COOKIE_OPTIONS);
}

export async function clearPlatformCredentials() {
  const jar = await cookies();
  jar.set(PLATFORM_KEY_COOKIE, "", { ...PLATFORM_KEY_COOKIE_OPTIONS, maxAge: 0 });
}

export async function hasPlatformCredentials() {
  return (await readStoredCredentials()) !== null;
}

export async function submitGeneration(plane: GenerationPlane) {
  const model = getModel(plane.model);
  const parsed: GenerationPlane = {
    ...plane,
    settings: parseSettings(model, plane.settings),
    character: model.character ? parseCharacter(plane.character) : undefined,
  };
  const { path, body } = toPlatform(parsed);
  const client = createPlatformClient(await readCredentials());
  const results = Number(parsed.settings.batchSize) || 1;
  await reserveSpend(priceFor(model, results), {
    event: "generate",
    model: model.id,
    path,
    character: parsed.character?.id,
    references: Object.values(parsed.media).reduce((n, list) => n + (list?.length ?? 0), 0),
  });
  const queued = await client.submit(path, body);
  await logEvent({ event: "queued", model: model.id, request_id: queued.requestId });
  return queued;
}

/** Every request in flight, answered in one round trip. Next dispatches server
    actions one at a time per client, so a poll per run would queue ahead of the
    next submit — the fan-out belongs on this side of the call, where it is
    genuinely parallel. */
export async function getGenerationStatuses(data: unknown): Promise<StatusResult[]> {
  const requestIds = parseRequestIds(data);
  const client = createPlatformClient(await readCredentials());
  return Promise.all(
    requestIds.map(async (requestId): Promise<StatusResult> => {
      try {
        return { requestId, status: await client.status(requestId) };
      } catch (caught) {
        return { requestId, error: caught instanceof Error ? caught.message : String(caught) };
      }
    }),
  );
}

/* ── Uploads ──────────────────────────────────────────────────────────────
   The browser hands the file to the server, which normalizes it (HEIC, EXIF
   rotation, size) and puts it on the platform's own storage. No third-party
   bucket, and the key never leaves this side. */

export async function uploadMedia(form: FormData): Promise<{ url: string }> {
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("Missing file");
  if (file.size > UPLOAD_MAX_BYTES) throw new Error("File is larger than 40 MB");
  const client = createPlatformClient(await readCredentials());
  const { bytes, contentType } = await normalizeMedia(
    new Uint8Array(await file.arrayBuffer()),
    file.name,
    file.type,
  );
  return { url: await client.upload(bytes, contentType) };
}

/* ── Characters (Soul ID) ─────────────────────────────────────────────── */

export async function getCharacterTrainingQuote() {
  const { spent, cap } = await spendToday();
  return {
    credits: CHARACTER_TRAINING_CREDITS,
    eur: CHARACTER_TRAINING_CREDITS * CREDIT_EUR,
    spent,
    cap,
    minPhotos: CHARACTER_MIN_PHOTOS,
    maxPhotos: CHARACTER_MAX_PHOTOS,
  };
}

export async function listCharacters(): Promise<Character[]> {
  return createPlatformClient(await readCredentials()).listCharacters();
}

export async function getCharacter(id: unknown): Promise<Character> {
  if (typeof id !== "string" || !id) throw new Error("Invalid character id");
  return createPlatformClient(await readCredentials()).getCharacter(id);
}

/** Trains a Soul ID from photos already uploaded through `uploadMedia`. The
    price is booked before the request leaves: a failed training is charged. */
export async function createCharacter(data: unknown): Promise<Character> {
  const payload = asObject(data, "Invalid character payload");
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name || name.length > 60) throw new Error("Give the character a name");
  const urls = Array.isArray(payload.imageUrls)
    ? payload.imageUrls.filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
    : [];
  if (urls.length < CHARACTER_MIN_PHOTOS) {
    throw new Error(`At least ${CHARACTER_MIN_PHOTOS} photos are needed`);
  }
  if (urls.length > CHARACTER_MAX_PHOTOS) {
    throw new Error(`At most ${CHARACTER_MAX_PHOTOS} photos are accepted`);
  }
  const client = createPlatformClient(await readCredentials());
  await reserveSpend(CHARACTER_TRAINING_CREDITS * CREDIT_EUR, {
    event: "character_train",
    name,
    photos: urls.length,
  });
  const character = await client.createCharacter({ name, imageUrls: urls });
  await logEvent({ event: "character_queued", name, soul_id: character.id });
  return character;
}

/* ── Objects (local reference sets) ───────────────────────────────────── */

export async function listObjects(): Promise<ObjectSet[]> {
  return listObjectSets();
}

export async function saveObject(form: FormData): Promise<ObjectSet> {
  const name = String(form.get("name") ?? "").trim();
  if (!name || name.length > 60) throw new Error("Give the object a name");
  const files = form.getAll("files").filter((file): file is File => file instanceof File);
  if (files.length === 0) throw new Error("Add at least one image");
  if (files.length > 14) throw new Error("At most 14 images per object");
  const images = await Promise.all(
    files.map(async (file) => {
      if (file.size > UPLOAD_MAX_BYTES) throw new Error(`${file.name} is larger than 40 MB`);
      const { bytes, contentType } = await normalizeMedia(
        new Uint8Array(await file.arrayBuffer()),
        file.name,
        file.type,
      );
      if (contentType !== "image/jpeg") throw new Error(`${file.name} is not an image`);
      return bytes;
    }),
  );
  return writeObjectSet(name, images);
}

export async function deleteObject(id: unknown): Promise<void> {
  if (typeof id !== "string") throw new Error("Invalid object id");
  await removeObjectSet(id);
}

/** Puts an object's images back on the platform and returns their fresh URLs,
    in the set's own order — the first image is the one a single-reference
    model receives. */
export async function stageObject(id: unknown, limit: unknown): Promise<string[]> {
  if (typeof id !== "string") throw new Error("Invalid object id");
  const set = await readObjectSet(id);
  const max = typeof limit === "number" && limit > 0 ? Math.floor(limit) : set.files.length;
  const client = createPlatformClient(await readCredentials());
  return Promise.all(
    set.files.slice(0, max).map(async (file) =>
      client.upload(new Uint8Array(await readFile(/*turbopackIgnore: true*/ objectFilePath(id, file))), "image/jpeg"),
    ),
  );
}

/* ── Credentials ──────────────────────────────────────────────────────── */

/* The Keychain comes first — the same entries the VMNTe gateway reads — and
   the key typed into the modal is the fallback for a machine without them. */
async function readStoredCredentials() {
  const keychain = await readKeychainKey();
  if (keychain) return { apiKey: keychain };
  const jar = await cookies();
  return decodeCredentials(jar.get(PLATFORM_KEY_COOKIE)?.value);
}

async function readCredentials() {
  const stored = await readStoredCredentials();
  if (!stored) throw new MissingCredentialsError();
  const baseUrl = process.env.HF_API_BASE_URL;
  if (!baseUrl) throw new Error("Missing HF_API_BASE_URL");
  return { ...stored, baseUrl };
}

function parseRequestIds(data: unknown): string[] {
  const payload = asObject(data, "Invalid status payload");
  const requestIds = payload.requestIds;
  if (!Array.isArray(requestIds) || requestIds.length === 0) {
    throw new Error("Invalid request ids");
  }
  return requestIds.map((requestId) => {
    if (typeof requestId !== "string" || !requestId) throw new Error("Invalid request id");
    return requestId;
  });
}

function parseCharacter(data: unknown): GenerationPlane["character"] {
  if (data === undefined || data === null) return undefined;
  const { id, strength } = asObject(data, "Invalid character");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid character");
  if (typeof strength !== "number" || strength < 0 || strength > 1) {
    throw new Error("Invalid character strength");
  }
  return { id, strength };
}

function asObject(data: unknown, message: string): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error(message);
  return data as Record<string, unknown>;
}
