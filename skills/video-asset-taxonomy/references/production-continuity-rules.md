# Production Continuity Rules

状态：v1 草案  
用途：防止资产分类、注释、项目引用在生产过程中发生信息错位。

## 1. Non-Negotiable Rules

1. 关键项目引用必须最终锁定 `asset_version_id`。
2. 角色/场景/服装/道具关键资产必须有 `entity_key`。
3. `candidate` 与 `inferred` 不能作为最终交付关键事实。
4. 视觉事实类注释必须优先绑定 `asset_version`，不要只绑定 `asset`。
5. 设定真相类注释必须绑定 `entity`，避免同角色多素材重复写散。
6. 过期注释不能删除，只能 `superseded`。

## 2. Gate by Production Stage

### Research / Reference

允许：

- taxonomy confidence = `candidate` 或 `inferred`
- entity link 缺失但必须标记待确认
- license unknown

不允许：

- 直接标为生产 confirmed
- 混入 source/working 而无来源说明

### Production / Generation

要求：

- 关键资产 taxonomy 已存在。
- 角色/场景/服装/道具 entity link 至少 candidate。
- 使用前明确引用 asset_version。
- 生产备注说明可用范围。

### Review

要求：

- 关键资产 entity link 必须 confirmed。
- 角色/服装/道具连续性有 visual_continuity 注释。
- review_note 记录 pass/revise/reject。

### Delivery

要求：

- 所有关键 ref `pin_mode=pinned`。
- project report 无 error。
- warnings 已处理或有人工豁免记录。
- license_status 不得为 rejected；unknown/restricted 需明确风险说明。

## 3. Conflict Patterns

### Character Conflict

同一项目里出现：

- 同一 `entity_key` 链接两个外貌明显冲突的版本。
- 不同角色 entity 使用相同资产版本。
- 服装 `owner_character_key` 与项目引用角色不一致。

处理：

- 生成 `visual_continuity` 或 `review_note`。
- 未解决前 report warning/error。

### Scene Conflict

同一场景出现：

- interior/exterior 分类冲突。
- 时间/光影设定冲突。
- 场景设计概念与项目镜头 usage_scope 不一致。

处理：

- 确认 scene entity。
- 按 shot/scene scope 写 project_ref 注释。

### Prop Conflict

关键道具出现：

- function 注释缺失。
- owner/user 冲突。
- hero prop 被当 set dressing 使用。

处理：

- 补 prop_function。
- 若剧情关键，交付前必须 confirmed。

## 4. Report Severity Recommendation

| 情况 | Severity |
|---|---|
| required ref 缺失 asset/version/object | error |
| required key asset 缺 taxonomy | error |
| required key asset entity link 缺失 | error |
| required key asset annotation 缺失 | warning，可按项目阶段升级 error |
| candidate/inferred 进入 delivery | error |
| license unknown | warning，正式商用前升级 error |
| optional ref 缺信息 | info |

## 5. Human/Agent Handoff Checklist

资产进入项目时：

- [ ] asset_id / asset_version_id 明确
- [ ] taxonomy 明确
- [ ] entity_key 明确或说明为何不需要
- [ ] 必要注释存在
- [ ] license/source 状态明确
- [ ] project_ref role 与 asset taxonomy 不冲突
- [ ] pin_mode 符合当前阶段

交付前：

- [ ] 无 candidate 关键资产
- [ ] 无 inferred 关键分类
- [ ] 无缺失 entity link 的角色/场景/道具/服装
- [ ] 无未处理 review_note
- [ ] 无 error 级 project/taxonomy report
