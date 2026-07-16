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
  bigserial,
  bigint,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  uuid,
  index,
  primaryKey,
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

    // Enforcement labels inherited from the source document's classification.
    // The data API refuses a table_id whose labels do not intersect the
    // caller's. Default [] means invisible - fail closed for pre-label rows.
    access_labels: jsonb("access_labels").notNull().default([]),

    // What this table is ABOUT. Scopes a prerequisite: "an approved risk
    // register" is the wrong question, "for Summit" is the right one. Null
    // means the document declared no project, and satisfies no prerequisite.
    project: varchar("project", { length: 64 }),

    // What KIND of form this is. Enables ENUMERATION: "all risk registers" is
    // a set-membership query over this column, NOT a top-K vector search.
    // Retrieval discovers that a kind of thing exists; the registry
    // enumerates which ones. Null means excluded from every aggregate.
    collection: varchar("collection", { length: 64 }),

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
// Draft-and-review pipeline (draft mode)
// ============================================================================
//
// The consistency unit is the DRAFT SET. Linked documents are generated,
// reviewed, and dispositioned together. Disposition (OK / RERUN / ABORT) is
// a single set-level decision. Each review pass is a ROUND (the rerun loop),
// recorded for audit. Reviewer feedback is captured as structured ISSUE ITEMS.
//
// Provenance is baked in: a set references the originating request, and each
// round records the exact rubric version/hash that governed it, so any
// document's full derivation and the standard it was judged against are
// reconstructable.

// A draft set: the consistency unit. Linked documents belong to one set and
// are dispositioned together.
export const draft_sets = pgTable(
  "draft_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Provenance: the request/query that triggered generation. Links a
    // produced document back to the prompt that made it. This is a query id
    // (qry_<hex>) - it is NOT a user id, and must never be used to identify
    // the author (that mistake is what silently disabled APPROVER != AUTHOR).
    originating_query_id: text("originating_query_id").notNull(),

    // WHO triggered generation. The counterpart of the approver: the
    // disposition endpoint refuses when these are the same person. Nullable
    // only for rows predating this column - an unknown author FAILS CLOSED
    // (unprovable independence means no approval), it does not pass.
    author_id: varchar("author_id", { length: 64 }),

    // The document type - the hub that resolves generation prompt, rubric
    // bundle, threshold, and required sources.
    document_type: varchar("document_type", { length: 64 }).notNull(),

    // WHICH project this instance is for. A prerequisite check matches on
    // (document_type, subject): an approved DFMEA for Denali must not satisfy
    // a DFMEA for Summit. Null is a legacy set that satisfies nothing.
    subject: varchar("subject", { length: 64 }),

    // The rubric version/hash governing this set (audit anchor - the exact
    // standard applied, reconstructable from git even after the rubric evolves).
    rubric_version: varchar("rubric_version", { length: 64 }).notNull(),
    rubric_hash: varchar("rubric_hash", { length: 64 }).notNull(),

    // Lifecycle: generating | pending_review | regenerating | approved | aborted
    status: varchar("status", { length: 32 }).notNull().default("generating"),

    // Final set-level disposition once decided: ok | rerun | abort
    disposition: varchar("disposition", { length: 16 }),
    disposition_reason: text("disposition_reason"),

    // How many times this set has regenerated (informational; the human
    // decides when to stop, never auto-enforced).
    rerun_count: integer("rerun_count").notNull().default(0),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_query: index("draft_sets_query_idx").on(table.originating_query_id),
    by_status: index("draft_sets_status_idx").on(table.status),
    by_type: index("draft_sets_type_idx").on(table.document_type),
    by_author: index("draft_sets_author_idx").on(table.author_id),
  }),
);

