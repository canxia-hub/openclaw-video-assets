import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { VideoAssetService } from "./service.js";
import { CliBridge } from "./cli-bridge.js";
import { buildAgentToolSpecs } from "./tool-specs.js";
import { narrativeRpc } from "./narrative-contract.js";
import { createGatewayRpcHandler } from "./gateway-rpc.js";
import { buildTrustedContext, toolContextToTrustedContext, withTrustedContext } from "./provider-gateway.js";
import { generationCoverageMatrix } from "./generation-policy.js";
import { ADAPTER_VERSION, PLUGIN_ID, assertSupportedHost, beginRegistrationGeneration, describeRegistrationLedger, recordDisposal, requireRegistration, toStructuredError, validateContractsCoverage, validateGatewayScope, validateSecretInputDeclarations, validateToolInput, validateToolRegistration } from "./sdk-compat.js";
let service, cli, compatReport, toolSurfaceIdentity;
let pluginGeneration = 0;
const registeredToolNames = new Set();
const TOOL_SURFACE_CONTEXT = buildTrustedContext({ surface:"tool", trusted:false, source:"unattributed" });
const MANIFEST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "openclaw.plugin.json");
const localizedToolDescription = (name, description) => description;
export default definePluginEntry({
  id: PLUGIN_ID, name:"视频资产与CLI", description:"无前端资产后端，独立 Dreamina 与官方即梦画布 CLI 工具。",
  register(api) {
    if(service) service.close();
    registeredToolNames.clear();
    pluginGeneration = beginRegistrationGeneration(PLUGIN_ID, { registrationMode: api.registrationMode ?? null });
    compatReport = assertSupportedHost(api);
    service = new VideoAssetService({ pluginConfig:api.pluginConfig, logger:api.logger }).init();
    cli = new CliBridge({ service, pluginConfig:api.pluginConfig });
    toolSurfaceIdentity = describeToolFactorySupport(api);
    const specs = buildAgentToolSpecs(service, cli);
    for(const spec of specs) registerToolDefinition(api, tool(spec.name,spec.description,spec.properties,spec.handler,spec.required));
    const rpc = allRpc();
    for(const [name,definition] of Object.entries(rpc)) {
      const check=validateGatewayScope(definition.scope); if(!check.ok) throw check.error;
      requireRegistration("gateway-method",name,{detail:definition.scope});
      api.registerGatewayMethod(name,createGatewayRpcHandler(definition),{scope:definition.scope});
    }
    requireRegistration("service","video-assets-repository");
    api.registerService({ id:"video-assets-repository",reload:{configPrefixes:["plugins.entries.video-assets.config"]},async start(ctx){ctx.logger.info?.("[video-assets] agent-only repository and CLI bridge ready");},async stop(){service?.close();} });
    if(typeof api.registerReload==="function") { requireRegistration("reload-policy","video-assets"); api.registerReload({hotPrefixes:[],restartPrefixes:["plugins.entries.video-assets.config"],noopPrefixes:[]}); }
    const manifest=JSON.parse(fs.readFileSync(MANIFEST_PATH,"utf8"));
    const coverage=validateContractsCoverage({declaredNames:manifest.contracts.tools,registeredNames:[...registeredToolNames]});
    if(!coverage.ok) throw coverage.error ?? new Error(JSON.stringify(coverage));
    const census=generationCoverageMatrix({toolNames:[...registeredToolNames],rpcNames:Object.keys(rpc),browserNames:[]});
    if(census.unclassified_names.length||census.cross_check.length) throw new Error("headless generation census mismatch: "+JSON.stringify(census));
    api.logger.info?.("[video-assets] agent-only: "+registeredToolNames.size+" tools; 0 HTTP/UI/widget registrations");
  }
});
export function getPluginService(){return service;}
export function getToolSurfaceIdentity(){return toolSurfaceIdentity ?? null;}
export function getCompatReport(){return compatReport ?? null;}
export function getRegistrationLedgerSnapshot(){return describeRegistrationLedger();}
export function getHeadlessReport(){return { mode:"agent-only",generation:pluginGeneration,tools:[...registeredToolNames],http_routes:0,widgets:0 };}

function registerToolDefinition(api, definition) {
  const check = validateToolRegistration({ name: definition.name, tool: definition, seenNames: registeredToolNames });
  if (!check.ok) {
    api.logger.error?.(`[video-assets] ${check.error.message}`);
    throw check.error;
  }
  requireRegistration("tool", definition.name);
  registeredToolNames.add(definition.name);
  // REN-02: register a FACTORY so the host supplies the trusted run context
  // (`OpenClawPluginToolContext`: agentId / sessionKey / sessionId / requesterSenderId /
  // senderIsOwner). The host resolves factories per run (`dist/tools-ch1s-pbT.mjs:124-125`), so the
  // identity attached to `execute` comes from the runtime, not from the model's arguments.
  if (supportsToolFactory(api)) {
    api.registerTool(
      (toolContext) => ({
        ...definition,
        execute: (toolCallId, args, signal, onUpdate) => definition.execute(toolCallId, args, signal, onUpdate, toolContext)
      }),
      { name: definition.name }
    );
    return;
  }
  api.registerTool(definition);
}

