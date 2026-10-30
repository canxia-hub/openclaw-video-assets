// REN-08 / src/canvas-commands.js
//
// THE CANVAS COMMAND PROTOCOL.
//
// The editable canvas is built on one idea: the canvas document is changed ONLY by applying a command against a
// KNOWN revision, and every applied command is recorded. Everything else in this package - drag, box-select,
// connect, copy, undo/redo, conflict recovery - is a producer or a consumer of the values in this file.
//
// WHY A COMMAND LOG RATHER THAN "WRITE THE NEW STATE"
//   * Undo/redo needs to know what changed, not just what the result was. Recording the inverse alongside the
//     forward command means undo is an ordinary command with a recorded payload, so it is also durable, auditable,
//     and replayable.
//   * The acceptance requirement is that a drag/select/connect/undo/redo survives a refresh with every reference
//     ID unchanged. Replay depends on the payload naming the exact IDs it touched, so the payloads here always
//     carry IDs - the client chooses the new IDs for created rows rather than letting the server invent them.
//     A server-invented ID could not appear in a redo payload, and undo/redo would create new rows each time.
//   * "Deleting a card must not delete an asset" is only enforceable if removing a card is a distinct command that
//     has no asset vocabulary in it at all. `delete_shapes` names canvas_shapes rows and nothing else; no command
//     in this protocol can reach an asset, and neither the appliers nor this module import an asset path.
//
// WHAT THE REVISION IS (and what it is not)
//   `revision` counts DOCUMENT changes: shapes and edges. It does not count viewport or selection writes, which are
//   view state rather than document state and are deliberately last-write-wins. Mixing them would make two people
//   who merely panned the canvas report a conflict on each other's edits - a false conflict is as damaging as a
//   missed one, because it teaches users to ignore the warning.
//
// ONE WRITER for the revision: the database, not this module. The atomic step is a conditional UPDATE
// (`... SET revision = revision + 1 WHERE canvas_id = ? AND revision = ?`) whose row count decides whether the
// command is applied or reported as a conflict. Read-then-write would be a race with a window; this has none.

/** The command types the protocol accepts. Closed set: an unknown type is refused, never ignored. */
export const CANVAS_COMMAND_TYPES = Object.freeze([
  "move_shapes",
  "update_shapes",
  "create_shapes",
  "delete_shapes",
  "create_edges",
  "delete_edges"
]);

/** Every command type states what kind of change it is, so callers and logs can group them. */
export const CANVAS_COMMAND_KIND = Object.freeze({
  move_shapes: "document",
  update_shapes: "document",
  create_shapes: "document",
  delete_shapes: "document",
  create_edges: "document",
  delete_edges: "document"
});

/**
 * A revision conflict: the document moved on since the command's base revision.
 *
 * Carries status 409 so the HTTP layer answers with a conflict rather than a generic 400, and carries the observed
 * and expected revisions so a client can resynchronise without guessing which way it fell behind.
 */
export class CanvasRevisionConflict extends Error {
  constructor(canvasId, expected, actual, { commandType = null } = {}) {
    super(
      `canvas ${canvasId} has changed: command expected revision ${expected} but the document is at revision ${actual}`
    );
    this.name = "CanvasRevisionConflict";
    this.code = "CANVAS_REVISION_CONFLICT";
    this.status = 409;
    this.details = { canvas_id: canvasId, expected_revision: expected, actual_revision: actual, command_type: commandType };
  }
}

/** A reused idempotency key whose canvas, normalized payload, or trusted actor does not match its record. */
export class CanvasCommandIdConflict extends Error {
  constructor(commandId, reason, details = {}) {
    super(`command_id ${commandId} conflicts with the recorded command: ${reason}`);
    this.name = "CanvasCommandIdConflict";
    this.code = "CANVAS_COMMAND_ID_CONFLICT";
    this.status = 409;
    this.details = { command_id: commandId, reason, ...details };
  }
}

