import { createHash } from "node:crypto";
import { INITIAL_SCHEMA } from "./schema.js";

function stringValue(value, field) {
  if (typeof value !== "string") throw new Error(`Invalid database ${field}`);
  return value;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function jsonObject(value, field) {
  const parsed = JSON.parse(stringValue(value, field));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid database ${field}`);
  }
  return parsed;
}

function legacyFrozenSopSnapshotDigest(snapshot) {
  const templateId = typeof snapshot.templateId === "string" ? snapshot.templateId.trim() : "";
  const version = typeof snapshot.version === "string" ? snapshot.version.trim() : "";
  const sourceSha256 = typeof snapshot.sourceSha256 === "string"
    ? snapshot.sourceSha256.toUpperCase() : "";
  const collectionRevision = typeof snapshot.collectionRevision === "string"
    ? snapshot.collectionRevision.trim() : "";
  const parserVersion = typeof snapshot.parserVersion === "string" ? snapshot.parserVersion.trim() : "";
  const embeddingModel = typeof snapshot.embeddingModel === "string" ? snapshot.embeddingModel.trim() : "";
  const config = objectValue(snapshot.config);
  if (!templateId || !version || !/^[A-F0-9]{64}$/.test(sourceSha256) ||
      !collectionRevision || !parserVersion || !embeddingModel || !config) return null;
  return createHash("sha256").update(JSON.stringify({
    templateId, version, sourceSha256, collectionRevision, parserVersion, embeddingModel, config,
  }).normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

function legacyFreeFeedingSlots(windows) {
  if (!Array.isArray(windows) || windows.length > 8) return null;
  const slots = Array.from({ length: 8 }, (_, index) => ({
    slot: index + 1,
    enabled: false,
    label: `自由采食时段 ${index + 1}`,
    startLocal: "09:00",
    endLocal: "10:00",
  }));
  for (const [index, window] of windows.entries()) {
    const row = objectValue(window);
    const startLocal = typeof row?.startLocal === "string" ? row.startLocal : "";
    const endLocal = typeof row?.endLocal === "string" ? row.endLocal : "";
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startLocal) ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endLocal)) return null;
    slots[index] = {
      slot: index + 1,
      enabled: true,
      label: `自由采食时段 ${index + 1}`,
      startLocal,
      endLocal,
    };
  }
  return slots;
}

function legacyDevicePlanDigest(snapshot) {
  const version = typeof snapshot.version === "string" ? snapshot.version : "";
  const firstDay = objectValue(snapshot.firstDay);
  const templates = objectValue(snapshot.templates);
  if (!version || !firstDay || !templates) return null;
  return createHash("sha256").update(JSON.stringify({ version, firstDay, templates })
    .normalize("NFC"), "utf8").digest("hex").toUpperCase();
}

export function applyAuditedSchemaV12Structure(database) {
    database.exec(INITIAL_SCHEMA);
    ensureAmendmentV10(database);
    ensureAmendmentActionCancelV11(database);
    ensureModeChangeV12(database);
    // Existing development volumes may contain the pre-auth users table.
    // The product no longer migrates business data, but adding nullable
    // credential columns keeps a restart safe without copying or exposing
    // any legacy records.
    const columns = new Set(
      (database.prepare("PRAGMA table_info(users)").all())
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ["email", "TEXT"],
      ["password_hash", "TEXT"],
      ["password_salt", "TEXT"],
      ["role", "TEXT NOT NULL DEFAULT 'operator'"],
      ["disabled", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!columns.has(name)) {
        database.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
      }
    }
    const sopColumns = new Set(
      (database.prepare("PRAGMA table_info(sop_templates)").all())
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ["status", "TEXT NOT NULL DEFAULT 'draft'"],
      ["source_markdown", "TEXT NOT NULL DEFAULT ''"],
      ["source_sha256", "TEXT NOT NULL DEFAULT ''"],
      ["collection_revision", "TEXT NOT NULL DEFAULT ''"],
      ["parser_version", "TEXT NOT NULL DEFAULT ''"],
      ["embedding_model", "TEXT NOT NULL DEFAULT ''"],
      ["chunk_count", "INTEGER NOT NULL DEFAULT 0"],
      ["published_at", "TEXT"],
      ["index_error", "TEXT"],
    ]) {
      if (!sopColumns.has(name)) {
        database.exec(`ALTER TABLE sop_templates ADD COLUMN ${name} ${definition}`);
      }
    }
    const planColumns = new Set(
      (database.prepare("PRAGMA table_info(daily_operation_plans)").all())
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ["proposed_setting_json", "TEXT"],
      ["feedback_origin_json", "TEXT"],
    ]) {
      if (!planColumns.has(name)) {
        database.exec(`ALTER TABLE daily_operation_plans ADD COLUMN ${name} ${definition}`);
      }
    }
    const confirmationColumns = new Set(
      (database.prepare("PRAGMA table_info(daily_operation_confirmations)").all())
        .map((row) => String(row.name)),
    );
    for (const [name, definition] of [
      ["device_setting_json", "TEXT"],
      ["decision_id", "TEXT"],
    ]) {
      if (!confirmationColumns.has(name)) {
        database.exec(`ALTER TABLE daily_operation_confirmations ADD COLUMN ${name} ${definition}`);
      }
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
        ON users(email) WHERE email IS NOT NULL;
    `);
}

