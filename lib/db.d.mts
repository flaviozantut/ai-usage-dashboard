import type { DatabaseSync } from "node:sqlite";
import type { Event } from "../src/types.js";

/** The shared, already-initialized SQLite handle (WAL + busy_timeout). */
export declare const db: DatabaseSync;

/** Inserts one event or a batch; returns how many rows were written (ext_id duplicates ignored). */
export declare function insertEvents(events: Event | Event[]): number;

/** Consolidated stats for a task/issue (used by the /dash_stats CLI). */
export declare function taskStats(taskId: string): {
  task_id: string;
  summary: Record<string, number | string | null>;
  by_model: unknown[];
  top_tools: unknown[];
  latency: { p50_ms: number | null; p95_ms: number | null; avg_ms: number | null };
};
