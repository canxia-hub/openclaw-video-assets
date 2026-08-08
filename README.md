# OpenClaw Video Assets

`openclaw-video-assets` 是一个面向视频生产流程的 OpenClaw 原生插件：它把「项目、素材、版本、实体、分类、画布、生成输入、生成输出、审片批注、返修卡片、音频/视频生成写回」收敛到同一个可审计的生产资产库中。

当前发布版：**v1.4.0 / Workbench v1.4**

- 插件 ID：`video-assets`
- 工作台路由：`/__openclaw__/video-assets/workbench/`
- 后端入口：`src/index.js`
- 前端产物：`ui-dist/`
- 前端源码：`ui-src/`
- 附属 OpenClaw 技能：`skills/`
- 原始实现与新版工作台：湍
- 发布整理与公开仓库维护：小千 / canxia-hub

---

## 目录

- [它能解决什么问题](#它能解决什么问题)
- [核心能力](#核心能力)
- [Workbench v1.4 页面](#workbench-v14-页面)
- [架构与数据模型](#架构与数据模型)
- [安装](#安装)
- [配置](#配置)
- [首次启动与安全初始化](#首次启动与安全初始化)
- [附属技能](#附属技能)
- [Agent 工具清单](#agent-工具清单)
- [RPC 面](#rpc-面)
- [生成链路治理规则](#生成链路治理规则)
- [本地验证](#本地验证)
- [前端开发](#前端开发)
- [目录结构](#目录结构)
- [安全边界](#安全边界)
- [当前限制](#当前限制)
- [发布说明](#发布说明)

---

## 它能解决什么问题

多媒体项目最常见的失控点不是“文件不够多”，而是：

- 同一个角色/场景/道具的素材散落在多个目录，无法判断哪个版本可用。
- 生成输出只有文件，没有来源、授权、风险、谱系和审片记录。
- 画布只是视觉草稿，不能变成可执行的生成输入包。
- 下游 Agent 拿到的是裸文件路径，不知道素材身份、约束、授权状态和禁用场景。
- 审片意见、返修动作、替换版本之间没有结构化关系。

这个插件把上述信息变成一套可查询、可审计、可由 Agent 操作的生产资产系统。

---

## 核心能力

### 1. 项目与素材仓库

- 创建视频项目并维护项目规格：分辨率、宽高比、帧率、目标平台。
- 导入本地素材为受管资产。
- 使用内容寻址对象存储保存源文件。
- 支持资产版本、分支、受管副本、上下游谱系。
- 支持项目素材引用，并可区分 `pinned`、`follow_latest`、`candidate` 等引用模式。
- 支持项目资产风险报告与连续性报告。

### 2. 分类、实体与批注

- 使用受控分类体系标注资产：角色、场景、服装、道具、音频、参考、提示词、文档、交付物等。
- 建立角色、场景、服装、道具等生产实体。
- 将资产或资产版本关联到实体。
- 支持结构化批注：角色设定、场景概念、服装规格、道具功能、视觉连续性、来源权利、制作备注、审片意见等。
- 可扫描缺失分类、缺失实体关联和关键批注缺口。

### 3. 派生文件与完整性

- 登记缩略图、代理文件、转码、字幕、波形、contact sheet、元数据等派生文件。
- 可通过本地 `ffmpeg` 生成缩略图或代理文件。
- 支持仓库完整性扫描：元数据、源对象、派生文件和项目引用。

### 4. 制作画布

- 每个项目可拥有制作画布。
- 画布卡片可绑定项目引用、资产、资产版本、实体、备注、阶段分区。
- 支持阶段结构：Characters、Scenes、Props、References、Audio、Shots、Delivery。
- 支持生成槽位：主参考、角色参考、场景参考、动作参考、风格参考、视频片段、音频、字幕、项目配置、草稿输出。
- 支持卡片关系：contains、references、depends_on、appears_in、uses、derived_from、revises、replaces、continues 等。
- 支持画布 lint、生成准备包、生成交接包、Dreamina CLI 命令计划。

### 5. 生成输出写回

- 生成结果先入库为资产，再写回画布。
- 自动维护输出卡片、谱系关系和槽位状态。
- 支持 Dreamina / Seedance 视频生成链路。
- 支持豆包音频生成链路。
- 支持 KIE Suno 音乐/歌曲生成链路。
- 真实生成必须显式确认执行与成本；默认计划模式不消耗成本。

### 6. 审片与返修

- 可把审片意见登记到资产、资产版本、实体或项目引用上。
- 支持从画布卡片导出批注简报。
- 支持创建返修卡并跟踪 `open / in_progress / resolved / rejected` 状态。
- 支持把审片截图或生成输出版本作为返修证据。

---

## Workbench v1.4 页面

新版工作台已经取代旧版单文件前端，当前包含 8 个主要页面：

| 页面 | 路径 | 用途 |
|---|---|---|
| 仪表盘 | `/` | 项目、资产、暂存、风险等概览 |
| 项目 | `/projects` | 项目卡片、项目详情、错误/警告徽标 |
| 资产库 | `/assets` | 搜索、筛选、表格、资产检查器 |
| 画布 | `/canvas` | React Flow 只读无限画布可视化 |
| 生成 | `/generate` | 生成槽位匹配、预检门、JSON 包 |
| 暂存 | `/staging` | 拖拽上传、入库、拒绝 |
| 审计 | `/audit` | 审计日志、范围筛选、关键词检索 |
| 设置 | `/settings` | 存储根、认证方式和系统信息 |

另有：

- 三栏式应用壳与检查器。
- `Cmd+K` / `Ctrl+K` 命令面板。
- 暗色主题与可访问性对比度修正。
- `prefers-reduced-motion` 支持。
- sourcemap 默认关闭。

> 注意：v1.4 的画布页面是只读可视化；画布结构修改仍通过 Agent 工具或 RPC 完成。

---

## 架构与数据模型

### 技术栈

后端：

- Node.js `>=22`
- ES Modules
- `node:sqlite`
- 无后端 npm 运行时依赖
- OpenClaw native plugin manifest

前端：

- Vite 6
- React 18
- TypeScript
- Tailwind CSS 4
- TanStack Query
- Zustand
- React Router
- React Flow / `@xyflow/react`

### 数据层

SQLite schema 覆盖：

- `actors`
- `assets`
- `asset_versions`
- `asset_version_changes`
- `asset_branches`
- `asset_relations`
- `asset_sources`
- `projects`
- `project_references`
- `asset_classifications`
- `production_entities`
- `asset_entity_links`
- `asset_annotations`
- `derived_files`
- `canvases`
- `canvas_shapes`
- `canvas_edges`
- `canvas_snapshots`
- `commits`

### 存储层

默认仓库根目录：

```text
~/.openclaw-video-assets
```

仓库内部包含：

- SQLite 元数据库。
- 内容寻址对象存储。
- staging 暂存区。
- 认证哈希文件。
- 派生文件与生成输出目录。

这些运行时数据不应提交到 Git。

---

## 安装

### 方式 A：本地链接安装（推荐开发调试）

```bash
git clone https://github.com/canxia-hub/openclaw-video-assets.git
cd openclaw-video-assets
openclaw plugins install -l .
openclaw plugins enable video-assets
openclaw gateway restart
```

### 方式 B：复制到 OpenClaw extensions 目录

Windows PowerShell：

```powershell
git clone https://github.com/canxia-hub/openclaw-video-assets.git "$env:USERPROFILE\.openclaw\extensions\video-assets"
openclaw plugins enable video-assets
openclaw gateway restart
```

macOS / Linux：

```bash
git clone https://github.com/canxia-hub/openclaw-video-assets.git ~/.openclaw/extensions/video-assets
openclaw plugins enable video-assets
openclaw gateway restart
```

### 验证插件是否被发现

```bash
openclaw plugins list
openclaw plugins info video-assets
```

如果插件来自 workspace 或本地 source overlay，OpenClaw 默认 fail-closed：必须显式 enable。

---

## 配置

插件配置位于：

```text
plugins.entries.video-assets.config
```

示例：

```json
{
  "plugins": {
    "entries": {
      "video-assets": {
        "enabled": true,
        "config": {
          "repositoryRoot": "~/.openclaw-video-assets",
          "allowPhysicalDelete": false,
          "auth": {
            "enabled": true,
            "adminPasswordHashFile": "~/.openclaw-video-assets/auth/admin-password.hash",
            "sessionTtlMinutes": 480,
            "maxLoginAttempts": 5,
            "loginWindowMinutes": 10,
            "allowedOrigins": []
          }
        }
      }
    }
  }
}
```

也可以使用 CLI：

```bash
openclaw config set plugins.entries.video-assets.config.repositoryRoot "~/.openclaw-video-assets"
openclaw config set plugins.entries.video-assets.config.auth.adminPasswordHashFile "~/.openclaw-video-assets/auth/admin-password.hash"
openclaw gateway restart
```

### 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---:|---|---|
| `repositoryRoot` | string | `~/.openclaw-video-assets` | 素材与项目仓库根目录 |
| `allowPhysicalDelete` | boolean | `false` | 预留项；当前保持关闭，仅支持归档/软删除语义 |
| `auth.enabled` | boolean | `true` | 是否启用插件级二次认证 |
| `auth.adminPasswordHash` | string | 空 | 管理员密码哈希；不推荐直接写配置 |
| `auth.adminPasswordHashFile` | string | `${repositoryRoot}/auth/admin-password.hash` | 哈希文件路径，推荐使用 |
| `auth.sessionTtlMinutes` | number | `480` | 插件会话有效期 |
| `auth.maxLoginAttempts` | number | `5` | 登录窗口内最大失败次数 |
| `auth.loginWindowMinutes` | number | `10` | 登录限流窗口 |
| `auth.allowedOrigins` | string[] | `[]` | 公网部署时的浏览器来源白名单 |

---

## 首次启动与安全初始化

Workbench 默认启用插件级认证。未配置管理员密码哈希时，登录会被拒绝。

生成密码哈希：

```bash
cd /path/to/openclaw-video-assets
node scripts/hash-password.mjs
```

也可以使用环境变量避免密码进入 shell 历史：

```bash
OPENCLAW_VIDEO_ASSETS_PASSWORD='replace-with-a-strong-password' node scripts/hash-password.mjs
```

把输出的哈希写入：

```text
<repositoryRoot>/auth/admin-password.hash
```

然后重启 Gateway。

> 不要把明文密码、哈希文件、运行时仓库或 `.env` 提交到 Git。

---

## 附属技能

仓库附带 3 个 OpenClaw 技能，位于 `skills/`。它们用于让 Agent 按统一规范操作插件。

### `video-assets-project-material`

项目与素材管理规范：

- 中文命名。
- 项目/素材分类安放。
- 资产信息卡。
- 入库检查。
- 审计脚本。
- 素材接入画布生成链路。

关键参考：

- `references/chinese-naming-standard.md`
- `references/material-classification-routing.md`
- `references/intake-checklist.md`
- `references/asset-info-card-standard.md`

### `video-asset-taxonomy`

分类、实体、批注和项目引用的可读性验收规范：

- 前端徽标不等于噪音，必须转译为处理动作。
- 关键生产资产不能只显示裸 ID。
- 项目检查器错误必须为 0。
- 警告必须逐条说明处理状态。

关键参考：

- `references/taxonomy-controlled-vocabulary.md`
- `references/annotation-templates.md`
- `references/production-continuity-rules.md`

### `video-canvas-operator`

画布操作规范：

- 画布上下文读取。
- 阶段分区与生成槽位。
- Dreamina dry-run / handoff / real generation。
- 生成输出入库与写回。
- 审片批注与返修卡。
- 画布审计和汇报格式。

关键参考：

- `references/video-canvas-tool-contract.md`

### 安装技能

Windows PowerShell：

```powershell
Copy-Item -Recurse .\skills\* "$env:USERPROFILE\.openclaw\skills\"
```

macOS / Linux：

```bash
cp -R ./skills/* ~/.openclaw/skills/
```

---

## Agent 工具清单

插件注册 66 个 Agent 工具。按职责分组如下。

### 资产核心

- `video_asset_ingest`
- `video_asset_search`
- `video_asset_get`
- `video_asset_update_rights`
- `video_asset_create_version`
- `video_asset_create_branch`
- `video_asset_save_copy`
- `video_asset_lineage`

### 派生文件与完整性

- `video_asset_register_derived_file`
- `video_asset_generate_derived_file`
- `video_asset_derived_files`
- `video_asset_integrity_scan`

### 分类与实体

- `video_asset_classify`
- `video_asset_get_classification`
- `video_asset_taxonomy_report`
- `video_entity_create`
- `video_entity_search`
- `video_entity_link_asset`

### 批注

- `video_asset_annotate`
- `video_asset_annotations`
- `video_asset_update_annotation`

### 项目

- `video_project_create`
- `video_project_update_spec`
- `video_project_add_asset_ref`
- `video_project_update_asset_ref`
- `video_project_remove_asset_ref`
- `video_project_refs`
- `video_project_asset_report`
- `video_project_continuity_report`

### 画布上下文与结构

- `video_canvas_create`
- `video_canvas_search`
- `video_canvas_get`
- `video_canvas_agent_context`
- `video_canvas_widget_context`
- `video_canvas_lint`
- `video_canvas_apply_production_template`
- `video_canvas_upsert_shape`
- `video_canvas_delete_shape`
- `video_canvas_link_shapes`
- `video_canvas_unlink_shapes`
- `video_canvas_save_snapshot`

### 画布选择与视图状态

- `video_canvas_save_selection`
- `video_canvas_get_selection`
- `video_canvas_save_view_state`
- `video_canvas_get_view_state`
- `render_video_assets_canvas_widget`

### 生成槽位与交接

- `video_canvas_create_generation_slot`
- `video_canvas_update_generation_slot`
- `video_canvas_generation_package`
- `video_canvas_generation_handoff`
- `video_canvas_dreamina_cli_plan`
- `video_canvas_dreamina_cli_generate_video`
- `video_canvas_insert_generated_asset`
- `video_canvas_fill_generation_slot`

### 审片与返修

- `video_canvas_export_annotation_brief`
- `video_canvas_register_review_annotation`
- `video_canvas_create_revision_card`
- `video_canvas_update_revision_card_status`

### 豆包音频

- `video_audio_doubao_plan`
- `video_audio_doubao_generate`
- `video_canvas_doubao_audio_plan`
- `video_canvas_doubao_audio_generate`

### KIE Suno

- `video_audio_kie_suno_plan`
- `video_audio_kie_suno_generate`
- `video_canvas_kie_suno_audio_plan`
- `video_canvas_kie_suno_audio_generate`

---

## RPC 面

插件同时暴露 `videoAssets.*` RPC namespace，供 Workbench 前端使用。

主要分组：

- `videoAssets.asset.*`
- `videoAssets.entity.*`
- `videoAssets.annotation.*`
- `videoAssets.project.*`
- `videoAssets.canvas.*`
- `videoAssets.audio.*`
- `videoAssets.file.*`
- `videoAssets.staging.*`
- `videoAssets.audit.*`
- `videoAssets.ui.*`

浏览器写操作有白名单约束；静态工作台和媒体路由受插件会话认证保护。

---

## 生成链路治理规则

### 通用原则

1. 先 `plan`，后 `generate`。
2. 默认不执行真实生成。
3. 真实执行必须显式传入执行确认。
4. 涉及成本时必须显式接受成本。
5. 输出先入库，再写回画布。
6. 生成输出默认保持 `license_status=unknown`、`risk_level=unknown`。
7. 未清权素材不得进入正式生成输入。
8. 高风险、受限或拒绝授权素材不得进入交付链路。

### Dreamina / Seedance

典型流程：

1. `video_canvas_generation_package`
2. `video_canvas_generation_handoff`
3. `video_canvas_dreamina_cli_plan`
4. 人工确认积分与授权。
5. `video_canvas_dreamina_cli_generate_video`
6. `ffprobe` 检查输出。
7. `video_canvas_fill_generation_slot`

支持模型集合由适配器按生成类型约束，包括 Seedance 2.0 / Seedance 2.0 Fast 等。

### 豆包音频

真实 API 模式需要：

```text
VOLCENGINE_DOUBAO_AUDIO_API_KEY
VOLCENGINE_DOUBAO_AUDIO_API_KEY_ID（可选，取决于账号配置）
```

支持输出格式：

- `wav`
- `mp3`
- `pcm`
- `ogg_opus`

### KIE Suno

真实 API 模式需要：

```text
KIE_API_KEY
```

默认模型：

```text
V5_5
```

默认基础地址：

```text
https://api.kie.ai
```

KIE/Suno 输出可能包含封面图等非音频 URL；插件会过滤并只把音频 URL 纳入音频资产链路。

---

## 本地验证

后端与插件契约：

```bash
npm run check
```

该命令覆盖：

- 语法检查
- 插件 preflight
- 安全管理器
- 服务 smoke
- 服务一致性
- 项目报告
- 项目引用生命周期
- 媒体探测 fixture
- 文件 API
- staging 流程
- 画布 smoke
- 画布 widget 状态与渲染
- 生成槽位
- 审片写回
- Dreamina handoff / plan / video generate
- 豆包音频 plan / generate
- KIE Suno plan / generate
- taxonomy 与连续性
- 派生文件完整性与生成

> `check:doubao-audio-live` 是真实外部 API smoke test，默认不包含在 `npm run check` 中，避免误消耗额度。

前端构建：

```bash
npm --prefix ui-src ci
npm --prefix ui-src run build
```

构建输出默认写入：

```text
ui-dist-next/
```

确认无误后再用新产物替换部署目录 `ui-dist/`。

---

## 前端开发

```bash
cd ui-src
npm ci
npm run dev
```

Vite dev server 默认端口：

```text
5199
```

开发代理指向：

```text
http://127.0.0.1:33979
```

前端生产 base：

```text
/__openclaw__/video-assets/workbench/
```

如果 Gateway 端口不同，请修改 `ui-src/vite.config.ts` 中的 dev proxy。

---

## 目录结构

```text
openclaw-video-assets/
├── openclaw.plugin.json          # OpenClaw 插件 manifest 与 config schema
├── package.json                  # 后端脚本与插件兼容声明
├── src/                          # 插件后端
│   ├── index.js                  # 工具、路由、RPC 注册入口
│   ├── service.js                # 核心业务服务
│   ├── schema.js                 # SQLite schema
│   ├── storage.js                # 内容寻址对象存储
│   ├── media-probe.js            # 媒体识别与 ffprobe 集成
│   ├── security.js               # 插件级认证与限流
│   ├── doubao-audio-adapter.js   # 豆包音频 plan/generate 适配
│   └── kie-suno-adapter.js       # KIE Suno plan/generate 适配
├── scripts/                      # 后端 smoke / contract / acceptance 测试
├── ui-dist/                      # 当前可部署前端产物
├── ui-src/                       # React Workbench 源码
└── skills/                       # OpenClaw 附属技能
    ├── video-assets-project-material/
    ├── video-asset-taxonomy/
    └── video-canvas-operator/
```

---

## 安全边界

- 不提交运行时仓库。
- 不提交密码、哈希、token、API key、cookie 或会话文件。
- 不自动物理删除资产；默认只归档或软删除。
- 生成输出默认授权未知，不能自动视为 cleared。
- 公网部署时应保留 Gateway 认证，并配置插件级二次认证。
- 公网部署时应配置 `allowedOrigins`，并通过 HTTPS 反向代理暴露。
- 生成工具的真实执行路径必须显式确认成本与授权。

---

## 当前限制

- 画布页面 v1.4 为只读可视化；拖拽编辑不落库。
- `Cmd+K` 搜索结果尚未做跨类型相关度混排。
- 暂存页空态还未统一为空态组件。
- 媒体探测优先调用 `ffprobe`；缺少 `ffprobe` 时回退到扩展名/MIME 基础识别。
- KIE/Suno 是第三方网关链路，模型、价格、字段和文件留存期可能变化。
- Doubao、KIE、Dreamina 的真实生成都依赖外部环境变量、账号状态、CLI 登录态和额度。

---

## 发布说明

### v1.4.0

- 发布新版 Workbench v1.4。
- 旧版单文件前端替换为 Vite + React + TypeScript 工作台。
- 新增 8 个页面：仪表盘、项目、资产库、画布、生成、暂存、审计、设置。
- 新增 Cmd+K 命令面板。
- 新增项目/资产检查器。
- 新增 React Flow 只读画布。
- 新增生成准备页与槽位匹配展示。
- 新增暂存拖拽上传链路。
- 整理 3 个配套 OpenClaw 技能。
- 清理公开发布边界中的本机路径、内部文档指针与运行时产物。

---

## License

当前仓库暂未指定开源许可证。未另行授权前，默认保留所有权利；如果你希望复用到其他项目，请先联系仓库维护者确认许可边界。
