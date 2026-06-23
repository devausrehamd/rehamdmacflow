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
// Inferred types - export for use in application code
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;

export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;

export type AuditEntry = typeof audit_log.$inferSelect;
export type NewAuditEntry = typeof audit_log.$inferInsert;