import { toAuthorizationHeader } from "./credentials";

const MODEL_ID = /^[a-z0-9][a-z0-9._/-]*$/i;

export class PlatformError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(messageFromBody(status, body));
    this.name = "PlatformError";
    this.status = status;
    this.body = body;
  }
}

export type QueuedGeneration = {
  status: string;
  requestId: string;
  statusUrl: string;
  cancelUrl: string;
};

export type GenerationStatus = {
  status: string;
  requestId: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: unknown;
};

/** One request's answer inside a batched status poll. A request that errors
    carries its reason alone, so it cannot lose the answers standing beside it. */
export type StatusResult =
  | { requestId: string; status: GenerationStatus }
  | { requestId: string; error: string };

/** A trained Soul ID. `status` walks not_ready → queued → in_progress and
    settles on completed or failed. */
export type Character = {
  id: string;
  name: string;
  status: string;
  modelVersion: string;
  thumbnailUrl: string | null;
  createdAt: string;
  failReason: string | null;
};

export const CHARACTER_TERMINAL = new Set(["completed", "failed"]);

export type PlatformClientOptions = {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
};

export function isModelId(model: string): boolean {
  return MODEL_ID.test(model) && !model.includes("..");
}

export function createPlatformClient(options: PlatformClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const auth = toAuthorizationHeader(options.apiKey);

  async function send(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const url = `${baseUrl}${path}`;
    console.info("[platform] request", { method, url, body: body ?? null });
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const payload = await readJson(response);
    console.info("[platform] response", { method, url, status: response.status, body: payload });
    if (!response.ok) throw new PlatformError(response.status, payload);
    return payload;
  }

  return {
    async submit(model: string, input: Record<string, unknown>): Promise<QueuedGeneration> {
      if (!isModelId(model)) throw new PlatformError(400, { detail: "Invalid model" });
      return mapQueued(await send("POST", `/${model}`, input));
    },
    async status(requestId: string): Promise<GenerationStatus> {
      if (!requestId) throw new PlatformError(400, { detail: "Missing request id" });
      return mapStatus(await send("GET", `/requests/${encodeURIComponent(requestId)}/status`));
    },
    /** Two steps: the platform hands out a presigned S3 slot, the bytes go
        straight to it. The slot is tagged `retention=temporary`, so the
        public URL is an input for the next request, not a place to keep
        anything. */
    async upload(bytes: Uint8Array, contentType: string): Promise<string> {
      const slot = asRecord(
        await send("POST", "/files/generate-upload-url", { content_type: contentType }),
      );
      const uploadUrl = stringField(slot, "upload_url");
      const publicUrl = stringField(slot, "public_url");
      if (!uploadUrl || !publicUrl) {
        throw new PlatformError(502, { detail: "Platform response missing upload url" });
      }
      const headers = asRecord(slot.upload_headers);
      const put = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers: Object.keys(headers).length
          ? (headers as Record<string, string>)
          : { "Content-Type": contentType },
        body: bytes as BodyInit,
      });
      if (!put.ok) throw new PlatformError(put.status, { detail: "Upload to storage failed" });
      return publicUrl;
    },
    async createCharacter(input: {
      name: string;
      imageUrls: string[];
      modelVersion?: string;
    }): Promise<Character> {
      return mapCharacter(
        await send("POST", "/v1/custom-references", {
          name: input.name,
          input_images: input.imageUrls.map((url) => ({ type: "image_url", image_url: url })),
          ...(input.modelVersion ? { model_version: input.modelVersion } : {}),
        }),
      );
    },
    async getCharacter(id: string): Promise<Character> {
      if (!id) throw new PlatformError(400, { detail: "Missing character id" });
      return mapCharacter(await send("GET", `/v1/custom-references/${encodeURIComponent(id)}`));
    },
    async listCharacters(): Promise<Character[]> {
      const data = asRecord(await send("GET", "/v1/custom-references/list?page=1&page_size=50"));
      const items = Array.isArray(data.items) ? data.items.map(mapCharacter) : [];
      /* The list carries no training photos, so the face for the card comes
         from each character's own record. */
      return Promise.all(
        items.map((item) =>
          item.thumbnailUrl
            ? item
            : this.getCharacter(item.id).catch(() => item),
        ),
      );
    },
  };
}

function mapCharacter(payload: unknown): Character {
  const data = asRecord(payload);
  const id = stringField(data, "id");
  if (!id) throw new PlatformError(502, { detail: "Platform response missing character id" });
  return {
    id,
    name: stringField(data, "name") ?? "",
    status: stringField(data, "status") ?? "unknown",
    modelVersion: stringField(data, "model_version") ?? "",
    /* The platform leaves thumbnail_url null on trained characters; the first
       training photo is the face the studio can show instead. */
    thumbnailUrl:
      stringField(data, "thumbnail_url") ??
      (Array.isArray(data.reference_media)
        ? (stringField(asRecord(data.reference_media[0]), "media_url") ?? null)
        : null),
    createdAt: stringField(data, "created_at") ?? "",
    failReason: stringField(data, "fail_reason") ?? null,
  };
}

function mapQueued(payload: unknown): QueuedGeneration {
  const data = asRecord(payload);
  const requestId = stringField(data, "request_id");
  if (!requestId) throw new PlatformError(502, { detail: "Platform response missing request_id" });
  return {
    status: stringField(data, "status") ?? "queued",
    requestId,
    statusUrl: stringField(data, "status_url") ?? "",
    cancelUrl: stringField(data, "cancel_url") ?? "",
  };
}

function mapStatus(payload: unknown): GenerationStatus {
  const data = asRecord(payload);
  const requestId = stringField(data, "request_id") ?? "";
  const images = Array.isArray(data.images)
    ? data.images.flatMap((item) => {
        const url = asRecord(item).url;
        return typeof url === "string" ? [{ url }] : [];
      })
    : undefined;
  const videoUrl = asRecord(data.video).url;

  return {
    status: stringField(data, "status") ?? "unknown",
    requestId,
    ...(images?.length ? { images } : {}),
    ...(typeof videoUrl === "string" ? { video: { url: videoUrl } } : {}),
    ...(data.error !== undefined ? { error: data.error } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function messageFromBody(status: number, body: unknown): string {
  const detail = asRecord(body).detail;
  if (typeof detail === "string" && detail) return detail;
  return `Platform request failed (${status})`;
}
