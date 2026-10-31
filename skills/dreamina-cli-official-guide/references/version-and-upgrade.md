## 版本与升级

seedance2.5 需 **1.4.18（build ec1b9fa，2026-09-09）** 起；1.4.8（build 54f1bdf）只支持 2.0 家族。

本机已于 2026-10-12 升级到 **1.4.19（build 1d0bd17，2026-10-03）**：`query_result`/`list_task` 新增 `estimated_remaining_seconds` 耗时预估字段——**该预估值偏保守**（实测 multimodal2video 队列预估 13 分钟、实际约 6 分钟完成；家主口径：2.5/vip 模型通常比预估更快），只作数量级参考，不据此排程或判定卡死。旧版备份 `~/.dreamina_cli/backup/dreamina-1.4.18-20261012.exe`；新版二进制 sha256 `BC027B25299F80886CE8D719ED28C345A39C950404A5957A228C8C683ABAAB81`（31,941,632 字节）。升级复验：version + user_credit 正常，text2video/image2video/multimodal2video 三路径当日全部真机跑通。

升级流程（2026-09-19 已验证，2026-10-12 复用验证）：

1. 读元数据 `.../ljhwZthlaukjlkulzlp/version.json`。
2. 下载官方安装脚本 `https://jimeng.jianying.com/cli` 并先审查：它只做「下载二进制 → 替换 → 写 PATH → 同步 SKILL.md 与 version.json」。
3. 下载 `.../dreamina_cli_beta/dreamina_cli_windows_amd64.exe`，校验 sha256 后再装。
4. 替换前确认没有正在跑的生成：`Get-Process dreamina` 看清进程再决定；正在跑的任务被中断会影响该次产出（不代表已提交的任务会被重算）。**只针对要替换的二进制**，不要用笼统的「杀掉所有相关进程」做法。
5. 备份旧版到 `~/.dreamina_cli/backup/`，替换 `~/bin/dreamina.exe`，同步 `~/.dreamina_cli/version.json` 与 `~/.dreamina_cli/dreamina/SKILL.md`。
6. 复验 `dreamina version` 与 `dreamina user_credit`。

升级后首次 `user_credit` 可能返回全 0，属瞬态（同轮第二次调用恢复）；不要据此判定登录失效。
