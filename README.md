# Video Assets Plugin

状态：已接入 OpenClaw Gateway，用于视频项目资产、制作画布、生成写回与音频/音乐资产管理。

## 当前已实现

- Native OpenClaw plugin manifest：`openclaw.plugin.json`
- Plugin entry：`src/index.js`
- SQLite schema：`src/schema.js`
- Repository service：`src/service.js`
- Content-addressed object store：`src/storage.js`
- Media probe by extension/MIME plus ffprobe metadata：`src/media-probe.js`
- Agent tools：
  - `video_asset_ingest`
  - `video_asset_search`
  - `video_asset_get`
  - `video_asset_update_metadata`
  - `video_asset_create_version`
  - `video_asset_create_branch`
  - `video_asset_save_copy`
  - `video_asset_lineage`
  - `video_project_create`
  - `video_project_add_asset_ref`
  - `video_project_refs`
  - `video_project_asset_report`
  - `video_audio_doubao_plan`
  - `video_audio_doubao_generate`
  - `video_audio_kie_suno_plan`
  - `video_audio_kie_suno_generate`
  - `video_canvas_doubao_audio_plan`
  - `video_canvas_doubao_audio_generate`
  - `video_canvas_kie_suno_audio_plan`
  - `video_canvas_kie_suno_audio_generate`
- Gateway RPC namespace draft：`videoAssets.*`

## 即梦（Dreamina）CLI 生成路由（2026-09-20 更新）

画布可直驱即梦 CLI，无需「CLI 直调 + 插件回填」绕行。

生成工具：

| 工具 | 用途 |
|---|---|
| `video_canvas_dreamina_cli_plan` | 从画布交接包构建命令计划，不消耗积分 |
| `video_canvas_dreamina_cli_generate_video` | 图生/文生/多模态视频；支持 `seedance2.5`（480p/720p/1080p、4-30s）与 `seedance2.0` 家族（`seedance2.0_vip` 额外支持 4k） |
| `video_canvas_dreamina_cli_generate_image` | 图像生成/封面/编辑；支持 `5.0Pro`（resolution_type 1.5k/2k/4k）等全部 CLI 图像模型 |
| `video_canvas_dreamina_cli_upscale_image` | 图像放大（`image_upscale`，resolution_type 2k/4k/8k；入参 `asset_version_id` 必填） |

要点：

- **模型能力收敛为单一规格表**（`src/service.js` 的 `DREAMINA_VIDEO_MODEL_SPECS` / `DREAMINA_IMAGE_MODEL_SPECS`），工具 schema 的 enum 由表派生。新增/调整模型只改表，**不要**在 enum 与校验集合两处各写一份。
- **上传路径必须带正确扩展名**：对象库文件一律以 `.blob` 结尾，而即梦 CLI 按扩展名判定上传类型；插件已内建 `materializeDreaminaUploadFile()` 在上传前物化为带正确扩展名的缓存文件（mime 优先、magic bytes 回退）。上传阶段失败不计费。
- **真实执行需显式同意**：`execute=true` 且 `accept_credit_spend=true`；默认先跑 `user_credit` 预检，返回中带 `credit_before` / `credit_after`。
- **写回产出**：生成结果会作为 `draft_output` 卡片写回画布。该卡片**不参与**下一次交接包的**输入**校验（`GENERATION_INPUT_SLOT_KEYS` 已显式排除 `draft_output`），因此未做 taxonomy 分类**不会**阻断下一次生成；仍建议用 `video_asset_classify`（`delivery / generated_output / <生成型>`）补分类，以维持素材检索与分类连续性。
- 模型白名单以**后端**为准：CLI 本地不做 model 白名单校验，`--help` 声明与后端受理范围双向不一致；核验手法见技能 `dreamina-cli-official-guide`。

## 音乐生成与 Suno/KIE 路由

所有 Suno/KIE 音乐、歌曲、BGM、器乐、角色歌、歌词成曲和视频配乐产出，默认通过本插件管理，不直接把远程 URL 或裸文件交付给下游。

优先顺序：

1. 有 canvas / generation slot 时，先用 `video_canvas_kie_suno_audio_plan`，再用 `video_canvas_kie_suno_audio_generate`。
2. 有项目上下文但不需要画布槽位时，先用 `video_audio_kie_suno_plan`，再用 `video_audio_kie_suno_generate`。
3. 真实提交必须显式传 `execute=true`、`accept_cost=true`、`backend=api`；生产验证默认传 `poll_result=true`、`download_outputs=true`、`ingest_outputs=true`。
4. KIE/Suno 输出默认 `license_status=unknown`、`risk_level=unknown`，公开发布或商用前必须人工复核授权与条款。
5. 下载后必须探测音频流、时长和文件可读性；封面图、缩略图或非音频误入库时，只做软拒绝/高风险标记，不物理删除审计文件。

### 音频密钥解析优先级（2026-09-13 起）

KIE / 豆包音频适配器的 API Key 按以下顺序解析（两者一致）：

1. **插件配置（推荐）**：`plugins.entries.video-assets.config.audio.kie.apiKey` / `audio.doubao.apiKey`。值可直接写 SecretRef（如 `{"source":"store","provider":"default","id":"KIE_API_KEY"}`），网关启动时物化为字符串注入插件，不再依赖人工设置 Windows 环境变量。
2. **环境变量回退**：`KIE_API_KEY` / `VOLCENGINE_DOUBAO_AUDIO_API_KEY`（保持旧行为兼容）。
3. **两者皆无**：plan 返回明确 blocker（如 `KIE_API_KEY is required for backend=api`），不会静默失败。

