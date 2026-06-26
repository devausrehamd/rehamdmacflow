// src/db/schema.ts
//
// Drizzle ORM schema definitions for the Postgres-backed durable state.
//
// Tables and their roles:
//   users       - account records, role assignments
//   drafts      - human-approved deliverables (the QMS output)
//   decisions   - cross-document policy ("Class B firmware uses V-model")
//   lessons     - context-specific guidance accumulated from human reviews
//   audit_log   - long-term archive of API actions (recent goes to Redis stream)
//
// Hot/ephemeral state lives in Redis (active queries, refresh tokens, working
// memory). This file defines the durable side.

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  uuid,
  index,
} from "drizzle-orm/pg-core";

// ============================================================================
// Users
// ============================================================================

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password_hash: varchar("password_hash", { length: 255 }).notNull(),
  role: varchar("role", { length: 32 }).notNull(),
  display_name: varchar("display_name", { length: 255 }),
  is_active: boolean("is_active").notNull().default(true),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  last_login_at: timestamp("last_login_at", { withTimezone: true }),
});

// ============================================================================
// Drafts
// ============================================================================

export const drafts = pgTable(
  "drafts",
  {
    // String IDs in the form "draft_<hex>" for human-readable URLs and logs
    id: varchar("id", { length: 64 }).primaryKey(),
    // Link to the Redis query record that produced this draft
    query_id: varchar("query_id", { length: 64 }),
    doc_type: varchar("doc_type", { length: 32 }).notNull(),
    project_id: varchar("project_id", { length: 64 }),
    brief: text("brief").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default("{}"),
    // pending_review | approved | rejected | withdrawn
    status: varchar("status", { length: 32 }).notNull().default("pending_review"),
    author_id: uuid("author_id")
      .notNull()
      .references(() => users.id),
    reviewer_id: uuid("reviewer_id").references(() => users.id),
    review_comment: text("review_comment"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewed_at: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => ({
    by_author: index("drafts_author_idx").on(table.author_id),
    by_status: index("drafts_status_idx").on(table.status),
    by_project: index("drafts_project_idx").on(table.project_id),
  }),
);

// ============================================================================
// Standing decisions - cross-document policy
// ============================================================================

export const decisions = pgTable(
  "decisions",
  {
    id: serial("id").primaryKey(),
    scope: varchar("scope", { length: 64 }).notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale"),
    established_by: uuid("established_by")
      .notNull()
      .references(() => users.id),
    established_at: timestamp("established_at", { withTimezone: true }).notNull().defaultNow(),
    // active | superseded | retired
    status: varchar("status", { length: 32 }).notNull().default("active"),
    superseded_by: integer("superseded_by"),
  },
  (table) => ({
    by_scope: index("decisions_scope_idx").on(table.scope),
    by_status: index("decisions_status_idx").on(table.status),
  }),
);

// ============================================================================
// Lessons - context-specific guidance from approved reviews
// ============================================================================

export const lessons = pgTable(
  "lessons",
  {
    id: serial("id").primaryKey(),
    doc_type: varchar("doc_type", { length: 32 }).notNull(),
    context_snippet: text("context_snippet"),
    lesson: text("lesson").notNull(),
    issue: text("issue"),
    source_doc_id: varchar("source_doc_id", { length: 64 }),
    source_doc_version: varchar("source_doc_version", { length: 32 }),
    reviewer_id: uuid("reviewer_id")
      .notNull()
      .references(() => users.id),
    // Optional reference to the draft that triggered this lesson
    source_draft_id: varchar("source_draft_id", { length: 64 }),
    // active | retired
    status: varchar("status", { length: 32 }).notNull().default("active"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_doc_type: index("lessons_doc_type_idx").on(table.doc_type),
    by_status: index("lessons_status_idx").on(table.status),
  }),
);

// ============================================================================
// Audit log - long-term archive
// ============================================================================

export const audit_log = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    request_id: varchar("request_id", { length: 64 }).notNull(),
    user_id: uuid("user_id").references(() => users.id),
    user_email: varchar("user_email", { length: 255 }),
    user_role: varchar("user_role", { length: 32 }),
    method: varchar("method", { length: 16 }).notNull(),
    path: varchar("path", { length: 512 }).notNull(),
    status_code: integer("status_code"),
    duration_ms: integer("duration_ms"),
    ip_address: varchar("ip_address", { length: 64 }),
    user_agent: text("user_agent"),
    resource_ids: jsonb("resource_ids"),
    details: jsonb("details"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_user: index("audit_user_idx").on(table.user_id),
    by_request: index("audit_request_idx").on(table.request_id),
    by_created: index("audit_created_idx").on(table.created_at),
  }),
);

// ============================================================================
// Table registry - maps extracted tables to their UUID-named SQL tables
//
// Every table extracted from a document (xlsx sheet, docx table, future
// pdf/OCR table) gets a registry entry. The registry id IS the table's
// UUID; the physical SQL table is named "tbl_" + the uuid hex (dashes
// stripped, since SQL identifiers can't contain dashes or start with a
// digit).
//
// The registry is the bridge between the human-meaningful identity of a
// table and its unguessable physical name, and it carries the schema the
// data API needs to validate queries.
//
// Future-proofing fields for the visual extraction pipeline (not used in
// the xlsx/docx-only first build, but present so adding OCR later needs
// no migration):
//   extraction_method     - how the table was extracted
//   extraction_confidence - 0..1 confidence; the loader gates on this
//   source_region         - page/bbox provenance for OCR'd tables
// ============================================================================

export const table_registry = pgTable(
  "table_registry",
  {
    // The UUID is both the registry key and the basis for the physical
    // table name (tbl_<uuid_hex>).
    id: uuid("id").primaryKey().defaultRandom(),

    // Provenance: which document, which version, which table within it
    source_path: text("source_path").notNull(),
    source_sha256: varchar("source_sha256", { length: 64 }).notNull(),
    sheet_name: varchar("sheet_name", { length: 255 }),
    table_index: integer("table_index").notNull().default(0),

    // Human-meaningful identity
    display_name: varchar("display_name", { length: 512 }).notNull(),

    // Permission domain
    tier: varchar("tier", { length: 32 }).notNull().default("operations"),

    // Column definitions: array of { original, sql_name, type, nullable, sample_values }
    column_schema: jsonb("column_schema").notNull(),

    row_count: integer("row_count").notNull().default(0),

    // The dual-purpose description: embedded into the vector store AND
    // read by the LLM as the query manual
    blurb: text("blurb").notNull(),

    // Future-proofing for the visual/OCR pipeline
    extraction_method: varchar("extraction_method", { length: 32 })
      .notNull()
      .default("xlsx_cells"),
    extraction_confidence: integer("extraction_confidence").notNull().default(100),
    source_region: jsonb("source_region"),

    // Lifecycle: active | superseded
    status: varchar("status", { length: 32 }).notNull().default("active"),
    superseded_by: uuid("superseded_by"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_source: index("registry_source_idx").on(table.source_path),
    by_status: index("registry_status_idx").on(table.status),
    by_tier: index("registry_tier_idx").on(table.tier),
    by_display: index("registry_display_idx").on(table.display_name),
  }),
);

// ============================================================================
// Inferred types - export for use in application code
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type TableRegistryEntry = typeof table_registry.$inferSelect;
export type NewTableRegistryEntry = typeof table_registry.$inferInsert;

export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;

export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;

export type AuditEntry = typeof audit_log.$inferSelect;
export type NewAuditEntry = typeof audit_log.$inferInsert;