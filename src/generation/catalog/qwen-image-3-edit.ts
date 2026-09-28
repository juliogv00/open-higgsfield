import type { ModelEntry } from "./types";

/* The step that puts an object into a shot: image 1 is the scene (a Soul run
   with a character), images 2–3 the object. Verified on a real run — it keeps
   face, pose and light, and places the object. References go as `image_urls`
   through the shared mapper. */
export const qwenImage3Edit: ModelEntry = {
  id: "qwen-image-3-edit",
  surface: "image",
  label: "Qwen Image 3 Edit",
  roles: { reference: 3 },
  settings: {
    aspectRatio: { type: "enum", values: ["1:1", "4:3", "3:4", "16:9", "9:16"], default: "3:4" },
    resolution: { type: "enum", values: ["1k", "2k"], default: "1k" },
  },
  paths: { reference: "alibaba/qwen-image-3/edit" },
};
