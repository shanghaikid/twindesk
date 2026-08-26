/** Four-byte SQLite application identifier for "TWND". */
export const TWIN_DESK_SQLITE_APPLICATION_ID = 0x54574e44

export interface SqliteMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

const INITIAL_SCHEMA_SQL = `
CREATE TABLE twindesk_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE external_events (
  kind TEXT NOT NULL CHECK (kind = 'external_event'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_timestamp TEXT,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  context_status TEXT NOT NULL CHECK (context_status IN ('complete', 'partial')),
  context_missing_json TEXT,
  normalized_json TEXT NOT NULL CHECK (
    json_valid(normalized_json) AND json_type(normalized_json) = 'object'
  ),
  CHECK (
    (context_status = 'complete' AND context_missing_json IS NULL) OR
    (
      context_status = 'partial' AND
      json_valid(context_missing_json) AND
      json_type(context_missing_json) = 'array' AND
      json_array_length(context_missing_json) > 0
    )
  ),
  CHECK (
    julianday(occurred_at) IS NOT NULL AND
    julianday(received_at) IS NOT NULL AND
    julianday(received_at) >= julianday(occurred_at)
  )
) STRICT;

CREATE INDEX external_events_source_index
  ON external_events (connector_id, account_id, object_type, external_id, occurred_at);

CREATE INDEX external_events_received_index
  ON external_events (received_at, id);

CREATE TABLE external_threads (
  kind TEXT NOT NULL CHECK (kind = 'external_thread'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    julianday(created_at) IS NOT NULL AND
    julianday(updated_at) IS NOT NULL AND
    julianday(updated_at) >= julianday(created_at)
  )
) STRICT;

CREATE TABLE thread_external_references (
  thread_id TEXT NOT NULL REFERENCES external_threads(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  source_timestamp TEXT,
  PRIMARY KEY (thread_id, ordinal),
  UNIQUE (thread_id, connector_id, account_id, object_type, external_id)
) STRICT;

CREATE TABLE thread_events (
  thread_id TEXT NOT NULL REFERENCES external_threads(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES external_events(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (thread_id, event_id),
  UNIQUE (thread_id, ordinal)
) STRICT;

CREATE TABLE work_items (
  kind TEXT NOT NULL CHECK (kind = 'work_item'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES external_threads(id) ON DELETE CASCADE,
  inbox_state TEXT NOT NULL CHECK (
    inbox_state IN ('needs_reply', 'needs_review', 'waiting', 'done')
  ),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  attention_reason TEXT NOT NULL,
  selected_persona_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    julianday(created_at) IS NOT NULL AND
    julianday(updated_at) IS NOT NULL AND
    julianday(updated_at) >= julianday(created_at)
  )
) STRICT;

CREATE INDEX work_items_inbox_index
  ON work_items (inbox_state, updated_at DESC, id);

CREATE TABLE work_item_events (
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES external_events(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (work_item_id, event_id),
  UNIQUE (work_item_id, ordinal)
) STRICT;

CREATE TABLE drafts (
  kind TEXT NOT NULL CHECK (kind = 'draft'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (
    state IN ('editing', 'ready_for_review', 'superseded', 'cancelled')
  ),
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  content_text TEXT NOT NULL,
  rationale TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_item_id, revision),
  CHECK (
    julianday(created_at) IS NOT NULL AND
    julianday(updated_at) IS NOT NULL AND
    julianday(updated_at) >= julianday(created_at)
  )
) STRICT;

CREATE INDEX drafts_work_item_index
  ON drafts (work_item_id, revision DESC);

CREATE TABLE action_proposals (
  kind TEXT NOT NULL CHECK (kind = 'action_proposal'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES drafts(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  action_type TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('write', 'destructive')),
  identity_connector_id TEXT NOT NULL,
  identity_account_id TEXT NOT NULL,
  identity_type TEXT NOT NULL CHECK (identity_type IN ('bot', 'user')),
  identity_display_name TEXT NOT NULL,
  target_connector_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  target_object_type TEXT NOT NULL,
  target_external_id TEXT NOT NULL,
  target_source_timestamp TEXT,
  media_type TEXT NOT NULL CHECK (media_type IN ('text/plain', 'text/markdown')),
  content_text TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN (
      'proposed',
      'awaiting_approval',
      'approved',
      'rejected',
      'cancelled',
      'executing',
      'succeeded',
      'failed',
      'uncertain'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (identity_connector_id = target_connector_id),
  CHECK (identity_account_id = target_account_id),
  CHECK (
    julianday(created_at) IS NOT NULL AND
    julianday(updated_at) IS NOT NULL AND
    julianday(updated_at) >= julianday(created_at)
  )
) STRICT;

CREATE INDEX action_proposals_work_item_index
  ON action_proposals (work_item_id, updated_at DESC, id);

CREATE TABLE approval_records (
  kind TEXT NOT NULL CHECK (kind = 'approval_record'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (
    decision IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')
  ),
  identity_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  responder_user_id TEXT,
  consumed_at TEXT,
  CHECK (
    julianday(requested_at) IS NOT NULL AND
    julianday(expires_at) IS NOT NULL AND
    julianday(expires_at) > julianday(requested_at)
  ),
  CHECK (
    (decision = 'pending' AND decided_at IS NULL AND responder_user_id IS NULL AND consumed_at IS NULL) OR
    (
      decision = 'approved' AND
      decided_at IS NOT NULL AND
      responder_user_id IS NOT NULL AND
      (consumed_at IS NULL OR julianday(consumed_at) >= julianday(decided_at))
    ) OR
    (
      decision = 'rejected' AND
      decided_at IS NOT NULL AND
      responder_user_id IS NOT NULL AND
      consumed_at IS NULL
    ) OR
    (
      decision IN ('cancelled', 'expired') AND
      decided_at IS NOT NULL AND
      consumed_at IS NULL
    )
  ),
  CHECK (
    decided_at IS NULL OR
    (
      julianday(decided_at) IS NOT NULL AND
      julianday(decided_at) >= julianday(requested_at)
    )
  ),
  CHECK (
    decision != 'approved' OR
    julianday(decided_at) <= julianday(expires_at)
  ),
  CHECK (
    consumed_at IS NULL OR
    (
      julianday(consumed_at) IS NOT NULL AND
      julianday(consumed_at) <= julianday(expires_at)
    )
  )
) STRICT;

CREATE INDEX approval_records_proposal_index
  ON approval_records (proposal_id, requested_at DESC, id);

CREATE TABLE connector_cursors (
  kind TEXT NOT NULL CHECK (kind = 'connector_cursor'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  position TEXT NOT NULL,
  committed_through TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, account_id, stream)
) STRICT;

CREATE TABLE audit_records (
  kind TEXT NOT NULL CHECK (kind = 'audit_record'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (
    category IN ('ingestion', 'routing', 'run', 'draft', 'approval', 'execution', 'system')
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'success', 'failure', 'cancelled', 'uncertain')
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'persona', 'connector')),
  actor_id TEXT,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  occurred_at TEXT NOT NULL,
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL) OR
    (actor_type != 'system' AND actor_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX audit_records_timeline_index
  ON audit_records (occurred_at DESC, id);

CREATE TABLE audit_references (
  audit_record_id TEXT NOT NULL REFERENCES audit_records(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  reference_kind TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  PRIMARY KEY (audit_record_id, ordinal),
  UNIQUE (audit_record_id, reference_kind, reference_id)
) STRICT;

CREATE TABLE action_receipts (
  kind TEXT NOT NULL CHECK (kind = 'action_receipt'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  execution_attempt_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'uncertain')),
  attempted_at TEXT NOT NULL,
  external_connector_id TEXT,
  external_account_id TEXT,
  external_object_type TEXT,
  external_id TEXT,
  external_source_timestamp TEXT,
  issue_code TEXT,
  issue_summary TEXT,
  issue_retryable INTEGER CHECK (issue_retryable IN (0, 1)),
  retry_disposition TEXT CHECK (
    retry_disposition IN ('do_not_retry', 'retry_same_key', 'reconcile_first')
  ),
  UNIQUE (proposal_id, execution_attempt_id),
  CHECK (
    (outcome = 'succeeded' AND
      external_connector_id IS NOT NULL AND
      external_account_id IS NOT NULL AND
      external_object_type IS NOT NULL AND
      external_id IS NOT NULL AND
      issue_code IS NULL AND
      issue_summary IS NULL AND
      issue_retryable IS NULL AND
      retry_disposition IS NULL) OR
    (outcome = 'failed' AND
      external_connector_id IS NULL AND
      external_account_id IS NULL AND
      external_object_type IS NULL AND
      external_id IS NULL AND
      external_source_timestamp IS NULL AND
      issue_code IS NOT NULL AND
      issue_summary IS NOT NULL AND
      issue_retryable IS NOT NULL AND
      retry_disposition IN ('do_not_retry', 'retry_same_key')) OR
    (outcome = 'uncertain' AND
      external_connector_id IS NULL AND
      external_account_id IS NULL AND
      external_object_type IS NULL AND
      external_id IS NULL AND
      external_source_timestamp IS NULL AND
      issue_code IS NOT NULL AND
      issue_summary IS NOT NULL AND
      issue_retryable IS NOT NULL AND
      retry_disposition = 'reconcile_first')
  )
) STRICT;

CREATE INDEX action_receipts_proposal_index
  ON action_receipts (proposal_id, attempted_at DESC, execution_attempt_id);

CREATE TRIGGER external_events_no_update
BEFORE UPDATE ON external_events
BEGIN
  SELECT RAISE(ABORT, 'external events are immutable');
END;

CREATE TRIGGER audit_records_no_update
BEFORE UPDATE ON audit_records
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;
`

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial_business_schema',
    sql: INITIAL_SCHEMA_SQL,
  }),
])

export const LATEST_TWIN_DESK_SQLITE_SCHEMA_VERSION =
  SQLITE_MIGRATIONS[SQLITE_MIGRATIONS.length - 1]?.version ?? 0
