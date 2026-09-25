# Assets Index

## Purpose
`assets/` 是工作区统一素材库,负责收纳参考、原始图像、原始视频、原始音频、下载待分拣内容与可复用素材包。

## Top-level Routing
- `references/`:初级参考素材(网络搜集、看方向用)
  - `characters/`:角色参考(网络搜集)
  - `style/`:风格参考
  - `scene/`:场景参考
  - `motion/`:动作参考
  - `competitor/`:竞品参考
- `source-images/`:生产素材(生成/精修后、进入生产用)
  - `characters/`:角色素材(生成/精修后)
  - `by-project/`:项目专属
  - `stock/`:通用图库
  - `extracted-frames/`:抽帧
- `source-video/`:生产视频
- `source-audio/`:生产音频
- `downloads/`:新下载素材入口
- `bundles/`:可复用素材包

## Output Directory (`output/`)
- `character-sheets/`:角色设计板
- `images/`:生成图像
- `videos/`:生成视频
- `audio/`:生成音频
- `projects/`:项目成果包

## Download / Search Intake
1. 新下载素材先进入 `downloads/inbox/`
2. 看完、命名、判断用途后移入对应正式目录
3. 暂时保留但已审过的放 `downloads/reviewed/`
4. 无效、侵权风险或废弃内容放 `downloads/rejected/`

## Naming Rule
推荐命名:`<project-or-topic>__<type>__<subject>__<yyyymmdd>__v01.<ext>`

示例:
- `penguin-hotspot__ref__cute-motion__20260413__v01.mp4`
- `brand-a-launch__srcimg__hero-frame__20260413__v02.png`

## Fast Classification Rule
- 用来"看方向"的,先归 `references/`
- 用来"直接生产"的,归 `source-images/`、`source-video/`、`source-audio/`
- 还没判断清楚的,留在 `downloads/inbox/`
- 能跨项目复用的,整理后升入 `bundles/reusable/`

---

## Character Assets Index

### 咕咕嘎嘎 (Gugu Gaga)
**参考素材路径**: `assets/references/characters/gugu-gaga/`
**生产素材路径**: `assets/source-images/characters/gugu-gaga/`
**创建日期**: 2026-04-14

**参考素材**（网络搜集，看方向用）:
| 文件 | 说明 |
|------|------|
| `gugu-gaga__ref__turnaround__20260414__v01.png` | 原始三视图（网络搜集） |

**生产素材**（生成/精修后，进入生产用）:
| 文件 | 说明 |
|------|------|
| `gugu-gaga__srcimg__character-sheet__20260414__v01.jpeg` | 角色设计板 21:9（生成） |

**角色特征**: 企鹅连体衣、蓝色眼睛、黑色短发、蓝色发夹、金属项圈

**标签**: `character` `q-version` `penguin-costume` `anime-style`
