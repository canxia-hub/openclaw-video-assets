# video-assets 0.4 · Agent-only CLI

无前端的视频项目资产后端。两个 CLI 是独立的可执行文件／认证／命令空间；工具不需要旧内部画布 ID，不打开浏览器，也不提供 Workbench、Widget 或 HTTP 路由。

## 运行工具

- `video_dreamina_cli` → 已安装的 `dreamina.exe`：积分、会话、任务、图像／视频／放大。
- `video_dreamina_canvas_cli` → 已安装的 `dreamina-canvas.exe`：schema、模型、音色、认证、官方云画布／节点／资源与恢复。
- 38 个既有非画布工具继续处理资产、项目、版本、来源授权、分类、实体、批注、音频和小说。
- 旧 `video_canvas_*`、画布合并工具、Widget 及内部画布 RPC 已退出运行面，没有失效别名。

## 使用

默认 `execute=false` 返回零 I/O 计划。只读检查：

```json
{"command":"version","execute":true}
```

官方 CLI 能力发现：

```json
{"command":"schema","execute":true}
```

不写服务端的官方 CLI 本地校验：

```json
{"command":"node create text","argv":["--title","本地校验","--text","仅本地校验","--dry-run"],"execute":true}
```

Legacy CLI 参数采用原下划线拼写；官方画布 CLI 参数采用当前 schema 的规范拼写。argv 是逐项 token，不是 shell 命令；可执行路径只能由可信插件配置指定。进程使用 execFile、shell=false，清空进程内代理并限制输出和超时。

每次官方命令执行前会刷新已安装二进制的 schema。不会拼接私有 HTTP 接口、复制登录凭据，或把旧 canvas_id 伪装成官方 projectId。

## 写操作、付费与恢复

- CLI 写操作需要宿主可信身份、`execute=true` 和稳定 `operation_key`；默认计划不会建单、写草稿或调用 CLI。
- 删除、登出另需 `confirm_destructive=true`。
- 付费生成及积分批准需要 `accept_credit_spend=true`；此字段不代替服务端积分批准或插件预算。
- Legacy 生成强制异步 `--poll=0`，先查 user_credit，之后用同一 submit_id 查询结果。
- 官方付费调用要求显式稳定 `--submit-id`；官方 credit-token／credit-ceiling 规则仍生效。
- 插件付费门使用 `dreamina.cli.execute` 与 `dreamina.canvas.execute` 两个独立成本入口。成本须依据实际报价配置到 `security.generation.budget.estimates`；缺失时拒绝，不按历史型号价格猜测，也不自动扩大预算。
- 写操作在 SQLite `cli_bridge_operations` 原子记录 actor、命令、请求哈希、状态与公开恢复身份；不存提示词、argv、认证 token 或签名链接。相同键重入不会重复提交，参数不同会冲突。
- 超时或进程崩溃后的结果不确定，不以新 key 自动重提；查询同一 submitId／operationRef／已保存任务历史。
- “submitted”只是已提交，须查询资源终态并检查产物，才可声称生成完成。

产物按需下载，继续使用 `video_asset_ingest`、分类／版权工具和 `video_project_add_asset_ref`。权利默认 unknown；不因 CLI 成功就自动 cleared。

## 配置

```json
{
  "cli": {
    "dreaminaPath": "<trusted-local-path-to-dreamina>",
    "canvasPath": "<trusted-local-path-to-dreamina-canvas>"
  },
  "toolSurface": "agent"
}
```

省略路径时使用用户 bin 目录。不要把凭据写进配置示例或仓库。迁移时删除已退役的 auth、canvas、basePath 以及 security 中的浏览器字段；保留 security.generation、业务配置、素材路径和现有预算。旧内部画布表及素材数据不删除。

## 契约与检查

源契约：src/tool-specs.js、src/cli-tools.js、src/narrative-contract.js；脚本 scripts/generate-agent-contract.mjs 生成工具清单和 contract/agent-tools.generated.json。通过 `--check` 检测漂移，不维护第二套手写名字表。

```
npm run check
node scripts/cli-live-smoke.mjs
npm pack --dry-run --json
```

live smoke 只调用版本、认证状态与官方本地 dry-run，无付费提交、云写入或前端要求。常规回归使用隔离临时资产库与零成本适配器，不写生产素材。

## 历史归档

完整内部画布／Workbench 源码、部署快照及旧专用技能：
[legacy-full-20261031-exact](https://github.com/canxia-hub/openclaw-video-assets/tree/legacy-full-20261031-exact)。

归档代码不随当前生产包安装。数据库、媒体、私有配置和凭据不在公开归档中。