// A draft document: content plus its evaluation results. Belongs to a set.
// No disposition field - disposition is set-level.
export const draft_documents = pgTable(
  "draft_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    set_id: uuid("set_id")
      .notNull()
      .references(() => draft_sets.id, { onDelete: "cascade" }),

    title: varchar("title", { length: 512 }).notNull(),

    // Which declared section this is (rubric.sections[].id).
    section_id: varchar("section_id", { length: 64 }),

    // THE CANONICAL ARTIFACT: the validated, typed rows the validator produced.
    // Not markdown, not prose - the exact ValidatedRow[] with per-field values,
    // gaps, and the recomputed computed fields. Every rendered format (markdown,
    // docx, xlsx) is a faithful projection OF this; none is edited after it.
    // Storing text here would force a lossy serialise at persist time and break
    // the render-from-validated-rows contract.
    rows: jsonb("rows"),

    // A rendered markdown projection, cached for review-in-viewer. Nullable:
    // it is derived from `rows` and can always be regenerated. Never the source
    // of truth.
    content: text("content"),

    // Correlation id linking this document to its custody chain and its
    // originating request across agents.
    correlation_id: varchar("correlation_id", { length: 64 }),

    // Unified rubric result: per-criterion pass/fail + the aggregate. Replaces
    // the old objective_scores / expert_results split (the unified criteria
    // model has one flat list, one result shape).
    criterion_results: jsonb("criterion_results"), // { score, gatePassed, perCriterion: [...] }

    // Trajectory rubric: required/forbidden source check results.
    trajectory_results: jsonb("trajectory_results"),

    // Coverage / validation findings surfaced to the reviewer - advisory.
    annotations: jsonb("annotations"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_set: index("draft_documents_set_idx").on(table.set_id),
  }),
);

// A review round: one pass through human review. Reruns create new rounds,
// giving a full regeneration history for audit.
export const review_rounds = pgTable(
  "review_rounds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    set_id: uuid("set_id")
      .notNull()
      .references(() => draft_sets.id, { onDelete: "cascade" }),

    round_number: integer("round_number").notNull(),

    // The rubric version/hash in force for this round (rubrics can change
    // between rounds if reloaded; recording per-round keeps it exact).
    rubric_version: varchar("rubric_version", { length: 64 }).notNull(),
    rubric_hash: varchar("rubric_hash", { length: 64 }).notNull(),

    // The set-level decision for this round: ok | rerun | abort (null while
    // the round is still awaiting the reviewer).
    decision: varchar("decision", { length: 16 }),
    decided_by: uuid("decided_by").references(() => users.id),
    decided_at: timestamp("decided_at", { withTimezone: true }),

    // Snapshot of scores at this round (so history shows how scores evolved).
    scores_snapshot: jsonb("scores_snapshot"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_set: index("review_rounds_set_idx").on(table.set_id),
  }),
);

// A structured issue item: reviewer feedback tied to a document + section +
// rubric criterion + category. Persists beyond the round for aggregate
// analysis of where the system needs improvement.
export const issue_items = pgTable(
  "issue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    round_id: uuid("round_id")
      .notNull()
      .references(() => review_rounds.id, { onDelete: "cascade" }),
    // Nullable: an issue may be set-level rather than about a specific doc.
    document_id: uuid("document_id").references(() => draft_documents.id, {
      onDelete: "cascade",
    }),

    section: varchar("section", { length: 255 }),
    // Which rubric criterion this issue relates to (for aggregate analysis).
    criterion_id: varchar("criterion_id", { length: 64 }),
    // missing | incorrect | wrong_source | structure | other
    category: varchar("category", { length: 32 }).notNull().default("other"),
    detail: text("detail").notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_round: index("issue_items_round_idx").on(table.round_id),
    by_document: index("issue_items_document_idx").on(table.document_id),
    by_criterion: index("issue_items_criterion_idx").on(table.criterion_id),
  }),
);

// ============================================================================
// Live source registry
// ============================================================================
//
// Live sources are services the agent queries at REQUEST TIME for current
// values (web APIs, and later other live endpoints) - never snapshotted into
// RAG. This registry is the durable record of each live source: its endpoint,
// how to query it, its auth, and its classification lane. Declared via
// descriptor JSON in live-sources/, registered here at ingestion, and
// discovered at query time via an embedded blurb whose payload points back
// to the registry id.
//
// Mirrors table_registry: the DATA stays at the source (queried live); only
// a discovery pointer is embedded.

export const live_source_registry = pgTable(
  "live_source_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    name: varchar("name", { length: 512 }).notNull(),
    source_type: varchar("source_type", { length: 32 }).notNull().default("web-api"),

    // Classification: live (internal, trusted) | external (segregated)
    lane: varchar("lane", { length: 16 }).notNull().default("live"),

    // How the agent reaches the source at request time
    endpoint: text("endpoint").notNull(),
    method: varchar("method", { length: 8 }).notNull().default("GET"),

    description: text("description").notNull(),
    // Array of { name, type, description }
    queryable_fields: jsonb("queryable_fields").notNull(),

    // none | service-token | user-token
    auth: varchar("auth", { length: 32 }).notNull().default("service-token"),
    tier: varchar("tier", { length: 32 }).notNull().default("operations"),

    // Provenance: which descriptor file, and its content hash (for change
    // detection and audit).
    source_path: text("source_path").notNull(),
    content_hash: varchar("content_hash", { length: 64 }).notNull(),

    // Lifecycle: active | superseded
    status: varchar("status", { length: 32 }).notNull().default("active"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    by_status: index("live_source_status_idx").on(table.status),
    by_lane: index("live_source_lane_idx").on(table.lane),
    by_name: index("live_source_name_idx").on(table.name),
  }),
);

