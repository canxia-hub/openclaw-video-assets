# Project Lifecycle

## Stages

### 1. Planning (规划)
- 创建项目目录于 `projects/active/<project-name>/`
- 填写 `project.yaml`、`01-brief/brief.md`、`04-specs/spec.md`
- 在 `05-asset-map/assets-map.md` 建立素材映射
- **必须创建项目索引**：在 `05-asset-map/assets-map.md` 中登记所有使用的素材

### 2. Production (制作)
- 素材进入 `assets/source-*/by-project/<project-name>/`
- 在 `07-production/production-log.md` 记录生产过程
- 提示词迭代记录于 `06-prompts/prompt-log.md`
- **更新项目索引**：每次使用新素材时必须更新索引

### 3. Review (验收)
- 模型复核记录于 `08-review/review.md`
- 人工验收结论记录
- 问题清单与修复记录

### 4. Delivery (交付)
- 交付说明写入 `09-delivery/delivery.md`
- 导出文件放入 `output/<project-name>/`
- 版本状态标注 (test / preview / deliverable)

### 5. Archive (归档)
- 项目移入 `projects/archive/<project-name>/`
- 可复用素材升入 `assets/bundles/reusable/`
- 经验沉淀到 `99-archive/` 或记忆系统

## Project Index Requirement (项目索引要求)

每个项目必须在 `05-asset-map/assets-map.md` 中维护完整的素材索引：

### 索引内容
1. **素材路径**：完整的文件路径
2. **素材类型**：reference / source-image / source-video / source-audio
3. **使用阶段**：brief / research / storyboard / production / delivery
4. **来源**：网络搜集 / 生成 / 精修 / 项目内创建
5. **风险标注**：版权风险 / 平台风险 / 无风险

### 索引更新时机
- 项目启动时：初始化索引
- 每次添加素材时：立即更新索引
- 项目归档前：最终确认索引完整性

### 索引格式
```markdown
# 项目素材索引

## 项目信息
- 项目名称：
- 创建日期：
- 状态：

## 素材清单

### 参考素材 (references/)
| 用途 | 文件路径 | 来源 | 使用阶段 | 风险标注 |
|------|----------|------|----------|----------|

### 生产素材 (source-*/)
| 用途 | 文件路径 | 来源 | 使用阶段 | 风险标注 |
|------|----------|------|----------|----------|

### 成果输出 (output/)
| 用途 | 文件路径 | 来源 | 使用阶段 | 风险标注 |
|------|----------|------|----------|----------|

## 素材统计
- 参考素材数量：
- 生产素材数量：
- 成果输出数量：
```

## Archive Checklist
- [ ] 所有交付文件已确认
- [ ] 项目文档完整
- [ ] 素材映射已更新
- [ ] 可复用资产已提取
- [ ] 项目状态更新为 `archived`

## Move Command
```powershell
# 手动归档示例
Move-Item "projects\active\<project-name>" "projects\archive\<project-name>"
```
