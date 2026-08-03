export const MIGRATION_VERSION = 1;

export const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  password_hash TEXT,
  password_salt TEXT,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx
  ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS auth_sessions_lookup_idx
  ON auth_sessions(token_hash, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS batches (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  current_day INTEGER NOT NULL CHECK (current_day >= 0),
  status TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS daily_observations (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  date_local TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  batch_revision INTEGER NOT NULL CHECK (batch_revision >= 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS agent_sessions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  provider TEXT,
  model TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (user_id, id, batch_id),
  FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS feeding_decisions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  date_local TEXT NOT NULL,
  sop_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  calculation_date TEXT NOT NULL,
  device_setting_json TEXT NOT NULL CHECK (json_valid(device_setting_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, batch_id, date_local, revision),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, session_id, batch_id)
    REFERENCES agent_sessions(user_id, id, batch_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_messages (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_call_id TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, session_id, batch_id)
    REFERENCES agent_sessions(user_id, id, batch_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  batch_id TEXT,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sop_templates (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_by TEXT NOT NULL,
  source_template_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_template_id) REFERENCES sop_templates(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS operation_results (
  user_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('advance', 'record')),
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, batch_id, operation, idempotency_key),
  FOREIGN KEY (user_id, batch_id) REFERENCES batches(user_id, id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS batches_user_revision_idx
  ON batches(user_id, revision DESC);
CREATE INDEX IF NOT EXISTS daily_observations_batch_date_revision_idx
  ON daily_observations(user_id, batch_id, date_local, batch_revision DESC);
CREATE INDEX IF NOT EXISTS feeding_decisions_batch_date_revision_idx
  ON feeding_decisions(user_id, batch_id, date_local, revision DESC);
CREATE INDEX IF NOT EXISTS feeding_decisions_active_idx
  ON feeding_decisions(user_id, batch_id, date_local, revision DESC)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS agent_sessions_batch_idx
  ON agent_sessions(user_id, batch_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_messages_session_batch_idx
  ON agent_messages(user_id, session_id, batch_id, created_at, id);
CREATE INDEX IF NOT EXISTS audit_events_batch_date_idx
  ON audit_events(user_id, batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sop_templates_created_idx
  ON sop_templates(created_at DESC);
`;
