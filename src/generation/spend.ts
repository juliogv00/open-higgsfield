import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelEntry } from "./catalog/types";

/* One daily ledger (and optional ceiling) for everything that spends on Higgsfield: this studio and
   the VMNTe image gateway (:8199) read and write the same ledger. The platform
   exposes no balance endpoint, so this is the only automatic brake there is. */
const LEDGER = join(homedir(), "dev/logs/imagen-gateway-spend.json");
const LOG = join(homedir(), "dev/logs/open-higgsfield.log");
/* 0 = no cap: every spend is still counted and logged, nothing is cut. */
const DAILY_CAP_EUR = Number(process.env.IMAGEN_GATEWAY_CAP_EUR ?? "0");

/* Declared rates, deliberately high — the API reports `base_credits` as 0 for
   almost every model. Same convention as the gateway: 1 credit ≈ 0.10 EUR. */
export const CREDIT_EUR = 0.1;
export const CHARACTER_TRAINING_CREDITS = 40;
const IMAGE_EUR = 0.1;
const VIDEO_EUR = 0.5;
const VIDEO_PREMIUM_EUR = 1;

export class SpendCapError extends Error {
  constructor(spent: number, price: number) {
    super(
      `Daily spending cap reached: ${spent.toFixed(2)} € of ${DAILY_CAP_EUR.toFixed(2)} €. ` +
        `This would cost ${price.toFixed(2)} €. Raise IMAGEN_GATEWAY_CAP_EUR or wait until tomorrow.`,
    );
    this.name = "SpendCapError";
  }
}

type Ledger = { date: string; spent_eur: number; generations: number };

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function readLedger(): Promise<Ledger> {
  try {
    const data = JSON.parse(await readFile(/*turbopackIgnore: true*/ LEDGER, "utf8")) as Partial<Ledger>;
    if (data.date === today() && typeof data.spent_eur === "number") {
      return { date: data.date, spent_eur: data.spent_eur, generations: data.generations ?? 0 };
    }
  } catch {
    /* missing or unreadable: a fresh day */
  }
  return { date: today(), spent_eur: 0, generations: 0 };
}

export function priceFor(model: ModelEntry, results: number): number {
  if (model.surface === "image") return IMAGE_EUR * results;
  const premium = /pro|4k/i.test(model.id);
  return (premium ? VIDEO_PREMIUM_EUR : VIDEO_EUR) * results;
}

/** Throws before anything is sent when the price would cross the day's cap,
    then books it. Booked at submit, not on completion: a failed platform job
    is charged all the same. */
export async function reserveSpend(price: number, event: Record<string, unknown>) {
  const ledger = await readLedger();
  if (DAILY_CAP_EUR > 0 && ledger.spent_eur + price > DAILY_CAP_EUR) throw new SpendCapError(ledger.spent_eur, price);
  ledger.spent_eur = Math.round((ledger.spent_eur + price) * 10_000) / 10_000;
  ledger.generations += 1;
  await mkdir(/*turbopackIgnore: true*/ dirname(LEDGER), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ LEDGER, JSON.stringify(ledger, null, 1));
  await logEvent({ ...event, price_eur_estimado: price, spent_today_eur: ledger.spent_eur });
}

export async function spendToday(): Promise<{ spent: number; cap: number }> {
  return { spent: (await readLedger()).spent_eur, cap: DAILY_CAP_EUR };
}

export async function logEvent(event: Record<string, unknown>) {
  try {
    await appendFile(/*turbopackIgnore: true*/ 
      LOG,
      `${JSON.stringify({ ts: new Date().toISOString(), app: "open-higgsfield", ...event })}\n`,
    );
  } catch {
    /* the log never blocks a generation */
  }
}
