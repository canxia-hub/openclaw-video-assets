// Two separate binaries and command namespaces. All work is headless.
export const CLI_PROPERTIES = {
  command: { type: "string", description: "Canonical CLI command path, e.g. version, text2image, model list, node create image, operation status. Use command=help to discover." },
  argv: { type: "array", items: { type: "string" }, description: "CLI arguments, one token per item; never shell text. Do not include the executable or command path." },
  execute: { type: "boolean", description: "Default false returns a zero-I/O plan. True executes the selected CLI command." },
  operation_key: { type: "string", description: "Required for mutations/paid submissions; reuse on uncertain outcomes to prevent duplicate submission." },
  accept_credit_spend: { type: "boolean", description: "Explicit consent for paid generation or credit approval. Does not replace plugin budget policy or provider approval." },
  confirm_destructive: { type: "boolean", description: "Explicit confirmation for provider node/session deletion or logout." },
  timeout_ms: { type: "number", description: "Bounded process timeout, 1000..120000 ms. Timeout after mutation is uncertain; never automatically resubmit." },
  profile: { type: "string", description: "Official canvas CLI profile only; no mixing with legacy CLI credentials." },
  region: { type: "string", description: "Official canvas CLI region only, if explicitly selected." }
};
export function buildCliToolSpecs(cli) {
  return [
    { name: "video_dreamina_cli", description: "独立 Dreamina CLI：版本/help/积分/会话/任务查询、图像视频生成与放大；无需内部画布。默认只计划，execute=true 执行；付费受可信身份、显式确认、预算与幂等门控制。", properties: CLI_PROPERTIES, required: ["command"], handler: args => cli.run("dreamina", args) },
    { name: "video_dreamina_canvas_cli", description: "官方即梦画布 CLI：schema/model/voice、认证、云画布、节点、资源与操作恢复；无需任何前端。参数以实时 schema 为准，默认只计划；生成和积分批准需确认，写操作须稳定 operation_key。", properties: CLI_PROPERTIES, required: ["command"], handler: args => cli.run("dreamina_canvas", args) }
  ];
}