// ============================================================================
// Document sections (structural map for structural retrieval)
// ============================================================================
//
// The navigable hierarchy of a document's headings. Written during ingestion
// by the heading-aware chunker. Qdrant holds the chunks (with section_id in
// their payload); this table holds the STRUCTURE - so "section 4.3" can be
// resolved by exact lookup (not semantic search, which is poor at
// identifiers), its children found, and its chunks fetched by section_id.
//
// This is the exact-store half of structural retrieval: identifiers and
// hierarchy here (Postgres), meaning in Qdrant, linked by section_id.

export const document_sections = pgTable(
  "document_sections",
  {
    // The section_id = sha256(documentKey + headingPath), matching the value
    // stamped into each chunk's Qdrant payload. Composite PK with document_key
    // because the same id is unique per document.
    section_id: varchar("section_id", { length: 32 }).notNull(),
    document_key: varchar("document_key", { length: 128 }).notNull(),

    parent_section_id: varchar("parent_section_id", { length: 32 }),
    level: integer("level").notNull(),
    section_number: varchar("section_number", { length: 64 }),
    heading_text: text("heading_text").notNull(),
    heading_path: text("heading_path").notNull(),
    order_index: integer("order_index").notNull(),

    source_path: text("source_path").notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.document_key, table.section_id] }),
    by_parent: index("document_sections_parent_idx").on(table.parent_section_id),
    by_number: index("document_sections_number_idx").on(table.section_number),
    by_source: index("document_sections_source_idx").on(table.source_path),
  }),
);

export type DocumentSection = typeof document_sections.$inferSelect;
export type NewDocumentSection = typeof document_sections.$inferInsert;

// ============================================================================
// Inferred types - export for use in application code
// ============================================================================

export type DraftSet = typeof draft_sets.$inferSelect;
export type NewDraftSet = typeof draft_sets.$inferInsert;

export type DraftDocument = typeof draft_documents.$inferSelect;
export type NewDraftDocument = typeof draft_documents.$inferInsert;

export type ReviewRound = typeof review_rounds.$inferSelect;
export type NewReviewRound = typeof review_rounds.$inferInsert;

export type IssueItem = typeof issue_items.$inferSelect;
export type NewIssueItem = typeof issue_items.$inferInsert;

export type LiveSource = typeof live_source_registry.$inferSelect;
export type NewLiveSource = typeof live_source_registry.$inferInsert;

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

// ---------------------------------------------------------------------------
// Custody ledger
//
// Append-only, hash-chained record of everything that happened in producing a
// document. This is the auditor's evidence of custody: what was retrieved,
// what was queried, which standard applied, who approved, and that none of it
// was altered afterward.
//
// Design constraints, each load-bearing:
//
//   - APPEND ONLY. No update, no delete path. The only writer is appendEvent.
//   - REFERENCES, NOT CONTENT. Entries hash chunk IDs, query shapes, scores,
//     and decisions - never retrieved text and never PII. The chain is
//     immutable, so anything written into it can never be erased; content
//     lives in the QueryRecord (governed, erasable) and is bound here by hash.
//   - CHAINED PER AGENT. Each entry carries prev_hash. A deleted entry breaks
//     the link. A document's custody is a SLICE of this continuous ledger.
//   - EXTERNALLY ANCHORED. A local chain proves internal consistency only;
//     whoever controls the process can recompute from a forged genesis.
//     Periodically the head hash is signed/timestamped off-host (see anchors).
// ---------------------------------------------------------------------------