/**
 * A command that cannot be applied: malformed (status 400), or well-formed but in conflict with the document's
 * current state - a duplicate id, an archived canvas (status 409).
 *
 * `status` is an option rather than a constant because those two cases are genuinely different to a caller: 400 means
 * "fix the request", 409 means "re-read and decide". Collapsing them would either make a malformed command look
 * retryable or make a genuine state conflict look like the caller's mistake.
 */
export class CanvasCommandInvalid extends Error {
  constructor(message, { status = 400, details = {} } = {}) {
    super(message);
    this.name = "CanvasCommandInvalid";
    this.code = "CANVAS_COMMAND_INVALID";
    this.status = status;
    this.details = details;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Object key order is irrelevant; array order is deliberately preserved because it is command semantics. */
function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

export function canonicalCanvasCommandJson(command) {
  return JSON.stringify(canonicalJsonValue(normalizeCanvasCommand(command)));
}

function stringList(value, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new CanvasCommandInvalid(`${label} is required`, { details: { field: label } });
    return [];
  }
  if (!Array.isArray(value)) throw new CanvasCommandInvalid(`${label} must be an array`, { details: { field: label } });
  const out = [];
  for (const item of value) {
    const text = String(item ?? "").trim();
    if (!text) throw new CanvasCommandInvalid(`${label} must not contain empty values`, { details: { field: label } });
    out.push(text);
  }
  return out;
}

function finiteNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new CanvasCommandInvalid(`${label} must be a finite number (got ${JSON.stringify(value)})`, { details: { field: label } });
  return numeric;
}

/**
 * Optional fields are passed through only when present, so an applier can tell "unset" from "set to null" and a
 * partial update does not erase an unrelated column by omission.
 */
function optionalNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  return finiteNumber(value, label);
}

function optionalString(value, label) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (!text.trim()) throw new CanvasCommandInvalid(`${label} must not be blank when supplied`, { details: { field: label } });
  return text;
}

function nonEmptyObjectList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CanvasCommandInvalid(`${label} must be a non-empty array`, { details: { field: label } });
  }
  for (const item of value) {
    if (!isPlainObject(item)) throw new CanvasCommandInvalid(`${label} entries must be objects`, { details: { field: label } });
  }
  return value;
}

/**
 * Validate and normalise one command. Returns a frozen shape the appliers can trust.
 *
 * Rejecting an unknown type rather than ignoring it is deliberate: a silently-ignored command would leave the
 * client's optimistic state showing an edit the document never received.
 */
