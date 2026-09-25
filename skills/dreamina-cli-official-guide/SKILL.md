---
name: "dreamina-cli-official-guide"
description: "Dreamina/即梦 CLI：代理清空、模型与分辨率硬约束、白名单探测、两代付费门与预算乘法、画布直驱"
---

# Dreamina CLI 指南

何时用：用官方 `dreamina`（即梦）CLI 做图像/视频生成、查积分、管理会话与任务历史；在花积分前确认参数组合；把生成结果接回 video-assets 画布与资产库时。

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

seedance2.5 需 **1.4.18（build ec1b9fa，2026-09-09）** 起；1.4.8（build 54f1bdf）只支持 2.0 家族。

升级流程（2026-09-19 已验证）：

1. 读元数据 `.../ljhwZthlaukjlkulzlp/version.json`。
2. 下载官方安装脚本 `https://jimeng.jianying.com/cli` 并先审查：它只做「下载二进制 → 替换 → 写 PATH → 同步 SKILL.md 与 version.json」。
3. 下载 `.../dreamina_cli_beta/dreamina_cli_windows_amd64.exe`，校验 sha256 后再装。
4. 替换前确认没有正在跑的生成：`Get-Process dreamina` 看清进程再决定；正在跑的任务被中断会影响该次产出（不代表已提交的任务会被重算）。**只针对要替换的二进制**，不要用笼统的「杀掉所有相关进程」做法。
5. 备份旧版到 `~/.dreamina_cli/backup/`，替换 `~/bin/dreamina.exe`，同步 `~/.dreamina_cli/version.json` 与 `~/.dreamina_cli/dreamina/SKILL.md`。
6. 复验 `dreamina version` 与 `dreamina user_credit`。

升级后首次 `user_credit` 可能返回全 0，属瞬态（同轮第二次调用恢复）；不要据此判定登录失效。

## 模型与参数（1.4.18）

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

## 上传文件的扩展名（关键坑）

CLI 按**扩展名**判定上传类型。插件的内容寻址库文件名以 `.blob` 结尾，直接上传必失败：

```
upload resource "...blob": upload image: upload phase, no file upload
```

插件已内建修复：上传前把 `.blob` 物化为带正确扩展名的缓存文件（mime 优先，magic bytes 回退）。**手写 argv 时同样要先把文件复制成正确扩展名**。

## 插件路由

画布直驱顺序：`video_canvas_generation_package` → `video_canvas_generation_handoff` → `video_canvas_dreamina_cli_plan`（只出命令）→ `video_canvas_dreamina_cli_generate_video` / `_generate_image` / `_upscale_image`（真生成/放大）→ 回填 `video_asset_ingest` / `video_asset_update_rights` / `video_asset_classify` / `video_project_add_asset_ref` / `video_canvas_upsert_shape` / `video_canvas_link_shapes` / `video_canvas_lint`。

模型/分辨率枚举由 `src/capability-registry.js` 单一规格表派生到工具 schema，改规格只需改表；新增工具须同步三处（`src/index.js` 注册、`openclaw.plugin.json` 的 `contracts.tools`、`TOOL_TITLES_ZH`/`TOOL_DESCRIPTIONS_ZH`），否则 `check:preflight` 报清单不匹配。

**画布门禁判读**（2026-09-20 修复后行为，取代早前「写回产出必须先分类」）：写回产出 `draft_output` 卡片**不参与**下一轮交接包输入校验（不触发 taxonomy/授权/风险门，不计入输入上限）；补分类仍是治理要求但已非生成前置。仍被 `生成输入缺少 taxonomy 分类` 挡住时，先确认卡片是否进了**真正的输入槽**。阻断项与 `execute` 无关：`execute=false` 即返回完整 `blockers`，判读门禁用零成本 dry-run。`blockers` 里的模型名应与请求一致（`... for model <model>`），不一致即为版本未下沉的指纹。

## 两代形态：先分清「磁盘上装了什么」和「进程实际在跑什么」

