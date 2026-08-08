# Annotation Templates

状态：v1 草案  
用途：给资产、版本、实体、项目引用写结构化注释，避免自由文本遗漏关键信息。

## 1. Character Profile

绑定建议：`entity` 为主，具体画面事实可绑定 `asset_version`。

```yaml
annotation_type: character_profile
title: "角色设定：<角色名>"
structured:
  canonical_name:
  aliases: []
  story_role:
  personality:
  appearance_anchors:
    face:
    hair:
    body_shape:
    color_palette:
    signature_elements: []
  performance_notes:
  do_not_change: []
  related_costumes: []
body: |
  角色的详细信息描述，包括身份、情绪基调、表演方式、视觉锚点和禁止改动项。
```

## 2. Scene Concept

绑定建议：`entity` 或 `asset_version`。

```yaml
annotation_type: scene_concept
title: "场景概念：<场景名>"
structured:
  scene_key:
  location_type: interior | exterior | abstract | set
  time_of_day:
  mood:
  lighting:
  color_palette:
  spatial_layout:
  continuity_anchors: []
  forbidden_uses: []
body: |
  场景的设计概念、空间结构、光影氛围、叙事功能和不能混用的边界。
```

## 3. Costume Spec

绑定建议：`entity`，并链接所属 character entity。

```yaml
annotation_type: costume_spec
title: "服装设定：<服装名>"
structured:
  costume_name:
  owner_character_key:
  silhouette:
  colors:
  materials:
  accessories: []
  valid_scenes: []
  invalid_scenes: []
  continuity_constraints: []
body: |
  服装的所属角色、材质、颜色、结构、适用剧情段落和连续性禁改项。
```

## 4. Prop Function

绑定建议：`entity` 或具体 `asset_version`。

```yaml
annotation_type: prop_function
title: "道具功能：<道具名>"
structured:
  prop_name:
  prop_type: hero | handheld | set_dressing | vehicle | weapon | interface
  story_significance:
  owner_or_user:
  interaction_notes:
  continuity_anchors: []
  safety_or_license_notes:
body: |
  道具的功能、剧情意义、归属、交互方式、出现限制。
```

## 5. Visual Continuity

绑定建议：`asset_version` 或 `project_ref`。

```yaml
annotation_type: visual_continuity
title: "连续性约束：<对象名/镜头>"
structured:
  entity_key:
  must_match: []
  can_vary: []
  cannot_mix_with: []
  applies_to_shots: []
body: |
  本资产在项目中必须保持一致的视觉元素，以及允许变化的范围。
```

## 6. Source Rights

绑定建议：`asset`。

```yaml
annotation_type: source_rights
title: "来源与授权：<资产名>"
structured:
  source_type:
  source_url:
  original_author:
  license_status: unknown | cleared | restricted | internal_only | rejected
  allowed_uses: []
  forbidden_uses: []
  evidence:
body: |
  来源、授权线索、可用范围、风险说明。默认 unknown，不得自动视作 cleared。
```

## 7. Production Note

绑定建议：`asset` 或 `project_ref`。

```yaml
annotation_type: production_note
title: "制作备注：<资产名>"
structured:
  usable_for: []
  not_usable_for: []
  quality_notes:
  pipeline_notes:
  next_action:
body: |
  制作侧使用说明、局限、推荐处理路径与下一步动作。
```

## 8. Review Note

绑定建议：`asset_version` 或 `project_ref`。

```yaml
annotation_type: review_note
title: "审核意见：<版本/引用>"
structured:
  verdict: pass | revise | reject | hold
  issues: []
  required_changes: []
  reviewer:
body: |
  审核结论、问题、返修要求和责任归口。
```

## 9. Prompt Note

绑定建议：`asset_version`。

```yaml
annotation_type: prompt_note
title: "生成记录：<资产名>"
structured:
  model:
  prompt_summary:
  negative_prompt_summary:
  parameters:
  source_versions: []
  seed_or_task_id:
body: |
  生成提示词、模型、参数和上游资产摘要。敏感凭据不得写入。
```

## 10. Status Rules

- 新注释默认 `active`。
- 过期注释标 `superseded`，不要删除。
- 审核问题解决后标 `resolved`。
- 项目归档后可标 `archived`。
