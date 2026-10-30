// REN-08 / src/canvas-editing-policy.js
//
// THE ROLLBACK SWITCH FOR THE EDITABLE CANVAS.
//
// The rollback requirement is "a feature flag turns editing off and the canvas goes read-only; the command log and
// compatible snapshots are kept, and the document can be replayed to the revision before a change". A UI-only toggle
// would not satisfy that: gestures removed from the interface leave the write path open, so anyone with the session
// cookie - or simply a stale bundle - could still write. So the flag is resolved HERE, on the server, and enforced in
// the command path itself. The interface reads the same value to decide whether to offer the gestures at all, which
// makes it a usability detail rather than the mechanism.
//
// Why the debounce lives in the same object: it is the same kind of value. The write-frequency target ("20 viewport
// events in 2 seconds produce at most 2 write requests") is a policy about how the client should behave, and a
// number buried in the bundle can be changed by a rebuild but not by an operator. Declaring it next to the flag
// means one place answers "how does the canvas write".
//
// Both values are CLAMPED, following the REN-06 upload policy's precedent: a config that asked for a 0 ms debounce
// would let one pan produce a write per frame, which is the behaviour this package exists to remove, and a config
// that asked for a 10-minute debounce would lose work. Refusing silently is not an option either - the resolved
// object carries the requested value alongside the effective one, so a clamped config is visible rather than mute.

/** Debounce bounds. 0 would write per frame; beyond 2 s a viewport would feel unsaved. */
export const VIEWPORT_DEBOUNCE_MIN_MS = 200;
export const VIEWPORT_DEBOUNCE_MAX_MS = 2000;
export const VIEWPORT_DEBOUNCE_DEFAULT_MS = 400;

/**
 * @param {object} pluginConfig the plugin's own config object (may be undefined in tests and older installs)
 * @returns {{editing:boolean, requestedEditing:boolean|null, viewportDebounceMs:number, requestedViewportDebounceMs:number|null, readOnlyReason:string|null, clamped:string[]}}
 */
export function resolveCanvasEditingPolicy(pluginConfig = {}) {
  const raw = pluginConfig?.canvas && typeof pluginConfig.canvas === "object" ? pluginConfig.canvas : {};
  const clamped = [];

  // Default is ENABLED. The default has to be chosen deliberately rather than falling back to "off": an install that
  // predates this config block should get the feature its version ships, and a flag whose default is off would make
  // the read-only state look like a bug to whoever upgrades.
  const requestedEditing = raw.editing === undefined || raw.editing === null ? null : Boolean(raw.editing);
  const editing = requestedEditing === null ? true : requestedEditing;

  let requestedViewportDebounceMs = null;
  let viewportDebounceMs = VIEWPORT_DEBOUNCE_DEFAULT_MS;
  if (raw.viewportDebounceMs !== undefined && raw.viewportDebounceMs !== null) {
    const numeric = Number(raw.viewportDebounceMs);
    requestedViewportDebounceMs = numeric;
    if (!Number.isFinite(numeric)) {
      clamped.push(`viewportDebounceMs=${JSON.stringify(raw.viewportDebounceMs)} is not a number; using ${VIEWPORT_DEBOUNCE_DEFAULT_MS}`);
    } else {
      viewportDebounceMs = Math.min(VIEWPORT_DEBOUNCE_MAX_MS, Math.max(VIEWPORT_DEBOUNCE_MIN_MS, Math.trunc(numeric)));
      if (viewportDebounceMs !== Math.trunc(numeric)) {
        clamped.push(`viewportDebounceMs=${Math.trunc(numeric)} clamped to ${viewportDebounceMs} (allowed ${VIEWPORT_DEBOUNCE_MIN_MS}..${VIEWPORT_DEBOUNCE_MAX_MS})`);
      }
    }
  }

  return {
    editing,
    requestedEditing,
    viewportDebounceMs,
    requestedViewportDebounceMs,
    // Named so the read-only state can be explained in the interface without the interface inventing a reason.
    readOnlyReason: editing ? null : "canvas.editing is disabled in the plugin configuration",
    clamped
  };
}