- **A · 当前已安装**（2026-09-20 P4 基线，`~/.openclaw/extensions/video-assets`）：画布直驱工具**直接调 CLI**（`execFile`）；真跑开关是调用参数 `execute=true` 且 `accept_credit_spend=true`；跑前跑后各一次 `user_credit` 取差额。**没有持久队列/预算台账/`sop-v2-*` 模块**。
- **B · 候选**（REN-09/10/11 代码）：有队列、台账预算门、SOP v2 链、可信上下文；在部署前**不可调用**。缺这些模块**不代表**供应商真机历史验收没发生过；反过来，历史验收**也不能**证明当前部署的这个构建具备那些行为。

两代的**工具面与参数面完全相同**（2026-09-24 独立复算）：69 个工具名一致（含 widget 的 `rawTool` 注册形式）、**69/69 工具的参数名逐项一致**；候选另有 REN-04 合并契约面（17 个 operation、`additionalProperties:false`、`RESIDENT_MAX 10`），69 个旧工具名全部解析到唯一 operation，**0 参数丢失**，8 个音频工具的 schema 由共享 helper 构造（`includeCanvas` 是构造开关，不是用户参数）。判据脚本见 `REN-12/scripts/32/33/34`。
> 勘误：本技能早前写「各 68 工具」，是我自己的提取脚本漏认 `rawTool(` 注册形式所致；真实数是 69，与 `contracts.tools` 声明、运行时目录三处一致。

**判代法（证据强度分层）**：① 强——比对磁盘副本哈希与进程实际加载的模块指纹；② 中——功能探测（`video_canvas_dreamina_cli_plan` + `execute=false`，看返回是否含队列/预算字段）；③ 弱——只看进程启动时间与文件 mtime 的先后（热加载/多进程/替换都能让两者同时成立却不一致）。**只用①或②下结论**；③ 只能排除明显旧进程。**磁盘副本 = 运行态**这个假设本身不成立。

**预演插件替换/回滚时只拷「代码面」**：`src`、`sql`、`scripts`、`package.json`、`openclaw.plugin.json`、`README.md`。已安装目录里的 `ui-dist*` 构建树合计数百 MB，与恢复机制无关；整目录拷贝会把一次预演从约 2 MB 撑到数百 MB。报告里显式写出拷贝范围与排除项，别让对方读成「整个目录都验过」。

## 付费门

- **队列默认关闭**：`generationJobs.enabled` 须显式 `true`，否则 `GENERATION_JOBS_DISABLED`；`maxCredits` 默认 `0` → 正数估算被 `GENERATION_BUDGET_EXCEEDED` 拒（均在**建单之前**拒绝）。
- **预算要按「单次估算 × 该作业的 provider 调用次数」配，别按「一作业一估算」配**：预留是**每次调用**各扣一次（提交 1 次 + 每轮状态查询各 1 次），按一作业一估算配会在第 3 次调用被拒；更糟的是这个拒绝会被前置检查吞掉、表面报成 `GENERATION_POLL_UNRESOLVED`（看着像查询未决，实为预算耗尽），排查方向会被带偏。网关层与队列层两层额度都要按同一乘法给。配完先用本地替身路径跑一图一视频，核对「每作业提交恰 1 次 + 同 run 重入 0 新提交」，再考虑真机。
- **预算是本地估算台账，不是供应商硬限**：建单按 `max(调用方 estimate_credits, 注册表参考值)` 预留；`actual_credits` 完成后才写入，**该上限无法阻止供应商实际扣费超过估算**，只能事后对账。注册表参考值自带 `unverified-reference`，不是价格证据。
- 创作面另有 `security.generation` 授权门（默认 `mode=enforce`、`allowSurfaces=[]`、`ledger=none`）；缺 `trusted=true`/`actor_id`/`scopes`（复数数组）即拒。

## 批量生成与两类假失败

