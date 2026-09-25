/**
 * Gateway RPC adapter (REN-01).
 *
 * Wire compatibility rule: clients written before REN-01 keep seeing
 * `{ ok:false, error:<message> }` with the legacy `{ code:"UNAVAILABLE", message }`
 * third-argument envelope for ordinary failures. Structured envelopes are emitted only
 * for errors that actually carry a stable code (CompatError), so old and new clients can
 * both parse the same response without a version negotiation.
 *
 * Authorization rule: params are untrusted model input and never establish identity.
 * `authorizeGatewayCall` uses a host-provided trusted scope list when the host exposes one
 * and otherwise defers to the host's registration-scope enforcement (the authoritative
 * check); see sdk-compat.js.
 */
import {
  READ_SCOPE,
  WRITE_SCOPE,
  authorizeGatewayCall,
  readTrustedScopes,
  toStructuredError
} from "./sdk-compat.js";
import { buildTrustedContext, withTrustedContext } from "./provider-gateway.js";

export function createGatewayRpcHandler(definition) {
  const requiredScope = definition?.scope === WRITE_SCOPE ? WRITE_SCOPE : READ_SCOPE;

  return async (handlerOptions) => {
    const { params, respond } = handlerOptions ?? {};
    const trustedScopes = readTrustedScopes(handlerOptions);
    const authorization = authorizeGatewayCall({ requiredScope, trustedScopes, params });
    if (!authorization.allowed) {
      const { envelope } = toStructuredError(authorization.error);
      respond(false, { ok: false, error: envelope.message, code: envelope.code, details: envelope.details ?? null }, envelope);
      return;
    }

    try {
      // REN-02: the host context - not the wire params - decides who the caller is.
      const context = buildTrustedContext({
        surface: "gateway",
        actorId: readTrustedActor(handlerOptions),
        actorType: "operator",
        trusted: true,
        source: "host-context",
        scopes: trustedScopes
      });
      const result = await definition.handler(withTrustedContext(params ?? {}, context));
      respond(true, { ok: true, result });
    } catch (error) {
      const { envelope, isStructured, hint } = toStructuredError(error);
      if (isStructured) {
        respond(
          false,
          { ok: false, error: envelope.message, code: envelope.code, details: envelope.details ?? null, ...(hint ? { hint } : {}) },
          envelope
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      respond(
        false,
        { ok: false, error: message },
        { code: envelope.code, message: envelope.message }
      );
    }
  };
}

/**
 * Best-effort trusted caller identity from the host's gateway context.
 * Returns null when the host exposes none - the policy then treats the call as unattributed rather
 * than accepting a caller-supplied `actor_id` from the params.
 */
function readTrustedActor(handlerOptions) {
  const candidates = [
    handlerOptions?.actorId,
    handlerOptions?.client?.actorId,
    handlerOptions?.client?.id,
    handlerOptions?.client?.clientId,
    handlerOptions?.context?.actorId,
    handlerOptions?.context?.clientId
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}