function supportsToolFactory(api) {
  if (typeof api?.registerTool !== "function") return false;
  // (tool, opts) hosts: unambiguous.
  if (api.registerTool.length >= 2) return true;
  // MEASURED 2026-09-21 in the isolated lane against this host: `api.registerTool.length === 0`
  // because the host exposes the registrar through a rest-args adapter, even though its loader DOES
  // resolve function tools per run
  // (`dist/loader-runtime-load-BgaHcThS.mjs:3929` -> `const factory = typeof tool === "function" ?
  // tool : (_ctx) => tool`, and the factory is invoked per run in `dist/tools-ch1s-pbT.mjs:124`).
  // The bundled browser plugin registers the factory form with no options argument at all.
  // Arity is therefore NOT a capability signal: requiring `>= 2` silently downgraded every real tool
  // call to `unattributed` (observed in run 20260921-g5-tool-identity-v4).
  //
  // The signal used instead is the modern plugin API surface that ships with that loader:
  // `registrationMode` (the api-builder that binds the factory-accepting registrar always sets it) or
  // the `registerToolMetadata` registrar. A host exposing neither keeps the static registration path.
  return typeof api?.registrationMode === "string" || typeof api?.registerToolMetadata === "function";
}

function toolFactorySupportSignal(api, arity) {
  if (typeof api?.registerTool !== "function") return "no-registerTool";
  if (arity >= 2) return "registerTool-arity";
  if (typeof api?.registrationMode === "string") return "registrationMode";
  if (typeof api?.registerToolMetadata === "function") return "registerToolMetadata";
  return "none";
}

function describeToolFactorySupport(api) {
  const arity = typeof api?.registerTool === "function" ? api.registerTool.length : null;
  return {
    supported: supportsToolFactory(api),
    signal: toolFactorySupportSignal(api, arity),
    register_tool_arity: arity,
    registration_mode: typeof api?.registrationMode === "string" ? api.registrationMode : null,
    register_tool_metadata: typeof api?.registerToolMetadata === "function",
    evidence: "dist/agent-harness-runtime-BwRgV0uy.d.ts:14339 + dist/loader-runtime-load-BgaHcThS.mjs:3927-3930 (factory resolution) + dist/tools-ch1s-pbT.mjs:124 (per-run invocation); arity is measured, not assumed"
  };
}

function trustedContextForToolCall(toolContext) {
  if (!toolContext || typeof toolContext !== "object") return TOOL_SURFACE_CONTEXT;
  const hasIdentity = (typeof toolContext.agentId === "string" && toolContext.agentId.trim() !== "") ||
    (typeof toolContext.requesterSenderId === "string" && toolContext.requesterSenderId.trim() !== "");
  if (!hasIdentity) return TOOL_SURFACE_CONTEXT;
  return toolContextToTrustedContext(toolContext, { surface: "tool" });
}

function read(handler) {
  return { scope: "operator.read", handler };
}

function write(handler) {
  return { scope: "operator.write", handler };
}

function tool(name, description, properties, handler, required = []) {
  const localizedDescription = localizedToolDescription(name, description);
  const definition = {
    name,
    description: localizedDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {})
    },
    async execute(toolCallId, args, signal, onUpdate, toolContext) {
      const validation = validateToolInput({ name, parameters: definition.parameters, args });
      if (!validation.ok) {
        return toToolFailure(validation.error, validation.skipped);
      }
      try {
        // REN-02: the trusted identity comes from the host tool factory context, never from args.
        const context = trustedContextForToolCall(toolContext);
        const result = await handler(withTrustedContext(args ?? {}, context), { toolCallId, signal, onUpdate, toolContext, context });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return toToolFailure(error);
      }
    }
  };
  return definition;
}

