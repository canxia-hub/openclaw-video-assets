---
name: "video-assets-project-material"
description: "video-assets 插件项目与素材管理规范（中文命名/分类/信息卡/审计），适配 v1.4 工作台"
---

# Video Assets Project Material

## 使用时机

使用本技能：

- 在 video-assets 插件（v1.4 工作台）中创建项目、导入素材、整理暂存区时。
- 需要给项目、素材、实体、分类、注释设定中文名称时。
- 需要判断一个素材应归为场景、角色、服装、装备、道具、音频、风格参考、动作参考或交付物时。
- 需要为资产文件夹创建或更新 Markdown 信息卡，让 Agent 快速理解角色身份、装备材质/来源/作用、场景用途等信息时。
- 需要清理开发测试数据、验收前检查插件仓库是否干净时。
- 需要把已清权素材接入无限画布，并作为 Dreamina CLI / Seedance 2.0 多模态视频生成参考时。

不使用本技能：

- 只处理工作区普通文件夹，不进入 video-assets 插件仓库时；此时优先用 project-asset-manager。
- 只做资产 taxonomy/entity/annotation 的细节判定时；此时配合 video-asset-taxonomy。
- 只操作无限画布布局、连线或生成 dry-run 时；此时使用 video-canvas-operator。

## 前端页面映射（v1.4 工作台，2026-08-07 起）

本技能涉及的"插件 UI"现对应新工作台页面：

| 操作 | 页面 |
|------|------|
| 创建/浏览项目 | 项目页（/projects，卡片栅格 + 项目检查器） |
| 素材检索与查看 | 资产库页（/assets，搜索/筛选/表格 + 资产检查器） |
| 暂存区整理 | 暂存页（/staging，拖拽上传、入库/移除） |
| 画布素材布局 | 画布页（/canvas，React Flow 只读可视化，按 stage section 分区） |
| 生成准备检查 | 生成页（/generate，槽位匹配 + 预检门 + JSON 包） |
| 验收审计 | 审计页（/audit，scope 筛选 + 关键词检索） |
| 全局定位 | Cmd+K 命令面板（跨项目/资产/画布搜索跳转） |

注意：画布页当前为只读可视化（拖拽不落库）；画布结构修改仍走 video_canvas_* 工具。

## 默认原则

1. UI 可见名称默认中文：项目标题、资产标题、entity canonical name、审计消息都应使用中文。
2. 英文只用于必要的 ID、技术字段、文件扩展名、外部工具 profile 或不可翻译来源名。
3. 素材先分类再入库：不能把未判断素材直接混进正式资产。
4. 一个素材只能有一个主类目；可用 tags 表达辅助属性，但 tags 不能替代主分类。
5. 场景、角色、服装、装备、道具等主体必须尽量建立 entity link，避免靠文件名猜测。
6. 验收或生产 UI 不保留 test、smoke、probe、validation 等开发测试命名。
7. 每个资产文件夹必须配套 Markdown 信息卡；信息卡是 Agent 快速理解资产用途与约束的第一入口。
8. 准备用于生成的素材必须有来源、授权和风险状态；未清权素材不得进入生成输入。

## 标准工作流

### 1. 创建项目

项目标题必须是中文，推荐格式：

项目名或系列名 - 阶段或用途

示例：

- 咕咕嘎嘎短片 - 正式制作
- 月宫追逐镜头 - 样片验证
- 中文空白验收项目

创建后立即确认：

- project.search 只显示中文标题（可在项目页或 Cmd+K 验证）。
- 项目描述说明用途、阶段、风险边界。
- 不把开发测试项目留在 active 列表。

### 2. 导入素材

导入前按主体判断主类目，再按命名规范设置标题。详细规则见：

- references/chinese-naming-standard.md
- references/material-classification-routing.md
- references/intake-checklist.md
- references/asset-info-card-standard.md

### 3. 创建信息卡

每个资产文件夹必须有一个 Markdown 信息卡，默认命名：

- 素材信息卡.md

允许兼容：

- INFO.md
- <素材文件名>.info.md

信息卡必须写清：

