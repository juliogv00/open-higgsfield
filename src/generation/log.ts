import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { LOGS_DIR } from "./paths";

/* A trace of what left for the platform — model, request id, character — so a
   result can be tied back to its call. No prices: the API exposes none, and
   the real spend lives on the Higgsfield dashboard. */
const LOG = process.env.OHF_LOG_FILE ?? join(LOGS_DIR, "eventos.log");

export async function logEvent(event: Record<string, unknown>) {
  try {
    await appendFile(
      /*turbopackIgnore: true*/ LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), app: "open-higgsfield", ...event })}\n`,
    );
  } catch {
    /* the log never blocks a generation */
  }
}
