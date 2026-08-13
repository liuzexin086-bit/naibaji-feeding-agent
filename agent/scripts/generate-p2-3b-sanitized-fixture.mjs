import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const defaultSource = resolve(
  agentRoot,
  "backups",
  "production-before-agent-context-render-20260804-165803",
  "agent-data",
  "naibaji.db",
);
const defaultOutput = resolve(
  agentRoot,
  "tests",
  "fixtures",
  "p2-3b",
  "legacy-v5-sanitized.sqlite",
);
const expectedRawSourceSha256 = "da45b567fbc2dfa40c4043e42d308db9c4adaa6a6f6062ff6e45b4023d40dcef";
const expectedRawWalSha256 = "6af4e38dc7fbb6a50d9d2826519bf80780f91703e71023184327c6b319c8fa56";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const source = resolve(process.argv[2] ?? defaultSource);
const output = resolve(process.argv[3] ?? defaultOutput);
const sourceSha256 = sha256File(source);
if (sourceSha256 !== expectedRawSourceSha256) {
  throw new Error(`P2_3B_FIXTURE_SOURCE_SHA256_MISMATCH:${sourceSha256}`);
}
const sourceWal = `${source}-wal`;
const sourceWalSha256 = sha256File(sourceWal);
if (sourceWalSha256 !== expectedRawWalSha256) {
  throw new Error(`P2_3B_FIXTURE_SOURCE_WAL_SHA256_MISMATCH:${sourceWalSha256}`);
}

mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
copyFileSync(source, output);
copyFileSync(sourceWal, `${output}-wal`);

const frozenSourceDigest = "A".repeat(64);
const frozenData = JSON.stringify({
  config: {
    sopTemplate: {
      templateId: "fixture-sop",
      version: "legacy-v5",
      sourceSha256: frozenSourceDigest,
      collectionRevision: "fixture:1",
      parserVersion: "sop-parser@1",
      embeddingModel: "fixture-model",
      config: { freeFeedingWindows: [{ startLocal: "09:00", endLocal: "18:00" }] },
    },
    devicePlanSnapshot: {
      version: "device-plan@legacy-v5",
      firstDay: {
        mode: "timed_quantity",
        mealTimes: ["17:00", "20:00", "23:00", "02:00", "05:00", "08:00"],
      },
      templates: {
        timed_quantity: {
          mealTimes: ["09:00"],
          excludedMealTimes: [],
          precisionGrams: 1,
          reductionPriority: ["09:00"],
        },
        free_feeding: {
          windows: [{ startLocal: "09:00", endLocal: "18:00" }],
          stageConditions: {},
          exceptionBlockers: [],
        },
      },
    },
  },
  records: [],
});