export function preflightDuplicateActiveDecisions(database) {
  const tableExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feeding_decisions'
  `).get());
  if (!tableExists) return;
  const duplicateActive = database.prepare(`
    SELECT user_id, batch_id, date_local, COUNT(*) AS count
    FROM feeding_decisions
    WHERE status = 'active'
    GROUP BY user_id, batch_id, date_local
    HAVING COUNT(*) > 1
  `).all();
  if (duplicateActive.length > 0) {
    throw new Error("migration V12 preflight found duplicate active decisions",
    );
  }
}

function ensureAmendmentV10(database) {
  const columns = new Map(
    (database.prepare("PRAGMA table_info(daily_operation_amendments)").all())
      .map((row) => [String(row.name), row]),
  );
  const severity = columns.get("severity");
  const tableSql = String(
    (database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendments'
    `).get())?.sql ?? "",
  );
  const needsRebuild = !columns.has("priority") ||
    (severity !== undefined && Number(severity.notnull) === 1) ||
    !tableSql.includes("superseded") ||
    !tableSql.includes("cancelled");
  const amendmentCountBefore = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendments",
    ).get()).count,
  );
  const actionTableExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
  `).get());
  const actionCountBefore = actionTableExists
    ? Number((database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendment_actions",
      ).get()).count)
    : 0;
  if (needsRebuild) {
    if (actionTableExists) {
      database.exec(`
        DROP TABLE IF EXISTS daily_operation_amendment_actions_v10_backup;
        CREATE TABLE daily_operation_amendment_actions_v10_backup (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          amendment_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply')),
          idempotency_key TEXT NOT NULL,
          expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
          expected_amendment_sha256 TEXT NOT NULL,
          resulting_status TEXT NOT NULL,
          decision_id TEXT,
          response_json TEXT NOT NULL CHECK (json_valid(response_json)),
          created_at TEXT NOT NULL,
          UNIQUE (user_id, idempotency_key)
        ) STRICT;
        INSERT INTO daily_operation_amendment_actions_v10_backup (
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        )
        SELECT
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        FROM daily_operation_amendment_actions;
        DROP TABLE daily_operation_amendment_actions;
      `);
    }
    database.exec(`
      CREATE TABLE daily_operation_amendments_v9 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control')),
        severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied', 'superseded', 'cancelled')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO daily_operation_amendments_v9 (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity,
        CASE severity WHEN 'severe' THEN 'critical' WHEN 'moderate' THEN 'warning' ELSE 'routine' END,
        status, operations_json, proposal_json, decision_id, amendment_sha256,
        based_on_batch_revision, idempotency_key, created_at, decided_at, decided_by
      FROM daily_operation_amendments;
      DROP TABLE daily_operation_amendments;
      ALTER TABLE daily_operation_amendments_v9 RENAME TO daily_operation_amendments;
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS daily_operation_amendment_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      amendment_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
      idempotency_key TEXT NOT NULL,
      expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
      expected_amendment_sha256 TEXT NOT NULL,
      resulting_status TEXT NOT NULL,
      decision_id TEXT,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key),
      FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
      ON daily_operation_amendment_actions(amendment_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS daily_operation_amendments_batch_date_idx
      ON daily_operation_amendments(user_id, batch_id, business_date DESC);
  `);
  const backupExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'daily_operation_amendment_actions_v10_backup'
  `).get());
  if (backupExists) {
    database.exec(`
      INSERT INTO daily_operation_amendment_actions (
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      )
      SELECT
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      FROM daily_operation_amendment_actions_v10_backup;
      DROP TABLE daily_operation_amendment_actions_v10_backup;
    `);
  }
  const amendmentCountAfter = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendments",
    ).get()).count,
  );
  const actionCountAfter = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendment_actions",
    ).get()).count,
  );
  if (
    amendmentCountBefore !== amendmentCountAfter ||
    actionCountBefore !== actionCountAfter
  ) {
    throw new Error("amendment migration would lose rows; transaction rolled back",
    );
  }
}

