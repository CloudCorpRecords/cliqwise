import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import {
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const cwAccounts = pgTable("cw_accounts", {
  id: text("id").primaryKey(),
  freeCredits: numeric("free_credits", { precision: 14, scale: 3 })
    .notNull()
    .default("60"),
  paidCredits: numeric("paid_credits", { precision: 14, scale: 3 })
    .notNull()
    .default("0"),
  periodStart: timestamp("period_start", { withTimezone: true })
    .notNull()
    .default(
      sql`date_trunc('month', now(), 'UTC')`,
    ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const cwJobs = pgTable(
  "cw_jobs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => cwAccounts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceUrl: text("source_url"),
    objectPath: text("object_path"),
    numberOfClips: integer("number_of_clips").notNull().default(3),
    captionStyle: text("caption_style").notNull().default("bold"),
    creditSource: text("credit_source").notNull().default("auto"),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    durationSeconds: numeric("duration_seconds", { precision: 12, scale: 3 }),
    creditsReserved: numeric("credits_reserved", {
      precision: 14,
      scale: 3,
    })
      .notNull()
      .default("0"),
    freeReserved: numeric("free_reserved", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    paidReserved: numeric("paid_reserved", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    reservationPeriod: timestamp("reservation_period", {
      withTimezone: true,
    }),
    watermarked: boolean("watermarked").notNull().default(false),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("cw_jobs_user_created_idx").on(table.userId, table.createdAt),
    index("cw_jobs_user_status_idx").on(table.userId, table.status),
    index("cw_jobs_worker_queue_idx")
      .on(table.createdAt)
      .where(
        sql`${table.status} = 'queued' AND ${table.durationSeconds} IS NOT NULL`,
      ),
  ],
);

export const cwClips = pgTable(
  "cw_clips",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    jobId: text("job_id")
      .notNull()
      .references(() => cwJobs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    durationSeconds: numeric("duration_seconds", {
      precision: 12,
      scale: 3,
    }).notNull(),
    viralityScore: numeric("virality_score", { precision: 8, scale: 3 }),
    hookScore: numeric("hook_score", { precision: 8, scale: 3 }),
    storyScore: numeric("story_score", { precision: 8, scale: 3 }),
    payoffScore: numeric("payoff_score", { precision: 8, scale: 3 }),
    transcript: text("transcript").notNull().default(""),
    objectPath: text("object_path").notNull(),
    scoreReason: text("score_reason").notNull().default(""),
  },
  (table) => [index("cw_clips_job_idx").on(table.jobId)],
);

export const cwKeys = pgTable(
  "cw_keys",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => cwAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("cw_keys_hash_unique").on(table.keyHash),
    index("cw_keys_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const cwUploads = pgTable(
  "cw_uploads",
  {
    objectPath: text("object_path").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => cwAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: numeric("size", { precision: 14, scale: 0 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("cw_uploads_user_created_idx").on(table.userId, table.createdAt)],
);

export const cwLedger = pgTable(
  "cw_ledger",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    userId: text("user_id")
      .notNull()
      .references(() => cwAccounts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    description: text("description").notNull(),
    credits: numeric("credits", { precision: 14, scale: 3 }).notNull(),
    jobId: text("job_id").references(() => cwJobs.id, { onDelete: "set null" }),
    stripeSessionId: text("stripe_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("cw_ledger_user_created_idx").on(table.userId, table.createdAt),
    index("cw_ledger_job_type_idx").on(table.jobId, table.type),
    uniqueIndex("cw_ledger_stripe_session_unique").on(table.stripeSessionId),
  ],
);

export const insertCwAccountSchema = createInsertSchema(cwAccounts);
export const insertCwJobSchema = createInsertSchema(cwJobs).omit({
  id: true,
  createdAt: true,
});
export const insertCwClipSchema = createInsertSchema(cwClips).omit({ id: true });
export const insertCwKeySchema = createInsertSchema(cwKeys).omit({
  id: true,
  createdAt: true,
});
export const insertCwUploadSchema = createInsertSchema(cwUploads).omit({
  createdAt: true,
});
export const insertCwLedgerSchema = createInsertSchema(cwLedger).omit({
  id: true,
  createdAt: true,
});

export type CwAccount = typeof cwAccounts.$inferSelect;
export type InsertCwAccount = z.infer<typeof insertCwAccountSchema>;
export type CwJob = typeof cwJobs.$inferSelect;
export type InsertCwJob = z.infer<typeof insertCwJobSchema>;
export type CwClip = typeof cwClips.$inferSelect;
export type InsertCwClip = z.infer<typeof insertCwClipSchema>;
export type CwKey = typeof cwKeys.$inferSelect;
export type InsertCwKey = z.infer<typeof insertCwKeySchema>;
export type CwUpload = typeof cwUploads.$inferSelect;
export type InsertCwUpload = z.infer<typeof insertCwUploadSchema>;
export type CwLedgerEntry = typeof cwLedger.$inferSelect;
export type InsertCwLedgerEntry = z.infer<typeof insertCwLedgerSchema>;