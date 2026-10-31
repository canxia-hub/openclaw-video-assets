---
name: "dreamina-cli-official-guide"
description: "Dreamina/即梦 CLI：代理清空、模型与分辨率硬约束、白名单探测、双CLI无前端入口、付费门与恢复、配置运维纪律"
---

# Dreamina CLI 指南

何时用：用官方 `dreamina`（即梦）CLI 做图像/视频生成、查积分、管理会话与任务历史；在花积分前确认参数组合；把生成结果接回 video-assets 资产与项目引用时。

相关技能的状态：改/验付费队列接线 → `video-assets-paid-path`；崩溃恢复状态机 → `durable-job-crash-recovery`；外部调用脱敏/超时 → `provider-call-hardening`。**这三个是 Workshop 候选，尚未激活**；写成「去用某技能」不代表它已可调用，先确认该技能是否为现役。

## 本机执行前提（必做）

exec 宿主会注入 `HTTP_PROXY/HTTPS_PROXY`（`http://openclaw:***@127.0.0.1:47415`），CLI 经该代理会认证失败：

```
authsdk: refresh failed: protocol transport: do request
```

每个调用脚本开头清空代理，再调用 CLI：

```powershell
$env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:ALL_PROXY = ''
& dreamina user_credit
```

探测本机服务加 `-NoProxy`，否则代理 502 会把未运行的服务误判为在线。

## 零成本检查顺序

1. `dreamina version` — 版本与 build。
2. `dreamina user_credit` — 积分与 VIP 等级（真实生成前必做）。
3. `dreamina <subcommand> --help` — 参数权威，不照抄本技能。
4. `dreamina session list` / `dreamina list_task` — 复用会话与历史。

## 版本与升级

安装或升级二进制时读取 [版本与升级](references/version-and-upgrade.md)，先检查运行任务并保留回滚版本。日常调用以实时 version/help 为准。

## 模型与参数（1.4.18 起，1.4.19 同）

### 视频

| 命令 | 支持模型 | 关键约束 |
|---|---|---|
| text2video | 2.0 / 2.0fast / 2.0_vip / 2.0fast_vip / 2.0mini / **2.5** | 默认 `seedance2.0fast`；`--video_resolution` 必填 |
| image2video | 1.0fast / 1.5pro / 2.0 家族 / **2.5** | 默认 `seedance2.0_vip`；`--image --prompt --video_resolution` 必填；2.5 跟随首帧并**拒绝** `--ratio` |
| multimodal2video | 2.0 家族 / **2.5** | 2.5：image≤30 / video≤10 / audio≤10 / 总≤50，允许纯音频；2.0 家族：image≤9 / video≤3 / audio≤3 / 总≤12；省略 `--ratio` 用 16:9 |
| multiframe2video | 固定模型 | 2-20 张图，720p/1080p，每段 1-8s |
| frames2video | 首尾帧驱动 | 见 `dreamina frames2video --help` |

**分辨率与时长按模型硬校验**（CLI 原话：unsupported or legacy values are rejected instead of silently adjusted）：

- `seedance2.5` → 480p / 720p / 1080p，4-30s，**VIP-only**。
- `seedance2.0_vip` → 720p / 1080p / 4k。
- **其余模型（含 `2.0fast` / `2.0mini` / `1.0fast` / `1.5pro`）→ 只有 720p**；1.0fast 5-10s、1.5pro 5-12s、2.0 家族 4-15s。
- 推论：**480p 只有 `seedance2.5` 能给**；不存在「2.0fast + 480p」。写规格前按本表核对，别凭型号直觉填。

**家主偏好（2026-10-12）**：日常生成优先 `seedance2.0fast_vip` 与 `seedance2.5`；`seedance2.0fast` 排队慢且出现过平台侧任务被删（`task was deleted`，已退款），不作为默认。

### 图像

| 命令 | 支持模型 | 关键约束 |
|---|---|---|
| text2image | 3.0 / 3.1 / 4.0 / 4.1 / 4.5 / 4.6 / 4.7 / 5.0 / **5.0Pro** | 默认 `5.0`；`--resolution_type` 必填；`--generate_num` 1-10 |
| image2image | 4.0 / 4.1 / 4.5 / 4.6 / 4.7 / 5.0 / **5.0Pro** | 同上；`--images` 最多 10 张 |
| image_upscale | 无 `model_version` | `--image` + `--resolution_type` 2k / 4k / 8k |