export function normalizeCanvasCommand(command) {
  if (!isPlainObject(command)) throw new CanvasCommandInvalid("command must be an object");
  const type = String(command.type ?? "").trim();
  if (!CANVAS_COMMAND_TYPES.includes(type)) {
    throw new CanvasCommandInvalid(`unknown canvas command type ${JSON.stringify(command.type)}; known types: ${CANVAS_COMMAND_TYPES.join(", ")}`, {
      details: { field: "type", known: [...CANVAS_COMMAND_TYPES] }
    });
  }

  switch (type) {
    case "move_shapes": {
      const positions = nonEmptyObjectList(command.positions, "positions").map((entry, index) => ({
        shape_id: optionalString(entry.shape_id, `positions[${index}].shape_id`) ?? (() => { throw new CanvasCommandInvalid(`positions[${index}].shape_id is required`, { details: { field: "positions" } }); })(),
        x: finiteNumber(entry.x, `positions[${index}].x`),
        y: finiteNumber(entry.y, `positions[${index}].y`)
      }));
      return Object.freeze({ type, positions });
    }
    case "update_shapes": {
      const updates = nonEmptyObjectList(command.updates, "updates").map((entry, index) => {
        const shape_id = optionalString(entry.shape_id, `updates[${index}].shape_id`);
        if (!shape_id) throw new CanvasCommandInvalid(`updates[${index}].shape_id is required`, { details: { field: "updates" } });
        const patch = { shape_id };
        for (const key of ["x", "y", "width", "height", "rotation"]) {
          const value = optionalNumber(entry[key], `updates[${index}].${key}`);
          if (value !== undefined) patch[key] = value;
        }
        const z = optionalNumber(entry.z_index, `updates[${index}].z_index`);
        if (z !== undefined) patch.z_index = Math.trunc(z);
        const title = entry.title === undefined ? undefined : entry.title;
        if (title !== undefined) patch.title = title === null ? null : String(title);
        if (entry.props !== undefined) {
          if (!isPlainObject(entry.props)) throw new CanvasCommandInvalid(`updates[${index}].props must be an object`, { details: { field: "updates" } });
          patch.props = entry.props;
        }
        if (Object.keys(patch).length === 1) {
          throw new CanvasCommandInvalid(`updates[${index}] changes nothing`, { details: { field: "updates" } });
        }
        return patch;
      });
      return Object.freeze({ type, updates });
    }
    case "create_shapes": {
      const shapes = nonEmptyObjectList(command.shapes, "shapes").map((entry, index) => {
        // shape_id is REQUIRED, not generated here: undo/redo replays payloads, and a server-invented id could not
        // have been in the original payload, so a redo would create a different row than the undo removed.
        const shape_id = optionalString(entry.shape_id, `shapes[${index}].shape_id`);
        if (!shape_id) throw new CanvasCommandInvalid(`shapes[${index}].shape_id is required (the client chooses new ids so undo/redo can replay them)`, { details: { field: "shapes" } });
        const shape = {
          shape_id,
          shape_type: optionalString(entry.shape_type, `shapes[${index}].shape_type`) ?? "note",
          subject_type: optionalString(entry.subject_type, `shapes[${index}].subject_type`),
          subject_id: entry.subject_id === undefined ? undefined : (entry.subject_id === null ? null : String(entry.subject_id)),
          title: entry.title === undefined ? undefined : (entry.title === null ? null : String(entry.title)),
          x: optionalNumber(entry.x, `shapes[${index}].x`) ?? 0,
          y: optionalNumber(entry.y, `shapes[${index}].y`) ?? 0
        };
        for (const key of ["width", "height", "rotation"]) {
          const value = optionalNumber(entry[key], `shapes[${index}].${key}`);
          if (value !== undefined) shape[key] = value;
        }
        const z = optionalNumber(entry.z_index, `shapes[${index}].z_index`);
        if (z !== undefined) shape.z_index = Math.trunc(z);
        if (entry.props !== undefined) {
          if (!isPlainObject(entry.props)) throw new CanvasCommandInvalid(`shapes[${index}].props must be an object`, { details: { field: "shapes" } });
          shape.props = entry.props;
        }
        return shape;
      });
      return Object.freeze({ type, shapes });
    }
    case "delete_shapes": {
      const shape_ids = stringList(command.shape_ids, "shape_ids");
      if (shape_ids.length === 0) throw new CanvasCommandInvalid("shape_ids must not be empty", { details: { field: "shape_ids" } });
      // No asset field exists on this command, by construction. See the module header.
      return Object.freeze({ type, shape_ids });
    }
    case "create_edges": {
      const edges = nonEmptyObjectList(command.edges, "edges").map((entry, index) => {
        const edge_id = optionalString(entry.edge_id, `edges[${index}].edge_id`);
        if (!edge_id) throw new CanvasCommandInvalid(`edges[${index}].edge_id is required (the client chooses it so undo/redo can replay it)`, { details: { field: "edges" } });
        const source = optionalString(entry.source_shape_id, `edges[${index}].source_shape_id`);
        const target = optionalString(entry.target_shape_id, `edges[${index}].target_shape_id`);
        if (!source) throw new CanvasCommandInvalid(`edges[${index}].source_shape_id is required`, { details: { field: "edges" } });
        if (!target) throw new CanvasCommandInvalid(`edges[${index}].target_shape_id is required`, { details: { field: "edges" } });
        if (source === target) throw new CanvasCommandInvalid(`edges[${index}] connects ${source} to itself`, { details: { field: "edges" } });
        const edge = { edge_id, source_shape_id: source, target_shape_id: target };
        const relation = optionalString(entry.relation_type, `edges[${index}].relation_type`);
        if (relation !== undefined) edge.relation_type = relation;
        if (entry.label !== undefined) edge.label = entry.label === null ? null : String(entry.label);
        if (entry.props !== undefined) {
          if (!isPlainObject(entry.props)) throw new CanvasCommandInvalid(`edges[${index}].props must be an object`, { details: { field: "edges" } });
          edge.props = entry.props;
        }
        return edge;
      });
      // A payload that names the same edge twice is refused up front, WITH the id, rather than applying the first and
      // failing on the second. A half-applied command is exactly the state the enclosing transaction exists to
      // prevent, and the message has to name the colliding id because that is what the caller has to fix. This check
      // is what surfaced the duplicate-inverse defect: the recorded undo of a multi-card delete carried each edge
      // twice, and the refusal said so instead of restoring one edge and losing the rest.
      const counts = new Map();
      for (const edge of edges) counts.set(edge.edge_id, (counts.get(edge.edge_id) ?? 0) + 1);
      const duplicated = [...counts.entries()].filter(([, count]) => count > 1);
      if (duplicated.length > 0) {
        throw new CanvasCommandInvalid(
          `create_edges names the same edge more than once: ${duplicated.slice(0, 5).map(([id, count]) => `${id} (${count}x)`).join(", ")}${duplicated.length > 5 ? " …" : ""}`,
          { details: { field: "edges", duplicated: duplicated.slice(0, 20).map(([id, count]) => ({ edge_id: id, count })) } }
        );
      }
      return Object.freeze({ type, edges });
    }
    case "delete_edges": {
      const edge_ids = stringList(command.edge_ids, "edge_ids");
      if (edge_ids.length === 0) throw new CanvasCommandInvalid("edge_ids must not be empty", { details: { field: "edge_ids" } });
      return Object.freeze({ type, edge_ids });
    }
    /* c8 ignore next 2 -- unreachable while CANVAS_COMMAND_TYPES and this switch agree */
    default:
      throw new CanvasCommandInvalid(`unhandled canvas command type ${type}`);
  }
}