export const custody_events = pgTable(
  "custody_events",
  {
    // Monotonic sequence within this agent's ledger. The chain order.
    seq: bigserial("seq", { mode: "number" }).primaryKey(),

    // Correlation across agents; run within this agent. See correlation.ts.
    correlation_id: varchar("correlation_id", { length: 64 }).notNull(),
    run_id: varchar("run_id", { length: 64 }).notNull(),

    // Which agent/domain wrote this. A cross-agent operation spans ledgers.
    domain: varchar("domain", { length: 64 }).notNull(),

    event_type: varchar("event_type", { length: 48 }).notNull(),

    // Who and under what authority. Present on human-decision events; the
    // acting user id on agent events.
    user_id: varchar("user_id", { length: 64 }),
    decision_id: varchar("decision_id", { length: 64 }),
    policy_hash: varchar("policy_hash", { length: 64 }),

    // Which mode the agent instance was running in: production | debug.
    // Hashed into the chain, so it cannot be edited after the fact without
    // breaking verification. Null means the row predates this column - that is
    // "unknown", NOT "production".
    mode: varchar("mode", { length: 16 }),

    // The event payload - REFERENCES ONLY. Chunk ids, query shape, scores,
    // pinned model/prompt/rubric hashes, output-document hash. Never text.
    payload: jsonb("payload").notNull(),

    // Hash chain. entry_hash = sha256(prev_hash || canonical(this event)).
    prev_hash: varchar("prev_hash", { length: 64 }).notNull(),
    entry_hash: varchar("entry_hash", { length: 64 }).notNull(),

    recorded_at: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    correlationIdx: index("custody_correlation_idx").on(t.correlation_id),
    runIdx: index("custody_run_idx").on(t.run_id),
    entryHashIdx: index("custody_entry_hash_idx").on(t.entry_hash),
    modeIdx: index("custody_events_mode_idx").on(t.mode),
  }),
);

// External anchors. The head entry_hash at a point in time, signed or
// timestamped by something OFF this host. This is what turns "a log we keep"
// into evidence: forging the chain now also requires forging a dated,
// externally-held anchor.
export const custody_anchors = pgTable("custody_anchors", {
  id: uuid("id").primaryKey().defaultRandom(),
  domain: varchar("domain", { length: 64 }).notNull(),
  // The seq and entry_hash this anchor attests to.
  head_seq: bigint("head_seq", { mode: "number" }).notNull(),
  head_hash: varchar("head_hash", { length: 64 }).notNull(),
  // How it was anchored: signature, rfc3161 timestamp, external append store.
  method: varchar("method", { length: 32 }).notNull(),
  // The signature / timestamp token / external receipt.
  proof: text("proof").notNull(),
  anchored_at: timestamp("anchored_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Rubric drafts — the GUI's STAGING area.
//
// Committed rubrics live in rubrics/*.json, in git, hashed, governing real
// evaluations. Those are read-only over the API. THESE are provisional drafts
// authored in the GUI, tested, and later exported to JSON and checked into git
// by hand. Git is the approval gate; the API never promotes a draft to
// committed. The evaluation pipeline physically cannot load from this table -
// it only reads rubrics/*.json - so a half-baked draft can never judge a real
// document.
// ---------------------------------------------------------------------------

export const rubric_drafts = pgTable(
  "rubric_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The document type this draft targets (may or may not already exist as a
    // committed rubric - a draft can be a brand-new document type).
    document_type: varchar("document_type", { length: 64 }).notNull(),

    // Who is authoring this draft. Drafts are per-author staging.
    author_id: varchar("author_id", { length: 64 }).notNull(),

    // The draft rubric JSON, exactly as it will be validated and eventually
    // exported. Not hashed for custody - it governs nothing until committed.
    content: jsonb("content").notNull(),

    // draft | validated - purely informational; validation never commits.
    status: varchar("status", { length: 16 }).notNull().default("draft"),

    // Last validation result, so the GUI can show errors without re-running.
    validation: jsonb("validation"),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAuthor: index("rubric_drafts_author_idx").on(t.author_id),
    byType: index("rubric_drafts_type_idx").on(t.document_type),
  }),
);

// ---------------------------------------------------------------------------
// Rubric draft batches — the k-sampling steering record.
//
// A single judge run has ~40% variance, so a criterion's true behaviour is a
// pass RATE over k runs, not one verdict. Each batch records k runs against one
// document, per-criterion pass counts, and the score distribution, so the
// editor can compare batches across their own iterations and see whether a
// wording change moved a rate beyond the noise.
// ---------------------------------------------------------------------------

export const rubric_draft_batches = pgTable(
  "rubric_draft_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draft_id: uuid("draft_id").notNull().references(() => rubric_drafts.id, { onDelete: "cascade" }),

    // What was scored - a reference to the document text/rows used, recorded so
    // the run is reproducible and comparable (same document across batches).
    document_ref: varchar("document_ref", { length: 128 }).notNull(),

    k: integer("k").notNull(),

    // The aggregated BatchStats: per-criterion rates+CIs+stability, score dist.
    stats: jsonb("stats").notNull(),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byDraft: index("rubric_draft_batches_draft_idx").on(t.draft_id) }),
);