分辨率档：3.0/3.1 → 1k 或 2k；4.x 与 5.0 → 2k 或 4k；**5.0Pro → 1.5k / 2k / 4k**。`--width`/`--height` 成对且与 `--ratio` 互斥。

**命名**：只用 CLI 原值 `5.0Pro`（大写 P）；`5.0pro`/`5.0PRO` 由插件归一，自造名（如 `seedream-5.0-pro`）被拒。

### 后端 version 白名单与零成本探测法（2026-09-20 实测）

CLI 本地**不校验** model 白名单，统一透传后端，三类命令受理范围各不相同：`image2video` 最宽（3.0_fast/3.0_pro/3.0fast/3.0pro/3.5_pro/3.5pro/seedance1.0/seedance1.0fast/seedance1.5pro/2.0 家族/2.5）；`text2video` 次之（不含 3.0pro/3.0_pro）；`multimodal2video` 最窄（仅 2.0 家族/2.5）。**裸值 `3.0` 三类均不受理**。

help 与后端受理范围**双向不一致**。增删规格前用零成本探测法钉死（零生成、零计费）：

1. 传**明显非法**的取值（如 `___invalid_probe___`）——CLI 本地不校验，原样透传后端；
2. 必须同时配**真实存在的输入文件**，否则请求在上传阶段就失败，到不了参数校验；
3. 后端返回 `invalid param:version, version should be in [...]`——**方括号内即真实受理集合**；
4. 与 help 清单比对后增删规格表。

判读规则：**help 有而白名单无 → 无效值，移除**；**白名单有而 help 不列 → 不等于已验证可生成**，须一次真实小样才放行（例：`seedance1.0` 未收录）。

## 模型值的分层与增删规则

禁止按编号大小或「看起来过时」盲删：

| 层 | 判据 | 操作 |
|---|---|---|
| 默认值 | 未传 `model_version` 时的回退（视频 `seedance2.0fast`、图像 `5.0`） | 变更需显式决策，并同步插件 README、本技能与用例期望 |
| 已验收 | 有真机产出 + `submit_id` 证据（`seedance2.5`、`5.0Pro`） | 保留并优先推荐 |
| 未验收 | 在 help/规格表内但未真机跑过 | 可计划使用，不得写成「已支持/已验收」 |
| 历史兼容 legacy | help 不列、后端白名单仍受理（3.0fast/3.0_fast/3.0pro/3.0_pro/3.5pro/3.5_pro） | **保留勿删**（删掉会让兼容旧脚本的调用失败）；移除前提＝后端白名单不再受理，用探测法复核 |
| 已失效 | 三类白名单均不受理（裸 `3.0`） | 从枚举移除，文档留「为何移除、如何探测」 |
| 待核验 | 仅见白名单、未验证可生成 | 不收录；收录前必须跑一次真实小样 |

凡保留兼容别名（模型/参数/工具名）都须写明「为何保留 + 移除前提」；**不编固定到期日**——本技能不掌握官方退役时间表。

## 上传文件的扩展名与体积（关键坑）

CLI 按**扩展名**判定上传类型。插件的内容寻址库文件名以 `.blob` 结尾，直接上传必失败：

```
upload resource "...blob": upload image: upload phase, no file upload
```

插件已内建修复：上传前把 `.blob` 物化为带正确扩展名的缓存文件（mime 优先，magic bytes 回退）。**手写 argv 时同样要先把文件复制成正确扩展名**。

**体积坑（两次独立观察）**：2026-09 一批约 1.95MB PNG 上传阶段多次失败、压到约 190KB JPG 后通过；2026-10-12 multimodal2video 双图 384KB/338KB PNG 同样 `upload phase, no file upload`，压成 48KB/35KB JPG 后一次通过。**仍只是个案观察，不是「PNG 必失败」的普适结论**；但 CLI 直驱多图输入时默认先转小体积 JPG，失败时按「先查扩展名 → 再压体积」顺序处置。

## 双 CLI 无前端工具路线

