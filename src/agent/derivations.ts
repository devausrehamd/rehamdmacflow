// src/agent/derivations.ts
//
// The derivation registry (increment 2 of the deterministic/LLM boundary
// contract). A place in the QMS — git-tracked, versioned, like rubrics/ — to
// DEFINE interpretive terms in the vocabulary the deterministic evaluator
// understands: "critical" -> score >= 16.
//
// The planner is an LLM, and left alone it GUESSES at a term like "critical"
// (increment 1 showed it produce an impossible likelihood = 5). With a definition
// in hand it doesn't guess: the definition is injected into the planner prompt as
// authoritative, so the model decodes "critical" to the exact grounded filter the
// QMS declared. A term that is NOT defined here stays undefined — the grounding
// gate (grounding.ts) calls it out rather than let the guess through.
//
// Definitions decode; the deterministic engine still executes and is the source
// of truth. The LLM never asserts a value — only reproduces the declared filter.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ColumnSchema } from "../data/table-schema.js";

const DERIVATIONS_DIR = process.env.QMS_DERIVATIONS_DIR ?? "derivations";

const filterOp = z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "ilike", "is_null", "is_not_null"]);

const derivationSchema = z.object({
  term: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  /** Scope to a table by display-name substring; inherits the file's table if omitted. */
  table: z.string().optional(),
  predicate: z.object({ column: z.string().min(1), op: filterOp, value: z.unknown() }),
  definition: z.string().min(1),
});

const fileSchema = z.object({
  table: z.string().optional(),
  derivations: z.array(derivationSchema),
});

export type Derivation = z.infer<typeof derivationSchema> & { table?: string };

let cache: Derivation[] | null = null;

/** Load and flatten every derivation file. Cached; a malformed file is skipped
 *  with a loud warning rather than breaking all query planning. */
export function loadDerivations(dir: string = DERIVATIONS_DIR): Derivation[] {
  if (cache) return cache;
  const out: Derivation[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = fileSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
        for (const d of parsed.derivations) {
          out.push({ ...d, table: d.table ?? parsed.table });
        }
      } catch (err) {
        console.error(`[derivations] skipping ${name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  cache = out;
  return out;
}

/** Reset the cache — for tests that load from a fixture directory. */
export function resetDerivationCache(): void {
  cache = null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentioned(question: string, term: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`).test(question);
}

/**
 * Every derivation DEFINED for a table (independent of the question): the
 * predicate's column exists and the table scope, if any, matches. Used to tell a
 * caller which interpretive terms the QMS does define when it abstains on one.
 */
export function derivationsForTable(
  tableDisplayName: string,
  columns: ColumnSchema[],
  all: Derivation[] = loadDerivations(),
): Derivation[] {
  const cols = new Set(columns.map((c) => c.sql_name));
  const name = tableDisplayName.toLowerCase();
  return all.filter((d) => cols.has(d.predicate.column) && (!d.table || name.includes(d.table.toLowerCase())));
}

/**
 * The derivations that apply to THIS question and table: defined for the table
 * (derivationsForTable) AND the term or one of its aliases appears in the question.
 */
export function applicableDerivations(
  question: string,
  tableDisplayName: string,
  columns: ColumnSchema[],
  all: Derivation[] = loadDerivations(),
): Derivation[] {
  const q = question.toLowerCase();
  return derivationsForTable(tableDisplayName, columns, all).filter((d) =>
    [d.term, ...(d.aliases ?? [])].some((t) => mentioned(q, t)),
  );
}

/** Render the applicable definitions as a planner-prompt block. Each shows the
 *  EXACT filter JSON to reproduce, so the model copies rather than invents. */
export function definitionsBlock(defs: Derivation[]): string {
  if (defs.length === 0) return "";
  const lines = defs.map((d) => {
    const p = d.predicate;
    const filter = JSON.stringify({ column: p.column, op: p.op, value: p.value });
    return `- "${d.term}" means ${filter}  (${d.definition})`;
  });
  return `Defined terms for this table — when the question uses one of these terms, apply the EXACT filter shown and do NOT invent your own for it:\n${lines.join("\n")}`;
}