1. `get_history_by_ids failed: ret=1015`——本地查询历史失败，**任务通常已提交成功**。补救：`list_task` 找 `submit_id`，再 `query_result --submit_id=<id> --download_dir=<dir>` 下载。
2. `gen_status=fail` 且 `fail_reason` 含 `upload phase, no file upload`——先查扩展名；另有一次观察：同一批 1.95MB PNG 提交出现多次上传阶段失败，压到约 190KB JPG 后该批连续通过。**这是单次观察，不是"PNG 有 1/3 失败率"的普适结论**；遇到失败按「先查扩展名 → 再压体积」的处置顺序做，不要引用成概率。
3. 每镜跑完立刻 `list_task` 复核；实测中**失败尝试没有产生 `credit_count`**（属观察口径，不是对供应商计费规则的声明）。
4. 成本基准（记录值，非当前报价）：seedance2.5 480p/4s = 48、720p/5s = 100；2.0 家族同规格约 25；图像 5.0Pro 2k = 8。

## 安全门

- **真机入口与计划入口分开放**：真机分支走**独立脚本** + 两道钥匙——授权记录（`authorized=true` 且带 `actor_id` / `expires_at` / `max_credits` / 条目白名单）**再加**命令行显式 `--execute-live`；默认分支只做计划：不建库、不建单、0 次调用。授权记录随包落盘时就是 `authorized=false`，运行前由人填。**别把探针脚本里的 JSON 开关当真机入口**——那样一个字段改错就会付钱；`--local-standin` 之类替身参数在真机分支必须被直接拒。
- 真生成前先 `user_credit`；`execute=false` / `accept_credit_spend=false` 只用于计划与 schema 校验。
- 提交成功判据不是退出码：需 `submit_id` 存在且 `gen_status` 为 `querying` 或 `success`；`fail` 时读 `fail_reason` 并回报。
- 返回 `AigcComplianceConfirmationRequired` 时，先在即梦 Web 端完成一次性授权确认再重试。
- 任务处理中用 `query_result --submit_id=` 查询，不要重复提交。
- 下载后先验证文件可读（存在、格式签名、非空大小）再报告成功；dry-run 不产生媒体资产。

## 排障

- 登录类错误先确认走的是 CLI 直连而非 CDP：CLI 登录态与网页登录态互相独立。
- 插件工具不可见：重启网关后重查工具枚举；**网关重启在当前 agent turn 结束后才落地**，turn 内轮询会误判未重启。
- 改 `src/*.js` 的生效判定、回退点核验、文档漂移自查见 `references/plugin-ops-discipline.md`。
- 日志：`~/.dreamina_cli/logs/dreamina.log*`；插件自检：`check:dreamina-cli-video`、`check:dreamina-cli-image`、`check:dreamina-model-specs`、`check`。

## 已验证事实索引

| 事实 | 日期 | 出处 |
|---|---|---|
| CLI 1.4.18 build ec1b9fa；480p 仅 2.5、其余仅 720p；upscale 2k/4k/8k | 2026-09-24 | `dreamina --help` 快照：`REN-12/evidence/20-cli-help/` |
| 69 工具名 + 69/69 参数名一致；契约面 17 ops、0 参数丢失 | 2026-09-24 | `REN-12/evidence/32/33/34-*.json` |
| 预算须按「估算 × 调用次数」预留；按一作业一估算会在第 3 次调用被拒并伪装成 `GENERATION_POLL_UNRESOLVED` | 2026-09-24 | `REN-12/runtime-budget-runbook.md` §5.1（本地替身实测，未调供应商） |
| 真机入口双钥匙（授权记录 + `--execute-live`）、默认分支 0 调用、替身被拒 | 2026-09-24 | `REN-12/evidence/93/entry-selftest-report.json`（28 项） |
| `.blob` 上传扩展名根因与修复 | 2026-09-20 | `docs/notes/plugin-seedance25-seedream5pro-verification-2026-09-20.md` |
| 画布门禁两处同源缺陷修复 | 2026-09-20 | `docs/notes/plugin-canvas-draft-output-gate-fix-2026-09-20.md`、`plugin-handoff-model-version-fix-2026-09-20.md` |
| 后端 version 白名单与探测法 | 2026-09-20 | `docs/notes/channel-notes-dreamina-cli-2026-09-19.md` |
| 付费链本地替身验收（59/36/33/48 项；真机未做） | 2026-09-24 | `REN-11/review-50-closure.md` |
