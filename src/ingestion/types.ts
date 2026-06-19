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
  strategy: "semantic" | "characters" | "tabular";
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
}

export interface DocumentChunk {
  text: string;
  index: number;
  totalChunks: number;
  startOffset?: number;
  endOffset?: number;
  sheetName?: string;
  rowRange?: [number, number];
}

export interface IngestionStats {
  filesDiscovered: number;
  filesSkipped: number;
  filesConverted: number;
  filesFailed: number;
  totalChunks: number;
  totalPoints: number;
  errors: Array<{ file: string; error: string }>;
  elapsedSeconds: number;
}