function toToolFailure(error, skipped = []) {
  if(String(error?.code??"").startsWith("CLI_")) { const payload={ok:false,code:error.code,error:error.message,details:error.details??null}; return {isError:true,content:[{type:"text",text:JSON.stringify(payload)}],details:payload}; }
  const { envelope, isStructured, hint } = toStructuredError(error);
  const text = isStructured ? `ERROR: ${envelope.code}: ${envelope.message}` : `ERROR: ${envelope.message}`;
  return {
    content: [{ type: "text", text }],
    details: {
      ok: false,
      error: envelope,
      ...(hint ? { hint } : {}),
      ...(skipped.length > 0 ? { validationSkipped: skipped } : {})
    },
    isError: true
  };
}
function allRpc(){ return {
"videoAssets.asset.search": read((params) => service.searchAssets(params)),
"videoAssets.asset.browse": read((params) => service.browseAssets(params)),
"videoAssets.asset.get": read((params) => service.getAsset(params)),
"videoAssets.asset.updateMetadata": write((params) => service.updateAssetMetadata(params)),
"videoAssets.asset.updateRights": write((params) => service.updateAssetRights(params)),
"videoAssets.asset.create": write((params) => service.ingestAsset(params)),
"videoAssets.asset.createVersion": write((params) => service.createVersion(params)),
"videoAssets.asset.createBranch": write((params) => service.createBranch(params)),
"videoAssets.asset.saveCopy": write((params) => service.saveCopy(params)),
"videoAssets.asset.lineage": read((params) => service.lineage(params)),
"videoAssets.asset.registerDerivedFile": write((params) => service.registerDerivedFile(params)),
"videoAssets.asset.generateDerivedFile": write((params) => service.generateDerivedFile(params)),
"videoAssets.asset.derivedFiles": read((params) => service.listDerivedFiles(params)),
"videoAssets.asset.integrityScan": read((params) => service.integrityScan(params)),
"videoAssets.asset.classify": write((params) => service.classifyAsset(params)),
"videoAssets.asset.getClassification": read((params) => service.getAssetClassification(params)),
"videoAssets.asset.taxonomyReport": read((params) => service.assetTaxonomyReport(params)),
"videoAssets.entity.create": write((params) => service.createEntity(params)),
"videoAssets.entity.search": read((params) => service.searchEntities(params)),
"videoAssets.entity.linkAsset": write((params) => service.linkEntityAsset(params)),
"videoAssets.annotation.create": write((params) => service.annotateAsset(params)),
"videoAssets.annotation.list": read((params) => service.listAnnotations(params)),
"videoAssets.annotation.update": write((params) => service.updateAnnotation(params)),
"videoAssets.project.create": write((params) => service.createProject(params)),
"videoAssets.project.updateSpec": write((params) => service.updateProjectSpec(params)),
"videoAssets.project.search": read((params) => service.searchProjects(params)),
"videoAssets.project.get": read((params) => service.getProjectDetail(params)),
"videoAssets.project.addRef": write((params) => service.addProjectRef(params)),
"videoAssets.project.updateRef": write((params) => service.updateProjectRef(params)),
"videoAssets.project.removeRef": write((params) => service.removeProjectRef(params)),
"videoAssets.project.listRefs": read((params) => service.listProjectRefs(params)),
"videoAssets.project.report": read((params) => service.projectReport(params)),
"videoAssets.project.continuityReport": read((params) => service.projectContinuityReport(params)),
"videoAssets.audio.doubaoPlan": read((params) => service.doubaoAudioPlan(params)),
"videoAssets.audio.doubaoGenerate": write((params) => service.doubaoAudioGenerate(params)),
"videoAssets.audio.kieSunoPlan": read((params) => service.kieSunoPlan(params)),
"videoAssets.audio.kieSunoGenerate": write((params) => service.kieSunoGenerate(params)),
"videoAssets.generationJob.create": write((params) => service.createGenerationJob(params)),
"videoAssets.generationJob.get": read((params) => service.getGenerationJob(params)),
"videoAssets.generationJob.list": read((params) => service.listGenerationJobs(params)),
"videoAssets.generationJob.events": read((params) => service.generationJobEvents(params)),
"videoAssets.generationJob.process": write((params) => service.processGenerationJob(params)),
"videoAssets.generationJob.reconcile": write((params) => service.reconcileGenerationJob(params)),
"videoAssets.generationJob.resume": write((params) => service.resumeGenerationJob(params)),
"videoAssets.generationJob.cancel": write((params) => service.cancelGenerationJob(params)),
"videoAssets.file.roots": read(() => service.fileRoots()),
"videoAssets.file.list": read((params) => service.listFiles(params)),
"videoAssets.file.inspect": read((params) => service.inspectFile(params)),
"videoAssets.file.search": read((params) => service.searchFiles(params)),
"videoAssets.staging.upload": write((params) => service.uploadStagingFile(params)),
"videoAssets.staging.ingest": write((params) => service.ingestStagingFile(params)),
"videoAssets.staging.reject": write((params) => service.rejectStagingFile(params)),
"videoAssets.audit.commits": read((params) => service.listCommits(params)),
...narrativeRpc(service)
};}
