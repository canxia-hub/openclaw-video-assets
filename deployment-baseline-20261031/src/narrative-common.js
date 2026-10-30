import { CompatError } from "./sdk-compat.js";
export const NARRATIVE_KINDS = ["bible", "character", "timeline", "foreshadow", "volume", "chapter", "review", "adaptation"];
export function novelError(code, message, status = 400, details = {}) {
  const error = new CompatError(code, message, { details });
  error.status = status;
  return error;
}