function ensureAmendmentActionCancelV11(database) {
  const tableSql = String(
    (database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
    `).get())?.sql ?? "",
  );
  if (tableSql.includes("'cancel'")) return;
  database.exec(`
    DROP TABLE IF EXISTS daily_operation_amendment_actions_v11_backup;
    CREATE TABLE daily_operation_amendment_actions_v11_backup (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      amendment_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
      idempotency_key TEXT NOT NULL,
      expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
      expected_amendment_sha256 TEXT NOT NULL,
      resulting_status TEXT NOT NULL,
      decision_id TEXT,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key)
    ) STRICT;
    INSERT INTO daily_operation_amendment_actions_v11_backup (
      id, user_id, batch_id, amendment_id, action, idempotency_key,
      expected_batch_revision, expected_amendment_sha256, resulting_status,
      decision_id, response_json, created_at
    )
    SELECT
      id, user_id, batch_id, amendment_id, action, idempotency_key,
      expected_batch_revision, expected_amendment_sha256, resulting_status,
      decision_id, response_json, created_at
    FROM daily_operation_amendment_actions;
    DROP TABLE daily_operation_amendment_actions;
    CREATE TABLE daily_operation_amendment_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      amendment_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
      idempotency_key TEXT NOT NULL,
      expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
      expected_amendment_sha256 TEXT NOT NULL,
      resulting_status TEXT NOT NULL,
      decision_id TEXT,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key),
      FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
    ) STRICT;
    INSERT INTO daily_operation_amendment_actions (
      id, user_id, batch_id, amendment_id, action, idempotency_key,
      expected_batch_revision, expected_amendment_sha256, resulting_status,
      decision_id, response_json, created_at
    )
    SELECT
      id, user_id, batch_id, amendment_id, action, idempotency_key,
      expected_batch_revision, expected_amendment_sha256, resulting_status,
      decision_id, response_json, created_at
    FROM daily_operation_amendment_actions_v11_backup;
    CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
      ON daily_operation_amendment_actions(amendment_id, created_at DESC);
    DROP TABLE daily_operation_amendment_actions_v11_backup;
  `);
}

function ensureModeChangeV12(database) {
  const duplicateActive = database.prepare(`
    SELECT user_id, batch_id, date_local, COUNT(*) AS count
    FROM feeding_decisions
    WHERE status = 'active'
    GROUP BY user_id, batch_id, date_local
    HAVING COUNT(*) > 1
  `).all();
  if (duplicateActive.length > 0) {
    throw new Error("migration V12 preflight found duplicate active decisions",
    );
  }

  const amendmentSql = String(
    (database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_operation_amendments'
    `).get())?.sql ?? "",
  );
  const needsRebuild = !amendmentSql.includes("mode_change");
  const actionTableExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'daily_operation_amendment_actions'
  `).get());
  const amendmentCountBefore = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendments",
    ).get()).count,
  );
  const actionCountBefore = actionTableExists
    ? Number((database.prepare(
        "SELECT count(*) AS count FROM daily_operation_amendment_actions",
      ).get()).count)
    : 0;
  const payloadHash = (table, columns) => {
    const rows = database.prepare(
      `SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`,
    ).all();
    return createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
  };
  const amendmentHashBefore = payloadHash(
    "daily_operation_amendments",
    ["id", "origin_kind", "status", "amendment_sha256", "based_on_batch_revision"],
  );
  const actionHashBefore = actionTableExists
    ? payloadHash(
        "daily_operation_amendment_actions",
        ["id", "amendment_id", "action", "expected_amendment_sha256", "resulting_status"],
      )
    : "";

  if (needsRebuild) {
    if (actionTableExists) {
      database.exec(`
        DROP TABLE IF EXISTS daily_operation_amendment_actions_v12_backup;
        CREATE TABLE daily_operation_amendment_actions_v12_backup (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          batch_id TEXT NOT NULL,
          amendment_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
          idempotency_key TEXT NOT NULL,
          expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
          expected_amendment_sha256 TEXT NOT NULL,
          resulting_status TEXT NOT NULL,
          decision_id TEXT,
          response_json TEXT NOT NULL CHECK (json_valid(response_json)),
          created_at TEXT NOT NULL,
          UNIQUE (user_id, idempotency_key)
        ) STRICT;
        INSERT INTO daily_operation_amendment_actions_v12_backup (
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        )
        SELECT
          id, user_id, batch_id, amendment_id, action, idempotency_key,
          expected_batch_revision, expected_amendment_sha256, resulting_status,
          decision_id, response_json, created_at
        FROM daily_operation_amendment_actions;
        DROP TABLE daily_operation_amendment_actions;
      `);
    }
    database.exec(`
      CREATE TABLE daily_operation_amendments_v12 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        business_date TEXT NOT NULL,
        base_plan_id TEXT NOT NULL,
        base_confirmation_id TEXT,
        origin_id TEXT NOT NULL,
        origin_kind TEXT NOT NULL CHECK (origin_kind IN ('diarrhea', 'creep_control', 'mode_change')),
        severity TEXT CHECK (severity IS NULL OR severity IN ('mild', 'moderate', 'severe')),
        priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine', 'warning', 'critical')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'applied', 'superseded', 'cancelled')),
        operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
        proposal_json TEXT CHECK (proposal_json IS NULL OR json_valid(proposal_json)),
        decision_id TEXT,
        amendment_sha256 TEXT NOT NULL,
        based_on_batch_revision INTEGER NOT NULL CHECK (based_on_batch_revision >= 0),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        UNIQUE (user_id, origin_id),
        UNIQUE (user_id, idempotency_key),
        FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
        FOREIGN KEY (base_plan_id) REFERENCES daily_operation_plans(id) ON DELETE CASCADE,
        FOREIGN KEY (base_confirmation_id) REFERENCES daily_operation_confirmations(id) ON DELETE SET NULL,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
      ) STRICT;
      INSERT INTO daily_operation_amendments_v12 (
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      )
      SELECT
        id, user_id, batch_id, business_date, base_plan_id, base_confirmation_id,
        origin_id, origin_kind, severity, priority, status, operations_json,
        proposal_json, decision_id, amendment_sha256, based_on_batch_revision,
        idempotency_key, created_at, decided_at, decided_by
      FROM daily_operation_amendments;
      DROP TABLE daily_operation_amendments;
      ALTER TABLE daily_operation_amendments_v12 RENAME TO daily_operation_amendments;
    `);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS daily_operation_amendment_actions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      amendment_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'apply', 'cancel')),
      idempotency_key TEXT NOT NULL,
      expected_batch_revision INTEGER NOT NULL CHECK (expected_batch_revision >= 0),
      expected_amendment_sha256 TEXT NOT NULL,
      resulting_status TEXT NOT NULL,
      decision_id TEXT,
      response_json TEXT NOT NULL CHECK (json_valid(response_json)),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, idempotency_key),
      FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (amendment_id) REFERENCES daily_operation_amendments(id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS daily_operation_amendment_actions_amendment_idx
      ON daily_operation_amendment_actions(amendment_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS daily_operation_amendments_batch_date_idx
      ON daily_operation_amendments(user_id, batch_id, business_date DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS feeding_decisions_one_active_idx
      ON feeding_decisions(user_id, batch_id, date_local)
      WHERE status = 'active';
  `);

  const backupExists = Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'daily_operation_amendment_actions_v12_backup'
  `).get());
  if (backupExists) {
    database.exec(`
      INSERT INTO daily_operation_amendment_actions (
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      )
      SELECT
        id, user_id, batch_id, amendment_id, action, idempotency_key,
        expected_batch_revision, expected_amendment_sha256, resulting_status,
        decision_id, response_json, created_at
      FROM daily_operation_amendment_actions_v12_backup;
      DROP TABLE daily_operation_amendment_actions_v12_backup;
    `);
  }
  const amendmentCountAfter = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendments",
    ).get()).count,
  );
  const actionCountAfter = Number(
    (database.prepare(
      "SELECT count(*) AS count FROM daily_operation_amendment_actions",
    ).get()).count,
  );
  const amendmentHashAfter = payloadHash(
    "daily_operation_amendments",
    ["id", "origin_kind", "status", "amendment_sha256", "based_on_batch_revision"],
  );
  const actionHashAfter = actionTableExists || backupExists || actionCountAfter > 0
    ? payloadHash(
        "daily_operation_amendment_actions",
        ["id", "amendment_id", "action", "expected_amendment_sha256", "resulting_status"],
      )
    : "";
  if (
    amendmentCountBefore !== amendmentCountAfter ||
    actionCountBefore !== actionCountAfter ||
    amendmentHashBefore !== amendmentHashAfter ||
    actionHashBefore !== actionHashAfter
  ) {
    throw new Error("migration V12 would lose amendment or action history; transaction rolled back",
    );
  }
}

export function backfillLegacyFrozenSnapshots(database) {
  const rows = database.prepare(
    "SELECT user_id, id, data_json FROM batches",
  ).all();
  const update = database.prepare(
    "UPDATE batches SET data_json = ? WHERE user_id = ? AND id = ?",
  );
  for (const row of rows) {
    const data = jsonObject(row.data_json, "batches.data_json");
    const config = objectValue(data.config);
    const snapshot = config && objectValue(config.sopTemplate);
    let changed = false;
    if (snapshot && !Object.prototype.hasOwnProperty.call(snapshot, "snapshotSha256")) {
      const snapshotSha256 = legacyFrozenSopSnapshotDigest(snapshot);
      if (snapshotSha256) {
        snapshot.snapshotSha256 = snapshotSha256;
        changed = true;
      }
    }
    const devicePlan = config && objectValue(config.devicePlanSnapshot);
    const templates = devicePlan && objectValue(devicePlan.templates);
    const freeFeeding = templates && objectValue(templates.free_feeding);
    if (devicePlan && freeFeeding && !Object.prototype.hasOwnProperty.call(freeFeeding, "slots")) {
      const slots = legacyFreeFeedingSlots(freeFeeding.windows);
      if (slots) {
        freeFeeding.slots = slots;
        const sha256 = legacyDevicePlanDigest(devicePlan);
        if (sha256) {
          devicePlan.sha256 = sha256;
          changed = true;
        } else {
          delete freeFeeding.slots;
        }
      }
    }
    if (!changed) continue;
    update.run(
      JSON.stringify(data),
      stringValue(row.user_id, "batches.user_id"),
      stringValue(row.id, "batches.id"),
    );
  }
}
