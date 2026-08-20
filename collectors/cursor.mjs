#!/usr/bin/env node
/**
 * Cursor backfill via Admin API — exact tokens + productivity (accept rate).
 * Requires a Team/Business plan and an admin key. Idempotent by ext_id.
 *
 * Writes straight to the local SQLite DB — no server needed.
 *
 * Env: IA_USAGE_DASHBOARD_DB_PATH (SQLite file), CURSOR_API_KEY (required), CURSOR_DAYS (default 30)
 */
import { fetchTokenEvents, fetchDailyProductivity } from "../lib/cursor-api.mjs";
import { insertEvents } from "../lib/db.mjs";

const CURSOR_KEY = process.env.CURSOR_API_KEY;
const DAYS = Number(process.env.CURSOR_DAYS ?? 30);

if (!CURSOR_KEY) {
  console.error("Set CURSOR_API_KEY.");
  process.exit(1);
}

const endDate = Date.now();
const startDate = endDate - DAYS * 86400_000;

function post(events) {
  if (!events.length) return 0;
  return insertEvents(events);
}

const tokenEvents = await fetchTokenEvents(CURSOR_KEY, startDate, endDate);
const insTok = await post(tokenEvents);
const prodEvents = await fetchDailyProductivity(CURSOR_KEY, startDate, endDate);
const insProd = await post(prodEvents);

console.log(
  `cursor backfill: tokens ${tokenEvents.length} read/${insTok} new · ` +
    `productivity ${prodEvents.length} days/${insProd} new.`
);
