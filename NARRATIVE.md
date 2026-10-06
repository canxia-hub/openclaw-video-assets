# 小说叙事域 v0.3.0（2026-10-07）

本模块已从隔离原型进入 JavaScript 生产插件实装。工作台：`/__openclaw__/video-assets/workbench/novel`；使用既有插件认证，不新增公开入口。与资产、项目、画布共用同一 SQLite 和对象库。

## 功能

- 文档：共享设定、人物、时间线、伏笔、卷纲、章节、审稿、动画映射；草稿、CAS、不可变历史、差异和人类审定。
- 上下文：必需审定设定不静默截断；资源引用和正文固定版本；新增或改版canon令旧快照失效。
- 改稿：新增或改版审定设定均传播快照失效，后文和动画映射需复查；导出前及事务提交时复查快照。旧正文与导出包不改写。
- 导出：已审定且无需复查章节的 TXT/MD/EPUB，返回章节目录与固定版本，自动登记素材、分类、信息卡、项目引用。
- 动画：章节+设定快照固定；场次目标、人物动机、因果、情绪、边界、可视动作、对白。嵌套参数不能覆盖来源标识，通用文档保存也校验依赖绑定；未审定映射不能作为交接。
- 模型：OpenAI-compatible Chat Completions 端口；planner/writer/reviewer/state_extractor 可配置角色模型；持久化幂等任务、usage、USD/CNY独立账本、取消和人工对账。默认关闭付费；与动画积分不混算。

## Agent 与 RPC

新增4领域工具：`video_novel_document`、`video_novel_workflow`、`video_novel_adaptation`、`video_novel_generate`。`project_id`和`op`必填。

RPC为 `videoAssets.novel.{document,workflow,adaptation,generation}.{read,write}`；只读入口拒绝写操作。工具保存必须带 `expected_head`（新建null）；审定仅可信操作员gateway或已认证browser，Agent不能用参数自称human。

## 独立模型接入（后续配置，不默认调用）

`plugins.entries.video-assets.config.narrative.model`：enabled、endpoint（完整HTTPS chat/completions URL）、model、apiKey（SecretRef）、roles、currency（USD/CNY）、inputPerMillion、outputPerMillion、priceEvidence、budgetAmount、maxOutputTokens、maxInputBytes、allowActors、allowSurfaces、requireOperatorScope。

执行仍需 `accept_cost=true`、固定snapshot、目标文档、expected_head和job_key。先execute查询结果ready，再commit合入草稿；不自动审定。文本模型不能直接生成映射文档，应先完成章节，再通过绑定章节和快照的adaptation入口保存。输入采用保守字节/token上界，不声称精确tokenizer。无usage或网络提交不确定保持预留，不自动重发；reconcile必须人类操作员输入实际已对账金额。

当前文本端口不直接解读图片/扫描PDF；已有项目图片保留资产版本和来源，可先形成经审定的观察文档。文学质量、真实外部供应商计費和多阅读器视觉验证不属于本次工程实装验收，不将夹具结果冒充真实质量。

## 工程验证与回滚

`npm run check:narrative`、`npm run check:narrative-model`、`npm run check:narrative-boundary`及既有注册/生命周期/一致性/付费边界检查；叙事检查已加入综合`npm run check`。本次复验分别13/13、11/11、11/11；HTTP检查使用真实插件入口与认证路由、独立SQLite和宿主夹具，不冒充生产Gateway加载。模型夹具不产生真实供应商费用。工作台在ui-src中构建，入口与manifest/policy/census一起更新。

增量创建 novel_* 表，正文唯一真相为asset_version内容对象。对象先写入，资产登记和文档指针同SQLite事务提交；失败可能留下未引用的内容地址blob，不产生半审定版本。

回滚仅恢复经过验证的旧插件文件，并按宿主支持的重载流程操作；novel_*表与所有资产保留，不物理删除素材，不从旧数据库备份覆盖新用户写入。SQLite快照只供离线取证/应急恢复，须另审当前写入情况。
