#!/usr/bin/env node
/**
 * Backfill do Cursor via Admin API — tokens exatos + produtividade (accept rate).
 * Requer plano Team/Business e admin key. Idempotente por ext_id.
 *
 * Env: DASH_API, CURSOR_API_KEY (obrigatório), CURSOR_DAYS (default 30)
 */
import { fetchTokenEvents, fetchDailyProductivity } from "../lib/cursor-api.mjs";

const API = process.env.DASH_API ?? "http://localhost:8787/events";
const CURSOR_KEY = process.env.CURSOR_API_KEY;
const DAYS = Number(process.env.CURSOR_DAYS ?? 30);

if (!CURSOR_KEY) {
  console.error("Defina CURSOR_API_KEY.");
  process.exit(1);
}

const endDate = Date.now();
const startDate = endDate - DAYS * 86400_000;

async function post(events) {
  if (!events.length) return 0;
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(events),
  });
  if (!res.ok) throw new Error(`Ingest ${res.status}: ${await res.text()}`);
  return (await res.json()).inserted;
}

const tokenEvents = await fetchTokenEvents(CURSOR_KEY, startDate, endDate);
const insTok = await post(tokenEvents);
const prodEvents = await fetchDailyProductivity(CURSOR_KEY, startDate, endDate);
const insProd = await post(prodEvents);

console.log(
  `cursor backfill: tokens ${tokenEvents.length} lidos/${insTok} novos · ` +
    `produtividade ${prodEvents.length} dias/${insProd} novos.`
);
