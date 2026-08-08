# Taxonomy Controlled Vocabulary

状态：v1 草案  
用途：约束 `video-assets` 中资产分类字段，避免 tags 膨胀与生产错位。

## 1. Field Shape

推荐字段：

```yaml
domain: character | scene | costume | prop | audio | reference | prompt | document | delivery | other
type: controlled term
subtype: optional controlled term
confidence: confirmed | candidate | inferred
```

规范表示：

```text
<domain>.<type>[.<subtype>]
```

示例：

- `character.main.turnaround`
- `scene.interior.concept_art`
- `costume.formal.reference`
- `prop.hero.design`
- `audio.voice.dialogue`

## 2. Character

| Term | 含义 | 常见 subtype |
|---|---|---|
| `character.main` | 主角 | `portrait`, `turnaround`, `expression`, `pose`, `costume_ref` |
| `character.supporting` | 配角 | 同上 |
| `character.extra` | 群演/路人 | `crowd`, `background` |
| `character.creature` | 非人角色/动物/怪物 | `design`, `movement`, `texture` |
| `character.expression` | 表情素材 | `sheet`, `single`, `range` |
| `character.pose` | 姿势素材 | `action`, `idle`, `gesture` |
| `character.turnaround` | 三视图/转面 | `front_side_back`, `model_sheet` |

## 3. Scene

| Term | 含义 | 常见 subtype |
|---|---|---|
| `scene.exterior` | 外景 | `concept_art`, `plate`, `reference` |
| `scene.interior` | 内景 | `concept_art`, `set_design`, `lighting` |
| `scene.establishing` | 建立镜头场景 | `wide`, `aerial`, `location_anchor` |
| `scene.background` | 背景图/背景板 | `matte`, `loop`, `plate` |
| `scene.set_design` | 置景/空间设计 | `layout`, `props_layout`, `floor_plan` |
| `scene.vfx_environment` | 特效/抽象环境 | `portal`, `energy_field`, `dream_space` |

## 4. Costume

| Term | 含义 | 常见 subtype |
|---|---|---|
| `costume.daily` | 日常服 | `full_body`, `detail`, `fabric` |
| `costume.formal` | 礼服/正式服 | `ceremony`, `banquet`, `royal` |
| `costume.action` | 动作/战斗服 | `combat`, `travel`, `armor` |
| `costume.disguise` | 伪装/变装 | `identity_shift`, `stealth` |
| `costume.accessory` | 配饰 | `jewelry`, `hat`, `bag`, `symbol` |
| `costume.hair_makeup` | 发型妆造 | `hair`, `makeup`, `ornament` |

## 5. Prop

| Term | 含义 | 常见 subtype |
|---|---|---|
| `prop.hero` | 关键剧情道具 | `story_key`, `symbol`, `macguffin` |
| `prop.handheld` | 手持道具 | `tool`, `book`, `phone`, `cup` |
| `prop.set_dressing` | 置景道具 | `furniture`, `decoration`, `background` |
| `prop.vehicle` | 载具 | `car`, `boat`, `airship`, `mount` |
| `prop.weapon` | 武器 | `sword`, `gun`, `magic_weapon` |
| `prop.interface` | 屏幕/UI/设备界面 | `screen`, `hologram`, `control_panel` |

## 6. Audio

| Term | 含义 | 常见 subtype |
|---|---|---|
| `audio.voice` | 人声 | `dialogue`, `narration`, `temp`, `final` |
| `audio.music` | 配乐/BGM | `theme`, `underscore`, `stinger`, `temp_track` |
| `audio.sfx` | 音效 | `impact`, `ui`, `foley`, `magic` |
| `audio.ambience` | 环境声 | `roomtone`, `city`, `nature`, `crowd` |

## 7. Reference

| Term | 含义 | 常见 subtype |
|---|---|---|
| `reference.style` | 风格参考 | `color`, `lighting`, `render`, `composition` |
| `reference.motion` | 动作/运镜参考 | `camera`, `performance`, `timing` |
| `reference.competitor` | 竞品/平台样本 | `hotspot`, `format`, `editing` |
| `reference.material` | 材质/纹理参考 | `fabric`, `metal`, `skin`, `stone` |

## 8. Prompt / Document / Delivery

- `prompt.image`
- `prompt.video`
- `prompt.audio`
- `document.spec`
- `document.script`
- `document.storyboard`
- `delivery.preview`
- `delivery.final`
- `delivery.platform_export`

## 9. Confidence Rules

| confidence | 使用场景 | 是否可交付 |
|---|---|---|
| `confirmed` | 人类/上游明确确认 | 可进入正式链路 |
| `candidate` | 候选/待选 | 不可作为最终关键资产 |
| `inferred` | Agent 根据文件名/上下文推断 | 仅可用于检索，不可作为关键生产事实 |

关键角色/场景/服装/道具进入交付前必须为 `confirmed`。
