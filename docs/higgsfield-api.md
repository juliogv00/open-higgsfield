# Higgsfield API — what is known, and how it was verified

The platform publishes almost no schemas (`GET /models` returns `input_schema: null`
for every model) and **queues requests without validating them**: an unknown or
misnamed field is dropped in silence and the run is charged all the same. So every
fact here says how it was established. Add to this file whenever something new is
learned, with the date and the evidence.

Base URL `https://api.higgsfield.ai` · auth header `Authorization: Key <id>:<secret>`
(Cloudflare in front rejects requests without a browser-like `User-Agent` from
some clients; Node's fetch is fine).

## Generation

| Call | Fact | Evidence |
|---|---|---|
| `POST /{model-slug}` | Returns `{request_id, status, status_url, cancel_url}` | upstream code + real runs |
| `GET /requests/{id}/status` | Terminal states: `completed`, `failed`, `nsfw`, `canceled`; images in `images[].url` | real runs |
| Outputs | CDN URLs expire after about 7 days | platform notice, gateway spec |

## Characters (Soul ID)

| Call | Fact | Evidence |
|---|---|---|
| `POST /v1/custom-references` `{name, input_images:[{type:"image_url", image_url}]}` | Starts training; returns `model_version: "v1"` | official `higgsfield-js` SDK + real run 2026-09-28 |
| `GET /v1/custom-references/{id}` | Status `not_ready → queued → in_progress → completed / failed`; includes `reference_media[]` | real run |
| `GET /v1/custom-references/list` | Paginated; **no** `reference_media`, `thumbnail_url` is null | real run |
| Soul 2 + `custom_reference_id` (+ `custom_reference_strength` 0–1) | Works with a `v1` character on `higgsfield-ai/soul/v2/standard` | 2026-09-28: prompt with no facial traits produced the person |
| Training time | ~1 min queued + ~10 min training (33 photos) | real run |
| Training cost | **Unconfirmed.** Not listed as a request nor in "Spend today" on the dashboard; the balance gap suggests ~40 credits | dashboard 2026-09-28 |
| CLI flag `--soul-2` / `--soul-cinematic` at training | Probably a `model_version` field; not tested on the API | official CLI docs |

## Image references

| Model | Field | Result |
|---|---|---|
| Soul 2 (`higgsfield-ai/soul/v2/standard`) | `image_url`, `image_reference{type,image_url}`, `image_urls`, `image_references`, `input_images` | ❌ **all ignored**, charged (2026-09-28) |
| Qwen Image 3 Edit (`alibaba/qwen-image-3/edit`) | `image_urls: [scene, object]` + `aspect_ratio` + `resolution: "1k"` | ✅ keeps face, pose and light; places the object |

Consequence: a character + an object is two steps — Soul 2 for the person, then
Qwen Image 3 Edit with the shot first and the object after it.

## Uploads

| Call | Fact | Evidence |
|---|---|---|
| `POST /files/generate-upload-url {content_type}` | Returns `upload_url`, `public_url`, `upload_headers` | SDK + real run |
| `PUT upload_url` | **Must** send `upload_headers` (includes `x-amz-tagging: retention=temporary`) | real run |
| Lifetime | Temporary — keep anything that must last in `datos/objetos/` | the tag above |

## Account

No balance, credits, usage or transactions endpoint answers to the API key
(about twenty `GET` paths tried on `api.` and `platform.`, all 405). Spend and
balance live only on the `cloud.higgsfield.ai` dashboard.

## How to verify a new field cheaply

1. Pick the cheapest settings (720p or 1k, one result).
2. Write a prompt that does **not** describe what the field should add, so the
   result can only show it if the field was honoured.
3. One run per candidate — or several candidate names in one request, then bisect.
4. Record the outcome here, success or not.
