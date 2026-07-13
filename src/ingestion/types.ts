// Shared types for the ingestion pipeline

export interface IngestionConfig {
  source: SourceConfig;
  conversion: ConversionConfig;
  chunking: ChunkingConfig;
  qdrant: QdrantConfig;
}

export interface SourceConfig {
  type: "git" | "local";
  url: string;
  branch: string;
  subpath: string;
  localPath: string;
}

export interface ConversionConfig {
  outputPath: string;
  strategies: Record<string, ConversionStrategy>;
  skipPatterns: string[];
}

export interface ConversionStrategy {
  handler: "passthrough" | "docx-to-md" | "xlsx-to-md" | "pdf-to-md";
  options?: Record<string, unknown>;
}

export interface ChunkingConfig {
  default: ChunkStrategy;
  perFileType: Record<string, ChunkStrategy>;
}

export interface ChunkStrategy {
  // "semantic" respects sentence/paragraph boundaries - use this for prose.
  // "characters" is naive fixed-window chunking - kept as fallback.
  // "tabular" is for spreadsheet content - groups rows with header repeat.
  // "structured" is heading-aware: chunks within markdown sections and tags
  //   each chunk with its heading path + section id, enabling structural
  //   retrieval (adaptive parent expansion). Use for well-sectioned prose.
  strategy: "semantic" | "characters" | "tabular" | "structured";
  size?: number;
  overlap?: number;
  rowsPerChunk?: number;
  repeatHeaders?: boolean;
}

export interface QdrantConfig {
  collection: string;
  recreateOnIngest: boolean;
}

// Document representation through the pipeline

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
}

export interface ConvertedDocument {
  sourceFile: SourceFile;
  markdown: string;
  convertedPath: string;
  metadata: Record<string, unknown>;
  // Structured tables extracted from this document (xlsx sheets, docx tables).
  // Empty for prose-only documents. These feed the SQL path; the markdown
  // still feeds the vector path so prose around tables stays searchable.
  tables: ExtractedTableData[];
}

// A table extracted from a document, ready to load into SQL. This mirrors
// the ExtractedTable shape the loader consumes, minus the provenance fields
// the pipeline fills in (sourcePath, sha, tier).
export interface ExtractedTableData {
  sheetName?: string | null;
  tableIndex: number;
  displayName: string;
  headers: string[];
  rows: unknown[][];
  extractionMethod: string;
  extractionConfidence: number;
  /** Tier-2 semantics lifted from the workbook's own legend sheet, if any. */
  legend?: {
    columnNotes: Record<string, string>;
    tableNotes: string[];
    sourceSheet: string | null;
  };
}

export interface DocumentChunk {
  text: string;
  index: number;
  totalChunks: number;
  startOffset?: number;
  endOffset?: number;
  sheetName?: string;
  rowRange?: [number, number];

  // Structural fields (set by the heading-aware "structured" chunker).
  // section_id identifies the deepest section this chunk belongs to;
  // parent_section_id its immediate parent; heading_path the full chain of
  // headings from document root (e.g. "4 Design Controls > 4.3 Verification >
  // 4.3.1 Methods"); sectionNumber the numbered label if present ("4.3.1");
  // level the heading depth. These enable structural retrieval (adaptive
  // parent expansion) downstream.
  sectionId?: string;
  parentSectionId?: string | null;
  headingPath?: string;
  sectionNumber?: string | null;
  headingText?: string;
  level?: number;
}

export interface IngestionStats {
  filesDiscovered: number;
  filesSkipped: number;
  filesConverted: number;
  filesFailed: number;
  totalChunks: number;
  totalPoints: number;
  tablesLoaded: number;
  errors: Array<{ file: string; error: string }>;
  elapsedSeconds: number;
}