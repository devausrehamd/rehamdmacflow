// Per-format converters that take a source file and produce markdown.
// Each returns the markdown text and any structural metadata that downstream
// chunking will use.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import pdfParse from "pdf-parse";
import type {
  SourceFile,
  ConvertedDocument,
  ConversionStrategy,
} from "./types.js";

export async function convertFile(
  file: SourceFile,
  strategy: ConversionStrategy,
  outputRoot: string,
): Promise<ConvertedDocument> {
  let markdown: string;
  let metadata: Record<string, unknown> = {};

  switch (strategy.handler) {
    case "passthrough":
      markdown = await readFile(file.absolutePath, "utf-8");
      break;
    case "docx-to-md":
      ({ markdown, metadata } = await convertDocx(file));
      break;
    case "xlsx-to-md":
      ({ markdown, metadata } = await convertXlsx(file, strategy.options ?? {}));
      break;
    case "pdf-to-md":
      ({ markdown, metadata } = await convertPdf(file));
      break;
    default:
      throw new Error(`Unknown handler: ${strategy.handler}`);
  }

  // Write converted markdown to the conversion output directory
  // mirroring the source's relative path
  const outputPath = join(outputRoot, `${file.relativePath}.md`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf-8");

  return {
    sourceFile: file,
    markdown,
    convertedPath: outputPath,
    metadata,
  };
}

async function convertDocx(
  file: SourceFile,
): Promise<{ markdown: string; metadata: Record<string, unknown> }> {
  const result = await mammoth.convertToMarkdown({ path: file.absolutePath });
  const warnings = result.messages.filter((m) => m.type === "warning");
  return {
    markdown: result.value,
    metadata: {
      format: "docx",
      conversionWarnings: warnings.length,
    },
  };
}

async function convertXlsx(
  file: SourceFile,
  options: Record<string, unknown>,
): Promise<{ markdown: string; metadata: Record<string, unknown> }> {
  const preserveHeaders = options.preserveHeaders !== false;
  const buf = await readFile(file.absolutePath);
  const workbook = XLSX.read(buf, { type: "buffer" });
  const sheetSummaries: Array<{ name: string; rows: number; cols: number }> = [];
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;
    sheetSummaries.push({ name: sheetName, rows: rowCount, cols: colCount });

    parts.push(`# Sheet: ${sheetName}\n`);
    parts.push(`> ${rowCount} rows, ${colCount} columns\n`);

    // Convert sheet to a 2D array of values
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rows.length === 0) {
      parts.push("_(empty sheet)_\n");
      continue;
    }

    // Build a markdown table
    // First row treated as header if preserveHeaders is true
    const headerRow = preserveHeaders ? rows[0] : null;
    const dataRows = preserveHeaders ? rows.slice(1) : rows;

    if (headerRow) {
      const headers = headerRow.map((c) => String(c ?? "").trim() || " ");
      parts.push(`| ${headers.join(" | ")} |`);
      parts.push(`|${headers.map(() => "---").join("|")}|`);
    }

    for (const row of dataRows) {
      const cells = row.map((c) => {
        const text = String(c ?? "").trim();
        // Escape pipes and newlines to keep table syntax valid
        return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
      });
      parts.push(`| ${cells.join(" | ")} |`);
    }
    parts.push("");
  }

  return {
    markdown: parts.join("\n"),
    metadata: {
      format: "xlsx",
      sheets: sheetSummaries,
    },
  };
}

async function convertPdf(
  file: SourceFile,
): Promise<{ markdown: string; metadata: Record<string, unknown> }> {
  const buf = await readFile(file.absolutePath);
  const data = await pdfParse(buf);
  // pdf-parse returns plain text; we add a minimal markdown wrapper.
  // For higher-quality PDF conversion you'd reach for unstructured or a
  // dedicated layout-aware tool, but this is reasonable for text PDFs.
  const cleaned = data.text.replace(/\n{3,}/g, "\n\n").trim();
  return {
    markdown: cleaned,
    metadata: {
      format: "pdf",
      pageCount: data.numpages,
    },
  };
}