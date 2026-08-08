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
`;
