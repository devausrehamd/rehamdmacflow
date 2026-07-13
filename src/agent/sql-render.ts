// src/agent/sql-render.ts
//
// The presentation layer: turns SQL result rows into prose the LLM reads
// reliably. This is the ONE place structured query results become natural
// language before entering a reasoning prompt.
//
// Why this exists as its own module:
//   - LLMs (especially smaller local ones) read prose far more reliably than
//     raw JSON rows. A row like [{"result": 2}] forces the model to parse
//     structure and infer that "result" means the answer; "Count: 2" does not.
//   - Isolating the translation here means adapting to a different model, or
//     a different presentation style, is a change to ONE file - not scattered
//     through prompt code.
//
// The renderer matches the prose form to the result SHAPE:
//   - empty            -> a plain statement (and "count is 0" for aggregates)
//   - single value     -> a labelled sentence ("Count: 2")
//   - one row          -> one labelled line
//   - a few rows        -> a readable numbered list of labelled fields
//   - many rows         -> the first N, plus "... and M more not shown"
//
// It never emits raw JSON. Column names are humanised (date_identified ->
// "date identified"), and the aggregate alias "result" is relabelled using
// the actual function from the executed SQL (Count / Sum / Average / ...).

// The shape the presentation layer needs from a SQL result. Defined here
// (the lower-level module) and re-exported by prompts.ts for convenience.
export interface SqlResultForPrompt {
  displayName: string;
  executedSql: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}

// Above this many rows we summarise rather than dump the whole result into
// the prompt - both to respect the context window and because a model reads
// a focused list better than a hundred lines.
const MAX_ROWS_SHOWN = 20;

const AGG_RE = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;

/** Turn a sql_name into something readable: date_identified -> "date identified". */
function humaniseColumn(name: string): string {
  if (name === "result") return "result";
  return name.replace(/_/g, " ");
}

/** Format a single cell value for prose. Nulls become "(empty)". */
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "(empty)";
  if (typeof v === "string") return v.trim() === "" ? "(empty)" : v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/** Map the aggregate function in the SQL to a readable label. */
function aggregateLabel(sql: string): string {
  const m = sql.match(AGG_RE);
  if (!m) return "Result";
  switch (m[1].toUpperCase()) {
    case "COUNT":
      return "Count";
    case "SUM":
      return "Sum";
    case "AVG":
      return "Average";
    case "MIN":
      return "Minimum";
    case "MAX":
      return "Maximum";
    default:
      return "Result";
  }
}

/**
 * Render one SQL result as prose. Returns a block of text with no raw JSON,
 * shaped to the result's size so the model reads it as stated facts.
 */
export function renderSqlResult(result: SqlResultForPrompt): string {
  const { rows, executedSql } = result;
  const isAggregate = AGG_RE.test(executedSql);

  // --- Empty result ---
  if (rows.length === 0) {
    return isAggregate
      ? "No matching records — the count is 0."
      : "No matching records were found.";
  }

  // --- Single row ---
  if (rows.length === 1) {
    const row = rows[0];
    const keys = Object.keys(row);

    // Single value: an aggregate answer (the common "how many" case)
    if (keys.length === 1) {
      const key = keys[0];
      const value = formatValue(row[key]);
      const label = key === "result" ? aggregateLabel(executedSql) : capitalise(humaniseColumn(key));
      return `${label}: ${value}`;
    }

    // One row, several columns: a single labelled sentence
    const parts = keys.map((k) => `${humaniseColumn(k)} = ${formatValue(row[k])}`);
    return `One matching record — ${parts.join(", ")}.`;
  }

  // --- Multiple rows: a readable numbered list ---
  const shown = rows.slice(0, MAX_ROWS_SHOWN);
  const lines = shown.map((row, i) => {
    const parts = Object.keys(row).map((k) => `${humaniseColumn(k)} = ${formatValue(row[k])}`);
    return `  ${i + 1}. ${parts.join(", ")}`;
  });

  let out = `${rows.length} matching records:\n${lines.join("\n")}`;
  if (rows.length > MAX_ROWS_SHOWN) {
    out += `\n  … and ${rows.length - MAX_ROWS_SHOWN} more not shown.`;
  }
  return out;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Render several SQL results into one prose block for the prompt's
 * EXACT DATA section. Each is prefixed with its table name so the model
 * knows the source.
 */
export function renderSqlResults(results: SqlResultForPrompt[]): string {
  return results
    .map((r) => `From "${r.displayName}" (exact database result):\n${renderSqlResult(r)}`)
    .join("\n\n");
}