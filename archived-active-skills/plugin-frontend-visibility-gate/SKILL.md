---
name: "plugin-frontend-visibility-gate"
description: "插件操作前端可见性门槛"
---

# Plugin Frontend Visibility Gate

## 使用时机

当任务涉及 video-assets、video-canvas、project-asset-manager、素材入库、项目引用、生成槽、生成输出、返修卡、批注或画布关系时使用本技能。

## 核心原则

1. 后端链路成功不等于完成。
2. 会影响生产、审片、复用或交付的操作，必须能在受保护 Workbench 画布工作台中被人类看见、找到或复核。
3. 标准前端入口是 `__openclaw__/video-assets/workbench/`；原生内嵌画布注册路线当前已否决。
4. 复杂视觉验收以桌面 Workbench 截图或 selection/view state 为主；窄屏只确认可进入和可读取数据。

## 必查对象

以下对象创建或更新后必须检查前端可见性：

- generation slot
- generated output
- revision card
- review annotation
- project ref
- canvas edge
- asset / asset version
- 项目检查器 warning / error

## 可见性标准

合格状态：

- 卡片有中文或人类可理解标题。
- 卡片靠近语义来源：输出靠近生成槽，返修卡靠近被审片对象，修订/替换输出靠近上一版。
- 关系边存在且语义正确。
- 人类能通过项目列表、画布、选择状态、检查器或截图找到结果。
- 报告同时包含后端证据和前端证据。

不合格状态：

- 卡片隐形、离群、过远、重叠或无标题。
- 只能靠裸 ID 找到。
- 资产入库成功但插件 UI / Workbench 中无法定位。
- 生成输出只有本地路径，没有资产 ID、项目引用或前端证据。
- 项目检查器 warning 没有中文解释或处理结论。

## 汇报字段

每次插件操作后补充：

- 后端结果：工具调用、资产 ID、版本 ID、项目引用、shape / edge。
- 前端结果：Workbench 是否可见、是否可选中、是否可通过关系追踪。
- 证据：截图、selection/view state、项目检查器或报告路径。
- 布局风险：是否离群、重叠、窄屏不可见。

## 完成标准

只有同时满足以下条件，才算插件操作完成：

1. 后端链路已验证。
2. 前端可见性已验证或有明确替代证据。
3. 关键对象能被人类在 Workbench 中正确看到和理解。
4. 若无法前端确认，必须报告为待补验收，不能伪装成完成。