说明：

- 未物化的 SecretRef 对象（如网关版本不支持）会被忽略并回退环境变量，不会误用。
- 清单已声明 `configContracts.secretInputs`（`audio.kie.apiKey` / `audio.doubao.apiKey`），Settings 界面自动脱敏，`openclaw secrets` 审计覆盖这两个路径。
- 输出下载（`downloadFile`）走公开 URL，无需密钥，行为不变；工具返回结构保持一致，仅 `validation.checks.auth` 在密钥来自配置时标注实际来源。
- 验证脚本：`npm run check:audio-key-resolution`。
- ⚠️ 引用不存在的 store 条目可能导致网关启动失败；配置前先 `secrets list` 确认 id 存在。
- ⚠️ **configSchema 必须同时接受字符串与 SecretRef 对象**（`anyOf: [{type:string}, {source/provider/id 对象}]`）：声明 `secretInputs` 后，网关用 configSchema 校验的是**物化前的源配置**，SecretRef 此时仍是对象。若 schema 只写 `"type": "string"`，含引用的 openclaw.json 会在**启动校验阶段直接拒绝、网关重启失败**（2026-09-14 实测踩坑，由主线程修复；插件重装/更新时务必保留该 anyOf 写法，参考 `C:\Users\Administrator\openclaw-repair-20260914\repair-notes.md`）。

## 云端对象存储接入（rclone 挂载，厂商中立）

当本机磁盘不足时，可以把占空间的对象库整体迁移到任意 S3 兼容对象存储（腾讯云 COS、阿里 OSS、AWS S3、Cloudflare R2、MinIO 等），插件无需改造：数据库只记录路径，文件经 `fs.createReadStream` 按路径流式读取，路径能通即可。

**分层原则（必须遵守）**

- `asset-repo/objects/`（SHA-256 内容寻址 blob，体积大头）→ 放云端挂载盘。
- `metadata/video-assets.sqlite`、`cache/`、`project-repo/` → 必须留在本地磁盘。SQLite 放在网络/挂载盘上有锁损坏风险；缓存高频读写，放本地保证 UI 响应。

**接入步骤（以 Windows + rclone 为例）**

1. 安装 WinFsp（v2.1+）与 rclone；`rclone config create <name> s3 provider=<厂商> endpoint=<endpoint> ...` 配好 remote，`rclone lsd <name>:<bucket>` 验证权限。
2. 磁盘模式挂载：`rclone mount <name>:<bucket> V: --vfs-cache-mode full --vfs-cache-max-size 2G --vfs-cache-max-age 1h --vfs-write-back 5s`。
   ⚠️ **不要加 `--network-mode`**：网络盘不能做目录联接（Junction）的目标，访问时报“重分析点缓冲区中的数据无效”。
3. 复制并校验：`rclone copy <repo>/asset-repo/objects V:\objects`。内容寻址对象库校验天然简单——文件名即 SHA-256，抽样 `Get-FileHash` 比对即可。
4. 切换：本地 `objects` 改名为 `objects.local-backup`（留观察期，不直接删除），再 `New-Item -ItemType Junction -Path <repo>\asset-repo\objects -Target V:\objects`。
5. 回归验证：经 Junction 读对象 + 哈希比对；插件侧搜索 / 详情 / 派生文件生成 / 新入库写入（新 blob 应自动出现在桶中）。
6. 保证启动顺序：挂载必须先于 OpenClaw Gateway（可用开机计划任务，SYSTEM 身份、失败重试）。挂载盘是唯一单点依赖，素材突然全部读不到时先查挂载状态。

**其他提示**

- 同地域内网访问通常免流量费（如腾讯云 CVM ↔ 同地域 COS），可用 `nslookup <bucket>.cos.<region>.myqcloud.com` 验证是否返回内网 IP（10.x / 169.254.x）。
- deep integrity_scan 会全量回源读取云端对象，大库少用；日常用浅扫描。
- Linux/macOS 同理：rclone mount 到本地路径后，用符号链接替换 `objects` 目录即可（无 Junction 兼容性问题）。
- 参考实现记录（腾讯云 COS 实测）：`docs/cos-storage-research-2026-08-22.md`（使用者工作区）、Wiki `procedures/rclone-cos-windows-junction.md`。

## 当前验证

```powershell
npm run check
```

已通过。

Smoke test 已验证：

- ingest raw asset
- create branch
- create version with change_items
- save working copy
- create project
- add project reference
- update project reference schema required fields
- update asset metadata (title / description / tags)
- query lineage
- Doubao 音频 plan/generate
- KIE Suno plan/generate
- KIE Suno API URL 过滤回归：混入 cover `.jpeg` 时只登记音频 URL
- canvas 音频生成槽写回

## 当前限制

- media probe 已接 ffprobe；缺少 ffprobe 或探测失败时回退到扩展名/MIME 基础识别。
- KIE/Suno 是第三方网关链路，模型、价格、字段和留存期可能变化；高成本或正式项目使用前应先做 `execute=false` 计划预检。
- 生成音乐的授权状态不得自动标记为 cleared。
- 对象库在云端挂载盘上时，挂载未就绪会导致素材读写全部失败；需保证挂载先于 Gateway 启动（见“云端对象存储接入”）。

## 下一步

1. 为 KIE/Suno 输出增加更细的封面图独立入库策略。
2. 增加项目级音乐审听、响度、循环点与对白遮挡检查报告。
3. 为更多 KIE Suno endpoint 扩展插件工具，如 extend、stems、WAV、MV、lyrics。
