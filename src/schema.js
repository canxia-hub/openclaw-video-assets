export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS actors (
  actor_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  format_family TEXT,
  title TEXT NOT NULL,
  description TEXT,
  lifecycle TEXT NOT NULL,
  default_version_id TEXT,
  root_asset_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL DEFAULT 'unknown',
  license_status TEXT NOT NULL DEFAULT 'unknown',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_versions (
  asset_version_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  branch_id TEXT,
  version_label TEXT NOT NULL,
  object_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT NOT NULL,
  container TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  frame_rate REAL,
  sample_rate INTEGER,
  channels INTEGER,
  codec TEXT,
  change_summary TEXT NOT NULL,
  parent_version_id TEXT,
  source_version_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE TABLE IF NOT EXISTS asset_version_changes (
  change_id TEXT PRIMARY KEY,
  asset_version_id TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  tool TEXT,
  parameters_json TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_version_id) REFERENCES asset_versions(asset_version_id)
);

CREATE TABLE IF NOT EXISTS asset_branches (
  branch_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  base_version_id TEXT NOT NULL,
  head_version_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_id, name),
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE TABLE IF NOT EXISTS asset_relations (
  relation_id TEXT PRIMARY KEY,
  relation_type TEXT NOT NULL,
  source_asset_id TEXT NOT NULL,
  source_version_id TEXT NOT NULL,
  target_asset_id TEXT NOT NULL,
  target_version_id TEXT,
  copy_type TEXT,
  reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_sources (
  source_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT,
  captured_at TEXT,
  original_author TEXT,
  license_hint TEXT,
  retrieval_method TEXT,
  notes TEXT,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT,
  target_platforms_json TEXT NOT NULL DEFAULT '[]',
  aspect_ratio TEXT,
  resolution TEXT,
  fps REAL,
  owner_actor_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_references (
  reference_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  role TEXT NOT NULL,
  usage_scope TEXT,
  pin_mode TEXT NOT NULL DEFAULT 'pinned',
  required INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  updated_at TEXT,
  removed_at TEXT,
  removed_by TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(project_id),
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
  FOREIGN KEY(asset_version_id) REFERENCES asset_versions(asset_version_id)
);

CREATE TABLE IF NOT EXISTS asset_classifications (
  classification_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  asset_version_id TEXT,
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  subtype TEXT,
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
  FOREIGN KEY(asset_version_id) REFERENCES asset_versions(asset_version_id)
);

CREATE TABLE IF NOT EXISTS production_entities (
  entity_id TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS asset_entity_links (
  link_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  asset_version_id TEXT,
  entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
  FOREIGN KEY(asset_version_id) REFERENCES asset_versions(asset_version_id),
  FOREIGN KEY(entity_id) REFERENCES production_entities(entity_id)
);

CREATE TABLE IF NOT EXISTS asset_annotations (
  annotation_id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  annotation_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  structured_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'internal',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS derived_files (
  derived_file_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  asset_version_id TEXT NOT NULL,
  derivative_type TEXT NOT NULL,
  profile TEXT,
  object_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT NOT NULL,
  container TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  frame_rate REAL,
  sample_rate INTEGER,
  channels INTEGER,
  codec TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id),
  FOREIGN KEY(asset_version_id) REFERENCES asset_versions(asset_version_id)
);

CREATE TABLE IF NOT EXISTS canvases (
  canvas_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  viewport_json TEXT NOT NULL DEFAULT '{}',
  document_json TEXT NOT NULL DEFAULT '{}',
  -- REN-08: the DOCUMENT revision. Counts shape/edge changes only - not viewport or selection, which are view
  -- state and stay last-write-wins. The column is the single writer of the number: every document change bumps it
  -- with a conditional UPDATE whose row count decides apply-vs-conflict, so no reader ever has to trust a value it
  -- read a moment earlier. Defaults to 0 so existing canvases keep working and simply start counting from zero.
  revision INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS canvas_shapes (
  shape_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  shape_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT,
  title TEXT,
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  z_index INTEGER NOT NULL DEFAULT 0,
  props_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(canvas_id) REFERENCES canvases(canvas_id)
);

CREATE TABLE IF NOT EXISTS canvas_edges (
  edge_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  source_shape_id TEXT NOT NULL,
  target_shape_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  label TEXT,
  props_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(canvas_id) REFERENCES canvases(canvas_id),
  FOREIGN KEY(source_shape_id) REFERENCES canvas_shapes(shape_id),
  FOREIGN KEY(target_shape_id) REFERENCES canvas_shapes(shape_id)
);

CREATE TABLE IF NOT EXISTS canvas_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(canvas_id) REFERENCES canvases(canvas_id)
);

-- REN-08: the canvas COMMAND LOG - one row per applied document command, append-only.
--
-- Why it exists rather than relying on the resulting rows:
--   * undo/redo needs what CHANGED. inverse_json records the commands that undo this one, so undo is an ordinary
--     command with a recorded payload instead of a client-side guess.
--   * the rollback story is "replay to the revision before the change". A log that names its payloads makes that a
--     reconstruction from data, not a reconstruction from memory - tools/replay-canvas-commands.mjs does exactly
--     that and is checked against the live rows.
--   * an undo is recorded as a NEW command, so the log never rewinds and the history of who changed what survives.
--
-- UNIQUE(canvas_id, revision) is the second half of the concurrency control: the conditional UPDATE already refuses
-- a command whose base revision is stale, and this index makes it impossible for two rows to claim the same
-- revision even if a future code path forgets the check.
CREATE TABLE IF NOT EXISTS canvas_commands (
  command_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_revision INTEGER NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  inverse_json TEXT,
  result_json TEXT,
  actor_id TEXT NOT NULL,
  client_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(canvas_id) REFERENCES canvases(canvas_id),
  UNIQUE(canvas_id, revision)
);

-- REN-10: durable paid-generation workflow. A job is the sole authority for whether provider submit happened;
-- an in-flight submit recovered after restart becomes unknown_submission and must reconcile, never blind-retry.
CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  entry TEXT NOT NULL,
  provider TEXT NOT NULL,
  surface TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  project_id TEXT,
  canvas_id TEXT,
  -- REN-11 fix round: the canvas generation slot this job's output belongs to. request_json and the
  -- canvas output card both carried it, but the job row did not - so an operator reading only
  -- generation_jobs could not tell which slot a paid output was written back to.
  slot_shape_id TEXT,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  request_json TEXT NOT NULL,
  plan_json TEXT NOT NULL DEFAULT '{}',
  estimated_credits REAL NOT NULL,
  reserved_credits REAL NOT NULL,
  actual_credits REAL,
  budget_state TEXT NOT NULL,
  provider_request_id TEXT,
  provider_submit_state TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  failed_phase TEXT,
  -- REN-10 round 3: the phase whose effect is still awaiting reconciliation. Separate from both the
  -- provider submission facts (provider_request_id/provider_submit_state) and from failed_phase, which
  -- is a diagnostic that outlives a resolved phase. Recovery routing uses this; it is consumed in the
  -- same transaction as the checkpoint or retry authorisation that resolves the phase.
  pending_phase TEXT,
  local_cancel_requested INTEGER NOT NULL DEFAULT 0,
  remote_cancel_state TEXT NOT NULL DEFAULT 'not_requested',
  submit_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT,
  UNIQUE(actor_id,idempotency_key),
  UNIQUE(provider,provider_request_id)
);

CREATE TABLE IF NOT EXISTS generation_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(job_id,seq),
  FOREIGN KEY(job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS generation_budget_ledger (
  ledger_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL,
  state TEXT NOT NULL,
  estimated_credits REAL NOT NULL,
  actual_credits REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES generation_jobs(job_id)
);

-- Budget reservations that are NOT tied to a job (a tool-surface authorization, a one-shot operation).
-- They cannot live in generation_budget_ledger: job_id there is NOT NULL with a foreign key to
-- generation_jobs, so a non-existent job cannot be named in it. The earlier revision's answer was to
-- accept such a reservation without recording it anywhere, which let the same pool be reserved twice;
-- this table is the durable authority for those scopes instead.
CREATE TABLE IF NOT EXISTS generation_budget_scopes (
  scope_key TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  entry TEXT NOT NULL,
  state TEXT NOT NULL,
  reserved_credits REAL NOT NULL,
  actual_credits REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_budget_scopes_entry ON generation_budget_scopes(entry, state);

CREATE TABLE IF NOT EXISTS generation_compensations (
  compensation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id,stage),
  FOREIGN KEY(job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id TEXT PRIMARY KEY,
  parent_commit_id TEXT,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  changes_json TEXT
);

-- REN-06: streaming upload sessions.
-- Persisted (not in-memory) because an upload spans several requests and may outlive a process: after a
-- restart the offset, the owner and the outcome have to still be answerable. The state column is the
-- state machine; failure_code/failure_message explain every non-success ending so nothing is inferred.
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL,
  owner_actor_type TEXT NOT NULL,
  owner_session_source TEXT,
  file_name TEXT NOT NULL,
  extension TEXT,
  declared_mime TEXT,
  declared_bytes INTEGER NOT NULL,
  declared_sha256 TEXT,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  state TEXT NOT NULL,
  quarantine INTEGER NOT NULL DEFAULT 0,
  temp_path TEXT,
  staging_path TEXT,
  staging_relative_path TEXT,
  asset_id TEXT,
  asset_version_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

-- REN-08: the canvas command log is read as "the last N commands of this canvas, in revision order", and the log
-- only ever grows: an undo appends a command rather than removing one. Without these indexes every read scans the
-- whole table.
CREATE INDEX IF NOT EXISTS idx_canvas_commands_canvas_revision ON canvas_commands(canvas_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_canvas_commands_actor ON canvas_commands(actor_id, canvas_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_state ON generation_jobs(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_actor ON generation_jobs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_events_cursor ON generation_job_events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_generation_compensation_state ON generation_compensations(state, updated_at);

-- REN-06: ownership of staged bytes.
-- Every file placed in the staging area gets a row naming who put it there and what it became. Historical
-- files that predate this table have no row on purpose (they appear as untracked-historical in the
-- manifest); nothing in the codebase deletes a staging file because of its age.
CREATE TABLE IF NOT EXISTS staging_objects (
  staging_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  upload_id TEXT,
  owner_actor_id TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  state TEXT NOT NULL,
  asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_assets_kind_media ON assets(kind, media_type);
CREATE INDEX IF NOT EXISTS idx_versions_asset ON asset_versions(asset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_changes_version ON asset_version_changes(asset_version_id);
CREATE INDEX IF NOT EXISTS idx_branches_asset ON asset_branches(asset_id);
CREATE INDEX IF NOT EXISTS idx_relations_source ON asset_relations(source_asset_id, source_version_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON asset_relations(target_asset_id, target_version_id);
CREATE INDEX IF NOT EXISTS idx_project_refs_project ON project_references(project_id);
CREATE INDEX IF NOT EXISTS idx_classifications_asset ON asset_classifications(asset_id, asset_version_id);
CREATE INDEX IF NOT EXISTS idx_entities_key ON production_entities(entity_key);
CREATE INDEX IF NOT EXISTS idx_entities_type ON production_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_links_asset ON asset_entity_links(asset_id, asset_version_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_entity ON asset_entity_links(entity_id);
CREATE INDEX IF NOT EXISTS idx_annotations_target ON asset_annotations(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_derived_asset_version ON derived_files(asset_id, asset_version_id, derivative_type, status);
CREATE INDEX IF NOT EXISTS idx_canvases_project ON canvases(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_canvas_shapes_canvas ON canvas_shapes(canvas_id, z_index);
CREATE INDEX IF NOT EXISTS idx_canvas_shapes_subject ON canvas_shapes(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_canvas ON canvas_edges(canvas_id);
CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_canvas ON canvas_snapshots(canvas_id, created_at);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner ON upload_sessions(owner_actor_id, state);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_state ON upload_sessions(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_staging_objects_state ON staging_objects(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_staging_objects_asset ON staging_objects(asset_id);
`;