/** Human-readable one-liner for the audit trail. */
export function describeCanvasCommand(command) {
  switch (command.type) {
    case "move_shapes":
      return `移动 ${command.positions.length} 张卡片`;
    case "update_shapes":
      return `更新 ${command.updates.length} 张卡片`;
    case "create_shapes":
      return `新建 ${command.shapes.length} 张卡片`;
    case "delete_shapes":
      return `移除 ${command.shape_ids.length} 张卡片（未删除任何资产）`;
    case "create_edges":
      return `连接 ${command.edges.length} 对卡片`;
    case "delete_edges":
      return `断开 ${command.edge_ids.length} 条连线`;
    default:
      return command.type;
  }
}

/**
 * The inverse of a command, given what the applier observed while applying it.
 *
 * Returns an ARRAY because one command can need several to be undone faithfully: removing a card also removes the
 * edges attached to it, so undoing that removal has to restore both, and a single-command inverse would silently
 * drop the edges. The caller records this array in the command log (that is what makes offline replay possible) and
 * applies it as new commands when the user asks for undo.
 *
 * `observation` is what the applier saw, not what the request hoped for:
 *   move_shapes    -> { previous: [{ shape_id, x, y }] }        only for shapes that existed and actually moved
 *   update_shapes  -> { previous: [{ shape_id, <old values> }] } only the columns that changed
 *   create_shapes  -> { created_shape_ids: [...] }              the shapes that were actually inserted
 *   delete_shapes  -> { removed_shapes: [...rows], removed_edges: [...rows] }
 *   create_edges   -> { created_edge_ids: [...] }
 *   delete_edges   -> { removed_edges: [...rows] }
 */
