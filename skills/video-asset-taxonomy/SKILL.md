---
name: "video-asset-taxonomy"
description: "资产分类、实体、注释和项目引用的无前端验收"
---

# Video Asset Taxonomy

## 工作流

1. 读取资产和版本，按主体确认 taxonomy；角色、场景、服装、道具等关键对象建立可读中文标题和 entity link。
2. 注释记录来源、用途、连续性约束与禁用项；项目引用固定可追溯版本。tags 不替代主分类。
3. 调用 video_asset_get_classification、video_asset_annotations、video_project_refs 回读，再以 video_asset_taxonomy_report、video_project_continuity_report 和项目报告核对缺口。
4. 对 error 修复后回读；warning 逐项给出已处理、阶段性接受或待确认，不用界面徽标代替数据证据。
5. 生成测试样、返修和交付资产明确版本状态。来源授权不足保持 unknown，模型生成成功不自动 cleared。
6. 输出中文名称、资产/版本/实体/项目引用身份、分类、用途、风险与待补动作；关键判断附工具或文件证据。

## 边界

临时素材不必立即补齐全部分类；进入生成、项目引用、审片或交付时需说明缺口。通过 Agent 工具和文件验收，不要求浏览器、Workbench、Widget、内部画布或截图。即梦操作使用 video_dreamina_cli 或 video_dreamina_canvas_cli，官方资源身份与本地资产版本分开记录。

## 禁止项

- 仅以裸ID或文件名推测关键资产身份。
- 仅写注释而省略应有的实体关联或项目引用。
- 忽略会阻塞交付的授权、连续性或分类警告。
- 为清理列表物理删除原始素材，或把未知授权标为已清权。