const database = new DatabaseSync(output);
try {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA secure_delete = ON;
    DELETE FROM agent_messages;
    DELETE FROM agent_sessions;
    DELETE FROM audit_events;
    DELETE FROM auth_sessions;
    DELETE FROM daily_observations;
    DELETE FROM daily_operation_confirmations;
    DELETE FROM daily_operation_plans;
    DELETE FROM feeding_decisions;
    DELETE FROM operation_results;
    DELETE FROM sop_knowledge_chunks;
    DELETE FROM sop_publication_state;
    DELETE FROM sop_templates;
    DELETE FROM batches;
    DELETE FROM users;
  `);

  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, password_salt, role, disabled, created_at
    ) VALUES (?, ?, NULL, NULL, 'admin', 0, ?)
  `).run("fixture-user", "fixture-user@example.invalid", "2026-08-04T00:00:00.000Z");
  database.prepare(`
    INSERT INTO batches (
      user_id, id, revision, current_day, status, data_json,
      idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 5, 3, 'active', ?, ?, ?, ?)
  `).run(
    "fixture-user",
    "fixture-batch",
    frozenData,
    "fixture-batch-create",
    "2026-08-04T00:01:00.000Z",
    "2026-08-04T00:02:00.000Z",
  );
  database.prepare(`
    INSERT INTO daily_observations (
      user_id, id, batch_id, date_local, observed_at, batch_revision,
      data_json, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, 5, ?, ?, ?)
  `).run(
    "fixture-user",
    "fixture-observation",
    "fixture-batch",
    "2026-08-04",
    "2026-08-04T00:03:00.000Z",
    JSON.stringify({ diarrheaGrade: "none", note: "sanitized fixture" }),
    "fixture-observation-create",
    "2026-08-04T00:03:00.000Z",
  );
  database.prepare(`
    INSERT INTO agent_sessions (
      user_id, id, batch_id, status, provider, model, idempotency_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'closed', 'sanitized-provider', 'sanitized-model', ?, ?, ?)
  `).run(
    "fixture-user",
    "fixture-session",
    "fixture-batch",
    "fixture-session-create",
    "2026-08-04T00:04:00.000Z",
    "2026-08-04T00:05:00.000Z",
  );
  database.prepare(`
    INSERT INTO agent_messages (
      user_id, id, batch_id, session_id, role, content, tool_name,
      tool_call_id, evidence_json, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, 'user', 'sanitized fixture message', NULL, NULL, '{}', ?, ?)
  `).run(
    "fixture-user",
    "fixture-message",
    "fixture-batch",
    "fixture-session",
    "fixture-message-create",
    "2026-08-04T00:05:00.000Z",
  );
  database.prepare(`
    INSERT INTO audit_events (
      user_id, id, batch_id, action, details_json, idempotency_key, created_at
    ) VALUES (?, ?, ?, 'fixture_sanitized', '{}', ?, ?)
  `).run(
    "fixture-user",
    "fixture-audit",
    "fixture-batch",
    "fixture-audit-create",
    "2026-08-04T00:06:00.000Z",
  );
  database.prepare(`
    INSERT INTO operation_results (
      user_id, batch_id, operation, idempotency_key, response_json, created_at
    ) VALUES (?, ?, 'record', ?, '{}', ?)
  `).run(
    "fixture-user",
    "fixture-batch",
    "fixture-operation-record",
    "2026-08-04T00:07:00.000Z",
  );
  database.prepare(`
    INSERT INTO sop_templates (
      id, version, name, config_json, created_by, source_template_id,
      created_at, status, source_markdown, source_sha256, collection_revision,
      parser_version, embedding_model, chunk_count, published_at, index_error
    ) VALUES (?, 'legacy-v5', 'Sanitized fixture SOP', '{}', ?, NULL, ?,
      'published', '# Sanitized fixture SOP', ?, 'fixture:1', 'sop-parser@1',
      'fixture-model', 1, ?, NULL)
  `).run(
    "fixture-sop",
    "fixture-user",
    "2026-08-04T00:08:00.000Z",
    frozenSourceDigest,
    "2026-08-04T00:09:00.000Z",
  );
  database.prepare(`
    INSERT INTO sop_publication_state (singleton, active_template_id, updated_at)
    VALUES (1, ?, ?)
  `).run("fixture-sop", "2026-08-04T00:09:00.000Z");
  database.prepare(`
    INSERT INTO sop_knowledge_chunks (
      template_id, chunk_id, section_id, chunk_index, title, text,
      source_sha256, collection_revision, lexical_terms_json
    ) VALUES (?, 'fixture-chunk', 'fixture-section', 0, 'Sanitized section',
      'Sanitized fixture knowledge.', ?, 'fixture:1', '[]')
  `).run("fixture-sop", frozenSourceDigest);
  database.prepare(`
    INSERT INTO daily_operation_plans (
      id, user_id, batch_id, business_date, based_on_batch_revision,
      sop_template_id, sop_source_sha256, device_plan_version,
      device_plan_sha256, selected_mode, effective_mode, operations_json,
      operations_sha256, status, created_at
    ) VALUES (?, ?, ?, '2026-08-04', 5, ?, ?, 'device-plan@legacy-v5', ?,
      'timed_quantity', 'timed_quantity', '[]', ?, 'confirmed', ?)
  `).run(
    "fixture-plan",
    "fixture-user",
    "fixture-batch",
    "fixture-sop",
    frozenSourceDigest,
    "B".repeat(64),
    "C".repeat(64),
    "2026-08-04T00:10:00.000Z",
  );
  database.prepare(`
    INSERT INTO daily_operation_confirmations (
      id, plan_id, user_id, batch_id, business_date, operations_sha256,
      confirmed_by, confirmed_at, idempotency_key
    ) VALUES (?, ?, ?, ?, '2026-08-04', ?, ?, ?, ?)
  `).run(
    "fixture-confirmation",
    "fixture-plan",
    "fixture-user",
    "fixture-batch",
    "C".repeat(64),
    "fixture-user",
    "2026-08-04T00:11:00.000Z",
    "fixture-confirmation-create",
  );

  database.exec("PRAGMA foreign_keys = ON;");
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length !== 0) {
    throw new Error(`P2_3B_FIXTURE_FOREIGN_KEY_VIOLATION:${JSON.stringify(foreignKeyViolations)}`);
  }
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`P2_3B_FIXTURE_INTEGRITY_FAILURE:${integrity.integrity_check}`);
  }
  database.exec("PRAGMA journal_mode = DELETE; VACUUM;");
} finally {
  database.close();
}

if (sha256File(source) !== expectedRawSourceSha256 ||
    sha256File(sourceWal) !== expectedRawWalSha256) {
  throw new Error("P2_3B_FIXTURE_RAW_SOURCE_MUTATED");
}

process.stdout.write(`${JSON.stringify({
  rawSourceSha256: sourceSha256,
  rawWalSha256: sourceWalSha256,
  fixtureSha256: sha256File(output),
  byteSize: statSync(output).size,
  output,
})}\n`);