export function invertCanvasCommand(command, observation = {}) {
  switch (command.type) {
    case "move_shapes": {
      const previous = (observation.previous ?? []).filter((entry) => entry.changed === true);
      if (previous.length === 0) return [];
      return [{ type: "move_shapes", positions: previous.map(({ shape_id, x, y }) => ({ shape_id, x, y })) }];
    }
    case "update_shapes": {
      const previous = (observation.previous ?? []).filter((entry) => Object.keys(entry.fields ?? {}).length > 0);
      if (previous.length === 0) return [];
      return [{ type: "update_shapes", updates: previous.map((entry) => ({ shape_id: entry.shape_id, ...entry.fields })) }];
    }
    case "create_shapes": {
      const ids = observation.created_shape_ids ?? [];
      return ids.length === 0 ? [] : [{ type: "delete_shapes", shape_ids: [...ids] }];
    }
    case "delete_shapes": {
      const commands = [];
      const shapes = observation.removed_shapes ?? [];
      if (shapes.length > 0) commands.push({ type: "create_shapes", shapes: shapes.map(shapeToCreatePayload) });
      // DEDUPLICATED, because an inverse that names the same edge twice cannot be applied: the second occurrence
      // hits the create path's own duplicate refusal. The applier deduplicates when it collects, so this is a second
      // line of defence rather than the fix - an inverse must be applicable even if the observation is not.
      const edges = dedupeById(observation.removed_edges ?? [], "edge_id");
      if (edges.length > 0) commands.push({ type: "create_edges", edges: edges.map(edgeToCreatePayload) });
      return commands;
    }
    case "create_edges": {
      const ids = observation.created_edge_ids ?? [];
      return ids.length === 0 ? [] : [{ type: "delete_edges", edge_ids: [...ids] }];
    }
    case "delete_edges": {
      const edges = dedupeById(observation.removed_edges ?? [], "edge_id");
      return edges.length === 0 ? [] : [{ type: "create_edges", edges: edges.map(edgeToCreatePayload) }];
    }
    /* c8 ignore next 2 */
    default:
      return [];
  }
}

/**
 * A stored shape row as a `create_shapes` payload. The subject and props are carried through, so restoring a card
 * restores what it REFERRED TO as well - a restored card that lost its subject_id would break the reference
 * continuity the acceptance criteria require to be unchanged.
 */
export function shapeToCreatePayload(row) {
  const payload = {
    shape_id: row.shape_id,
    shape_type: row.shape_type,
    subject_type: row.subject_type ?? undefined,
    subject_id: row.subject_id ?? null,
    title: row.title ?? null,
    x: Number(row.x),
    y: Number(row.y),
    width: Number(row.width),
    height: Number(row.height),
    rotation: Number(row.rotation ?? 0),
    z_index: Number(row.z_index ?? 0)
  };
  const props = typeof row.props === "string" ? safeJson(row.props) : row.props;
  if (props && Object.keys(props).length > 0) payload.props = props;
  return payload;
}

/**
 * Keep the first occurrence of each id. Used when building an inverse, where a repeated id would make the recorded
 * undo unappliable rather than merely redundant.
 */
function dedupeById(rows, key) {
  const seen = new Map();
  for (const row of rows) {
    const id = row?.[key];
    if (id === undefined || id === null) continue;
    if (!seen.has(id)) seen.set(id, row);
  }
  return [...seen.values()];
}

export function edgeToCreatePayload(row) {
  const payload = {
    edge_id: row.edge_id,
    source_shape_id: row.source_shape_id,
    target_shape_id: row.target_shape_id,
    relation_type: row.relation_type,
    label: row.label ?? null
  };
  const props = typeof row.props === "string" ? safeJson(row.props) : row.props;
  if (props && Object.keys(props).length > 0) payload.props = props;
  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Flatten recorded inverses into the commands an undo would apply.
 *
 * Undo is "apply the inverse as a NEW command", never "rewind the log": the log stays append-only, so the history of
 * who changed what - including the undo itself - remains intact and replayable. It also means an undo can conflict
 * like any other command, which is the honest behaviour when someone else has moved the document on.
 */
export function undoCommandsFor(entry) {
  const recorded = entry?.inverse ?? null;
  if (!recorded) return [];
  const commands = Array.isArray(recorded) ? recorded : recorded.commands;
  if (!Array.isArray(commands)) return [];
  return commands.map((command) => normalizeCanvasCommand(command));
}