- 这个资产是什么。
- 对应哪个角色、场景、服装、装备或道具。
- 来源、授权、风险。
- 材质、功能、身份、使用场景和禁用场景。
- 可用于哪些项目/镜头，不能如何使用。

角色、场景、服装、装备、道具、音频、风格参考的信息卡模板见 references/asset-info-card-standard.md。

### 4. 分类与实体

关键素材至少完成：

- taxonomy：素材是什么。
- entity：素材对应哪个角色、场景、服装、装备或道具。
- annotation：素材的使用约束、来源、连续性要点；应和 Markdown 信息卡保持一致。
- project ref：素材在哪个项目使用。

分类细则调用 video-asset-taxonomy，但命名和安放优先遵守本技能。

### 5. 接入画布生成链路

当素材准备给 Seedance 2.0 / Dreamina CLI 多模态视频生成使用时，先确保素材已完成清权、分类、实体或项目引用，再把它放入无限画布对应阶段。

推荐映射：

- 角色图、表情、模型设定：放入 Characters，作为 `character_reference`。
- 场景图、背景、地点：放入 Scenes，作为 `scene_reference`。
- 主视觉、关键画面、风格图：放入 References，作为 `main_reference` 或 `style_reference`。
- 动作视频、镜头运动、表演参考：放入 Shots 或 References，作为视频参考。
- 旁白、音乐、音效、节奏参考：放入 Audio，作为音频参考。

接入后交给 video-canvas-operator 继续执行：

1. `video_canvas_lint` 检查结构。
2. `video_canvas_generation_package` 或 `video_canvas_generation_handoff` 检查生成输入。
3. `video_canvas_dreamina_cli_generate_video` 做 `multimodal_to_video` dry-run。
4. 真实生成前必须确认积分和授权。

可视化确认：素材入画布后，可在画布页（/canvas）看到对应 stage 分区下的卡片与 `contains` 连线；生成槽位匹配状态可在生成页（/generate）核对。

不要在本技能中直接承诺生成结果；本技能只负责素材能被画布和生成工具正确引用。

### 6. 验收前审计

运行审计脚本：

```powershell
node .\skills\video-assets-project-material\scripts\audit-video-assets-repo.mjs
```

如需检查素材文件夹信息卡：

```powershell
node .\skills\video-assets-project-material\scripts\audit-video-assets-repo.mjs --cards-root=C:\path\to\assets
```

审计目标：

- active 项目标题为中文。
- active 资产标题为中文。
- 不出现英文开发测试关键词。
- 暂存区没有未处理测试文件（可在暂存页核对）。
- 关键资产有 taxonomy / entity / annotation 线索。
- 指定 cards-root 时，包含媒体/素材文件的资产文件夹必须有 Markdown 信息卡。
- 进入生成链路的素材必须有授权和风险状态。

## 必须读取的参考

按任务读取，不要一次性全读：

- 命名：references/chinese-naming-standard.md
- 分类安放：references/material-classification-routing.md
- 信息卡：references/asset-info-card-standard.md
- 入库检查：references/intake-checklist.md

## 汇报格式

完成项目/素材整理后，汇报：

结果：
- 项目：
- 素材：
- 暂存：
- 审计：

分类：
- 场景：
- 角色：
- 服装/装备/道具：
- 音频：
- 参考/风格：

生成接口：
- 可作为画布参考的素材：
- 已清权素材：
- 仍缺的角色/场景/音频/视频参考：

风险：
- 未确认来源：
- 未分类：
- 需要补 entity/annotation：
- 信息卡缺失或待补：

## 禁止项

- 禁止 active UI 中保留英文测试项目或测试素材。
- 禁止把角色、场景、装备、道具混在一个泛化"素材"组里。
- 禁止只有文件名，没有 taxonomy/entity/annotation。
- 禁止只有素材文件、没有 Markdown 信息卡。
- 禁止把暂存区当长期仓库。
- 禁止为了 UI 干净而删除无备份的 live 数据；验收清理必须先备份。
- 禁止把未清权、restricted、rejected 或 high-risk 素材送入生成链路。
