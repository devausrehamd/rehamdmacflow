// src/orchestrator/exporter.ts
//
// The exporter role (Phase 6 of docs/specs/SPEC-agent-topology-and-custody-dag.md).
//
// A PURE function: a typed document model -> bytes. It takes the structured
// section model (never prose, never markdown to re-parse) and renders it. Being
// pure and deterministic is the whole point: the same model renders to the same
// bytes, and because the model is custody-recorded, the exported document is
// REPRODUCIBLE FROM THE LEDGER — an auditor can replay the exporter over the
// recorded data and get byte-identical output.
//
// MVP format is markdown. docx / xlsx are the same shape (model -> bytes) and
// slot in as additional providers.

import type { CapabilityProvider } from "./capabilities.js";

export interface RenderedSection {
  id: string;
  title: string;
  cardinality: "single" | "array";
  /** Each row is field name -> value, exactly as generated + validated. */
  rows: Record<string, unknown>[];
}

export interface DocumentModel {
  documentType: string;
  title: string;
  sections: RenderedSection[];
}

export interface ExportResult {
  format: string;
  filename: string;
  contentType: string;
  /** Text for md; base64 bytes for binary formats (docx/xlsx) later. */
  content: string;
}

/**
 * Render a document model to markdown. Deterministic: field order is stable
 * (union of row keys, sorted), so identical models yield byte-identical output.
 */
export function renderMarkdown(model: DocumentModel): ExportResult {
  const lines: string[] = [`# ${model.title}`, ""];

  for (const section of model.sections) {
    lines.push(`## ${section.title}`, "");
    if (section.rows.length === 0) {
      lines.push("_(no data)_", "");
      continue;
    }
    const fields = [...new Set(section.rows.flatMap((r) => Object.keys(r)))].sort();

    if (section.cardinality === "array") {
      lines.push(`| ${fields.join(" | ")} |`);
      lines.push(`| ${fields.map(() => "---").join(" | ")} |`);
      for (const row of section.rows) {
        lines.push(`| ${fields.map((f) => cell(row[f])).join(" | ")} |`);
      }
      lines.push("");
    } else {
      const row = section.rows[0] ?? {};
      for (const f of fields) lines.push(`- **${f}:** ${cell(row[f])}`);
      lines.push("");
    }
  }

  const content = lines.join("\n");
  return { format: "md", filename: `${model.documentType}.md`, contentType: "text/markdown", content };
}

/** Escape a value for a single markdown cell / line. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  return String(v);
}

/** The markdown exporter as a capability provider (`export:md`). Pure under the
 *  async provider shape; the executor resolves it by capability like any other. */
export function markdownExporter(): CapabilityProvider {
  return {
    capability: "export:md",
    async run(query) {
      return { result: renderMarkdown(query as DocumentModel) };
    },
  };
}
