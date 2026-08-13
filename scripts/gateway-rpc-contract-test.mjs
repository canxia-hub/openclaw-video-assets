import assert from "node:assert/strict";
import { createGatewayRpcHandler } from "../src/gateway-rpc.js";

const successCalls = [];
const successHandler = createGatewayRpcHandler({
  async handler(params) {
    return { echoed: params.query };
  }
});

await successHandler({
  params: { query: "隔离项目" },
  respond(...args) {
    successCalls.push(args);
  }
});

assert.equal(successCalls.length, 1, "success path should respond exactly once");
assert.deepEqual(successCalls[0], [
  true,
  { ok: true, result: { echoed: "隔离项目" } }
]);

const failureCalls = [];
const failureHandler = createGatewayRpcHandler({
  async handler() {
    throw new Error("fixture failure");
  }
});

await failureHandler({
  params: {},
  respond(...args) {
    failureCalls.push(args);
  }
});

assert.equal(failureCalls.length, 1, "failure path should respond exactly once");
assert.deepEqual(failureCalls[0], [
  false,
  { ok: false, error: "fixture failure" },
  { code: "UNAVAILABLE", message: "fixture failure" }
]);

console.log("gateway rpc contract test passed");
