const GATEWAY_RPC_ERROR_CODE = "UNAVAILABLE";

export function createGatewayRpcHandler(definition) {
  return async ({ params, respond }) => {
    try {
      const result = await definition.handler(params ?? {});
      respond(true, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respond(
        false,
        { ok: false, error: message },
        { code: GATEWAY_RPC_ERROR_CODE, message }
      );
    }
  };
}
