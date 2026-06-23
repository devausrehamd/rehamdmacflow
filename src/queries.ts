// src/queries.ts
//
// QueryRecord - durable representation of a query in Redis.
//
// Every "ask" or "draft" request creates a QueryRecord that lives in the
// user's tier Redis. The record accumulates state as the agent progresses:
// retrieved chunks per tier, partial answers per tier, final reconciled
// answer, timing breakdowns.
//
// This is the audit artifact for a query. After the query completes, the
// record is queryable for 24 hours via Redis. Longer retention requires
// archiving to Postgres (see the audit_log table).
//
// The record lives in the user's default tier - it's about user actions,
// not about the documents themselves. Even when chunks are retrieved from
// multiple tiers, the record itself is single-tier (the user's home tier).

import { randomBytes } from "node:crypto";
import type { RequestContext } from "./context.js";
import type { DataTier } from "./tiers.js";
import { getTierServices } from "./services.js";

export type QueryStatus =
  | "created"
  | "retrieving"
  | "drafting"
  | "reconciling"
  | "complete"
  | "failed";

export type QueryKind = "ask" | "draft";

export interface RetrievedChunk {
  id: string;
  text: string;
  score: number;
  source_path?: string;
  source_extension?: string;
  sheet_name?: string;
  row_range?: [number, number];
  // Allow arbitrary additional payload fields without losing type safety
  [key: string]: unknown;
}

export interface TierResult {
  chunks: RetrievedChunk[];
  retrieved_at?: string;
  retrieve_latency_ms?: number;
  partial_answer?: string;
  partial_generated_at?: string;
  partial_latency_ms?: number;
}

export interface QueryRecordData {
  id: string;
  kind: QueryKind;
  user_id: string;
  user_role: string;
  user_tier: DataTier;
  accessible_tiers: DataTier[];
  request_id: string;
  question: string;
  doc_type?: string;
  project_id?: string;
  created_at: string;
  expires_at: string;
  status: QueryStatus;
  tiers: Record<string, TierResult>;
  final_answer?: string;
  reconciliation_generated_at?: string;
  reconciliation_latency_ms?: number;
  total_latency_ms?: number;
  error?: string;
}

export interface CreateQueryOptions {
  kind: QueryKind;
  question: string;
  doc_type?: string;
  project_id?: string;
  ttl_seconds?: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export class QueryRecord {
  private constructor(
    private data: QueryRecordData,
    private ctx: RequestContext,
  ) {}

  /** Create a new query record and persist it to Redis. */
  static async create(ctx: RequestContext, opts: CreateQueryOptions): Promise<QueryRecord> {
    const id = `qry_${randomBytes(8).toString("hex")}`;
    const now = new Date();
    const ttl = opts.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const expires = new Date(now.getTime() + ttl * 1000);

    // Pre-populate the tiers map with empty results for every accessible tier.
    // This way the agent code can iterate over tiers without checking for null.
    const tiers: Record<string, TierResult> = {};
    for (const tier of ctx.user.accessibleTiers) {
      tiers[tier] = { chunks: [] };
    }

    const data: QueryRecordData = {
      id,
      kind: opts.kind,
      user_id: ctx.user.id,
      user_role: ctx.user.role,
      user_tier: ctx.user.tier,
      accessible_tiers: ctx.user.accessibleTiers,
      request_id: ctx.requestId,
      question: opts.question,
      doc_type: opts.doc_type,
      project_id: opts.project_id,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      status: "created",
      tiers,
    };

    const record = new QueryRecord(data, ctx);
    await record.save();
    return record;
  }

  /** Load an existing query record from Redis. Returns null if not found. */
  static async load(ctx: RequestContext, id: string): Promise<QueryRecord | null> {
    const { redis } = getTierServices(ctx.user.tier);
    const raw = await redis.get(`qms:queries:${id}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as QueryRecordData;
    return new QueryRecord(data, ctx);
  }

  // ---- Accessors ----

  get id(): string {
    return this.data.id;
  }

  get status(): QueryStatus {
    return this.data.status;
  }

  get question(): string {
    return this.data.question;
  }

  get kind(): QueryKind {
    return this.data.kind;
  }

  getTierResult(tier: DataTier): TierResult | undefined {
    return this.data.tiers[tier];
  }

  /** Return a plain-object snapshot. Useful for serialization and audit. */
  toJSON(): QueryRecordData {
    return JSON.parse(JSON.stringify(this.data));
  }

  // ---- Mutators ----

  async setStatus(status: QueryStatus): Promise<void> {
    this.data.status = status;
    await this.save();
  }

  async setTierChunks(
    tier: DataTier,
    chunks: RetrievedChunk[],
    latencyMs: number,
  ): Promise<void> {
    this.assertTierAccessible(tier);
    this.data.tiers[tier].chunks = chunks;
    this.data.tiers[tier].retrieved_at = new Date().toISOString();
    this.data.tiers[tier].retrieve_latency_ms = latencyMs;
    await this.save();
  }

  async setTierPartial(
    tier: DataTier,
    partial: string,
    latencyMs: number,
  ): Promise<void> {
    this.assertTierAccessible(tier);
    this.data.tiers[tier].partial_answer = partial;
    this.data.tiers[tier].partial_generated_at = new Date().toISOString();
    this.data.tiers[tier].partial_latency_ms = latencyMs;
    await this.save();
  }

  async setFinalAnswer(answer: string, latencyMs: number): Promise<void> {
    this.data.final_answer = answer;
    this.data.reconciliation_generated_at = new Date().toISOString();
    this.data.reconciliation_latency_ms = latencyMs;
    this.data.total_latency_ms = Date.now() - new Date(this.data.created_at).getTime();
    this.data.status = "complete";
    await this.save();
  }

  async setError(message: string): Promise<void> {
    this.data.status = "failed";
    this.data.error = message;
    this.data.total_latency_ms = Date.now() - new Date(this.data.created_at).getTime();
    await this.save();
  }

  // ---- Internal ----

  private assertTierAccessible(tier: DataTier): void {
    if (!this.data.tiers[tier]) {
      throw new Error(
        `Cannot set data for tier '${tier}' - not in accessible tiers for query ${this.data.id}`,
      );
    }
  }

  private async save(): Promise<void> {
    const { redis } = getTierServices(this.ctx.user.tier);
    const ttlSeconds = Math.max(
      60,
      Math.floor((new Date(this.data.expires_at).getTime() - Date.now()) / 1000),
    );
    await redis.set(
      `qms:queries:${this.data.id}`,
      JSON.stringify(this.data),
      "EX",
      ttlSeconds,
    );
  }
}