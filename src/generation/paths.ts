import { resolve } from "node:path";

/* The studio lives in a folder that holds more than code:

     Open Higgsfield/
       app/     ← this repository (the server runs from here)
       datos/   ← what the studio keeps: objects, characters
       logs/    ← server output and the event log

   Everything is found relative to the app, so the whole folder can move and
   keep working. OHF_ROOT overrides it for a checkout that lives elsewhere. */
export const ROOT_DIR = process.env.OHF_ROOT ?? resolve(/*turbopackIgnore: true*/ process.cwd(), "..");
export const DATA_DIR = resolve(/*turbopackIgnore: true*/ ROOT_DIR, "datos");
export const LOGS_DIR = resolve(/*turbopackIgnore: true*/ ROOT_DIR, "logs");
