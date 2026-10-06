import { novelError, NARRATIVE_KINDS } from "./narrative-common.js";

const s={type:"string"}, num={type:"number"}, stringArray={type:"array",items:s};
const base={project_id:s,op:s,document_id:s,document_key:s,revision_id:s,snapshot_id:s};
const document={
  ...base,op:{type:"string",enum:["list","get","save","history","diff","approve","reject"]},kind:{type:"string",enum:NARRATIVE_KINDS},title:s,body:s,
  expected_head:{anyOf:[s,{type:"null"}]},dependencies:stringArray,change_summary:s,volume_order:num,chapter_order:num,from_revision_id:s,to_revision_id:s,limit:num,offset:num
};
const workflow={...base,op:{type:"string",enum:["context","sources","snapshot","impact","review","reviews","export","exports"]},reference_ids:stringArray,max_chars:num,findings:{type:"array",items:{type:"object"}},format:{type:"string",enum:["txt","md","epub"]},revision_ids:stringArray};
const adaptation={...base,op:{type:"string",enum:["get","save","lint","handoff"]},title:s,chapter_revision_id:s,expected_head:{anyOf:[s,{type:"null"}]},mapping:{type:"object",properties:Object.fromEntries(["scene_goal","motivation","causality","emotion","boundaries","visible_action","dialogue"].map(f=>[f,s])),required:["scene_goal","motivation","causality","emotion","boundaries","visible_action","dialogue"],additionalProperties:false}};
const generation={...base,op:{type:"string",enum:["plan","execute","list","status","usage","commit","cancel","reconcile"]},job_id:s,job_key:s,role:{type:"string",enum:["planner","writer","reviewer","state_extractor"]},kind:{type:"string",enum:NARRATIVE_KINDS},title:s,volume_order:num,chapter_order:num,instruction:s,max_output_tokens:num,expected_head:{anyOf:[s,{type:"null"}]},accept_cost:{type:"boolean"},actual_amount:num};

export const NARRATIVE_TOOLS=[
  {name:"video_novel_document",description:"小说叙事文档：项目内保存草稿、读取历史与差异；人类工作台审定固定版本。",properties:document,method:"novelDocument"},
  {name:"video_novel_workflow",description:"小说工作流：组装审定上下文快照、查询资源、改稿影响、审稿记录及 TXT/MD/EPUB 导出。",properties:workflow,method:"novelWorkflow"},
  {name:"video_novel_adaptation",description:"小说—动画映射：固定章节与共享设定版本，记录场次动机、因果、情绪、动作和对白交接。",properties:adaptation,method:"novelAdaptation"},
  {name:"video_novel_generate",description:"独立文本模型任务：计划、执行、状态、用量、合入草稿和人工对账；付费默认关闭且受独立货币预算守卫。",properties:generation,method:"novelGenerate"}
];
export const NARRATIVE_TOOL_NAMES=NARRATIVE_TOOLS.map(t=>t.name);
const readOps={
  document:["list","get","history","diff"],
  workflow:["sources","snapshot","impact","reviews","exports"],
  adaptation:["get","lint","handoff"],
  generation:["list","status","usage","plan"]
};
const writeOps={
  document:["save","approve","reject"],
  workflow:["context","review","export"],
  adaptation:["save"],
  generation:["execute","commit","cancel","reconcile"]
};
export function narrativeRpc(service) {
  const result={};
  for(const [domain,method] of [["document","novelDocument"],["workflow","novelWorkflow"],["adaptation","novelAdaptation"],["generation","novelGenerate"]]){
    for(const access of ["read","write"]){
      result["videoAssets.novel."+domain+"."+access]={
        scope:access==="read"?"operator.read":"operator.write",
        handler:params=>{
          const ops=access==="read"?readOps[domain]:writeOps[domain];
          if(!ops.includes(params.op))throw novelError("OPERATION_SCOPE_MISMATCH","该操作不能使用"+access+"入口",403);
          return service[method](params);
        }
      };
    }
  }
  return result;
}
export const NARRATIVE_BROWSER_WRITES=Object.keys(writeOps).map(domain=>"videoAssets.novel."+domain+".write");
export const NARRATIVE_CLASSIFICATIONS={
  tools:{"video_novel_document":"local-write","video_novel_workflow":"local-derivative","video_novel_adaptation":"local-write","video_novel_generate":"provider-operation novel.text.generate"},
  rpc:{
    "videoAssets.novel.document.read":"local-read","videoAssets.novel.document.write":"local-write",
    "videoAssets.novel.workflow.read":"local-read","videoAssets.novel.workflow.write":"local-derivative",
    "videoAssets.novel.adaptation.read":"local-read","videoAssets.novel.adaptation.write":"local-write",
    "videoAssets.novel.generation.read":"plan","videoAssets.novel.generation.write":"provider-operation novel.text.generate"
  }
};