1. 旧 dreamina.exe 使用 `video_dreamina_cli`；官方 dreamina-canvas.exe 使用 `video_dreamina_canvas_cli`。二者的命令、模型、认证和参数拼写互不混用。官方画布 CLI 的细节以其已安装官方技能与实时 schema 为准。
2. 默认 `execute=false` 返回零 I/O 计划；查询时传 `execute=true`。command 为规范子命令，argv 为逐项 token，不是 shell 字符串。
3. 先执行 version/help；官方 CLI 另外读 schema/auth status，再发现 model/voice。工具不要求内部 canvas_id，也不打开或检查前端。
4. 真实写操作使用稳定 operation_key；付费另外传 accept_credit_spend=true，并满足宿主可信身份、插件预算和供应商积分批准。官方付费命令显式复用 submit-id；旧 CLI 生成强制 poll=0。
5. 有结果不确定或进程超时，复用相同 operation_key 读取已记录结果／恢复身份；查询原 submitId／operationRef，不换 key 自动重提。
6. 持久文件验证后走 video_asset_ingest → 分类／来源授权 → video_project_add_asset_ref。引用使用资产版本、项目与官方公开节点／资源身份，不创建内部槽位、不写回 Workbench。
7. 使用 .blob 资产作为 CLI 文件输入时，先物化为正确媒体扩展名；授权与风险按来源证据记录，不因为生成成功自动 cleared。

旧内部画布、Workbench、Widget 和 video_canvas_* 工具已归档；不以旧画布技能或前端截图作为执行门。

## 付费门

- **队列默认关闭**：`generationJobs.enabled` 须显式 `true`，否则 `GENERATION_JOBS_DISABLED`；`maxCredits` 默认 `0` → 正数估算被 `GENERATION_BUDGET_EXCEEDED` 拒（均在**建单之前**拒绝）。
- **新插件成本入口**：dreamina.cli.execute 与 dreamina.canvas.execute 分别配置经确认的成本证据；缺 security.generation.budget.estimates 对应值会拒绝。一次付费提交只预留一次估算；只读恢复不重提付费任务，不按轮询次数重复预留。既有预算不因本次迁移自动扩大。
- **预算是本地估算台账，不是供应商硬限**：建单按 `max(调用方 estimate_credits, 注册表参考值)` 预留；`actual_credits` 完成后才写入，**该上限无法阻止供应商实际扣费超过估算**，只能事后对账。注册表参考值自带 `unverified-reference`，不是价格证据。
- 创作面另有 `security.generation` 授权门（默认 `mode=enforce`、`allowSurfaces=[]`、`ledger=none`）；缺 `trusted=true`/`actor_id`/`scopes`（复数数组）即拒。
- **本机当前配置（2026-10-13 起）**：`security.generation.budget.totalCredits=3000`、`generationJobs.maxCredits=3000`（家主批准，由 170 扩到 3000）。调整配置遵循 `references/plugin-ops-discipline.md` §6（逐项复核）与 §7（需要完整重启，热重载不可靠）。

## 批量生成与两类假失败

1. `get_history_by_ids failed: ret=1015`——本地查询历史失败，**任务通常已提交成功**。补救：`list_task` 找 `submit_id`，再 `query_result --submit_id=<id> --download_dir=<dir>` 下载。
2. `gen_status=fail` 且 `fail_reason` 含 `upload phase, no file upload`——先查扩展名，再压体积（见「上传文件的扩展名与体积」两次观察）。
3. 每镜跑完立刻 `list_task` 复核；实测中**失败尝试没有产生 `credit_count`**（属观察口径，不是对供应商计费规则的声明）。
4. **下载阶段偶发 CDN 超时**（2026-10-12 实测）：`do request: Get "https://v9-artist.vlabvod.com/...": dial tcp ...: i/o timeout` 连续两次后 CLI 自动换 `v3-artist` 域名第三次成功。下载失败 ≠ 任务失败，重查 `query_result` 即可，不要重复提交。
5. **平台侧任务被删**（2026-10-12 实测）：`gen_status=fail, fail_reason=generation failed: task was deleted`（seedance2.0fast 排队数分钟后），所扣积分当日退回账户。遇到此类失败换 fast_vip/2.5 重提即可。
6. 成本基准（记录值，非当前报价）：seedance2.5 480p/4s = 48、720p/5s = 100（text2video 与 multimodal2video 同价，2026-10-12/13 复核一致）；2.0 家族同规格约 25；图像 5.0Pro 2k = 8。

## 安全门

