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
import { extractTables } from "./table-extract.js";

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

  const outputPath = join(outputRoot, `${file.relativePath}.md`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf-8");

  // Extract structured tables for the SQL path (xlsx sheets, docx tables).
  // Returns [] for handlers that don't produce tables (passthrough, pdf).
  // Extraction failures don't abort conversion - the markdown/vector path
  // still works even if table extraction has trouble.
  let tables;
  try {
    tables = await extractTables(file, strategy.handler);
  } catch (err) {
    console.warn(
      `    table extraction failed for ${file.relativePath}: ${err instanceof Error ? err.message : err}`,
    );
    tables = [];
  }

  return {
    sourceFile: file,
    markdown,
    convertedPath: outputPath,
    metadata,
    tables,
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

  // Read the file as a buffer and parse with XLSX.read.
  // We avoid XLSX.readFile because it's not reliably exported in ESM
  // contexts with the npm-distributed xlsx package.
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

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (rows.length === 0) {
      parts.push("_(empty sheet)_\n");
      continue;
    }

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
  const cleaned = data.text.replace(/\n{3,}/g, "\n\n").trim();
  return {
    markdown: cleaned,
    metadata: {
      format: "pdf",
      pageCount: data.numpages,
    },
  };
}