- **计划与真机分离**：新 CLI 工具默认零 I/O 计划；只有 execute=true 才调用二进制。付费须 accept_credit_spend=true、可信宿主身份、已配置预算，以及官方 CLI 要求的报价／积分批准。用 operation_key 与 submit-id 恢复同一任务，不用独立脚本参数绕过插件门。
- 真生成前先 `user_credit`；`execute=false` / `accept_credit_spend=false` 只用于计划与 schema 校验。
- 提交成功判据不是退出码：需 `submit_id` 存在且 `gen_status` 为 `querying` 或 `success`；`fail` 时读 `fail_reason` 并回报。
- 返回 `AigcComplianceConfirmationRequired` 时，先在即梦 Web 端完成一次性授权确认再重试。
- 任务处理中用 `query_result --submit_id=` 查询，不要重复提交。
- 下载后先验证文件可读（存在、格式签名、非空大小）再报告成功；dry-run 不产生媒体资产。

## 排障

- 登录类错误先确认走的是 CLI 直连而非 CDP：CLI 登录态与网页登录态互相独立。
- 插件工具不可见：重启网关后重查工具枚举；**网关重启在当前 agent turn 结束后才落地**，turn 内轮询会误判未重启。
- 改 `src/*.js` 的生效判定、回滚点核验、文档漂移自查，以及 openclaw.json 配置编辑纪律、热重载失效恢复、预算门判读，见 `references/plugin-ops-discipline.md`（§6/§7/§8 为 2026-10-12/13 新增）。
- 日志：`~/.dreamina_cli/logs/dreamina.log*`；插件自检：`check:dreamina-cli-video`、`check:dreamina-cli-image`、`check:dreamina-model-specs`、`check`。

## 已验证事实索引

| 事实 | 日期 | 出处 |
|---|---|---|
| CLI 1.4.18 build ec1b9fa；480p 仅 2.5、其余仅 720p；upscale 2k/4k/8k | 2026-09-24 | `dreamina --help` 快照：`REN-12/evidence/20-cli-help/` |
| CLI 1.4.19（build 1d0bd17）升级；`estimated_remaining_seconds` 偏保守只作数量级参考 | 2026-10-12 | 本机升级记录 + 当日三次真机生成复验 |
| text2video/image2video/multimodal2video 三路径真机跑通（seedance2.5 480p/4s=48 与 720p/5s=100） | 2026-10-12 | submit_id：e09b4ba3 / 3cf1f4a6 / b1bfe829 |
| 插件画布直驱全链路（生成→自动入库→写回画布→补分类清权连线→lint 0/0/0） | 2026-10-13 | submit_id：384ee05a；asset_58ae33be；canvas_52e4569e |
| 上传体积坑二次观察（PNG 384KB/338KB 失败 → JPG 48KB/35KB 通过）与 CDN 下载超时自动换域名 | 2026-10-12 | step12/13/14 脚本日志 |
| 预算门配置扩至 3000 并生效；热重载 drain 超时需完整重启恢复 | 2026-10-12/13 | openclaw.json:1823/1847；`references/plugin-ops-discipline.md` §6/§7/§8 |
| 69 工具名 + 69/69 参数名一致；契约面 17 ops、0 参数丢失 | 2026-09-24 | `REN-12/evidence/32/33/34-*.json` |
| 预算须按「估算 × 调用次数」预留；按一作业一估算会在第 3 次调用被拒并伪装成 `GENERATION_POLL_UNRESOLVED` | 2026-09-24 | `REN-12/runtime-budget-runbook.md` §5.1（本地替身实测，未调供应商） |
| 真机入口双钥匙（授权记录 + `--execute-live`）、默认分支 0 调用、替身被拒 | 2026-09-24 | `REN-12/evidence/93/entry-selftest-report.json`（28 项） |
| `.blob` 上传扩展名根因与修复 | 2026-09-20 | `docs/notes/plugin-seedance25-seedream5pro-verification-2026-09-20.md` |
| 画布门禁两处同源缺陷修复 | 2026-09-20 | `docs/notes/plugin-canvas-draft-output-gate-fix-2026-09-20.md`、`plugin-handoff-model-version-fix-2026-09-20.md` |
| 后端 version 白名单与探测法 | 2026-09-20 | `docs/notes/channel-notes-dreamina-cli-2026-09-19.md` |
| 付费链本地替身验收（59/36/33/48 项；真机未做） | 2026-09-24 | `REN-11/review-50-closure.md` |
