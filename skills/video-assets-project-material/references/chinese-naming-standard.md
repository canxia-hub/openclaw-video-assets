# 中文命名规范

## 核心要求

video-assets 插件 UI 可见名称默认使用中文。包括：

- 项目标题
- 资产标题
- entity canonical_name
- 注释标题
- 审计 message
- 暂存文件确认入库时的正式标题

允许保留英文的场景：

- asset_id、project_id、version_id、commit_id 等系统 ID
- 文件扩展名、MIME、codec、profile 等技术字段
- 外部平台或工具官方名称
- 原始来源不可翻译专名

## 项目标题

格式：

作品名或项目名 - 阶段或用途

示例：

- 咕咕嘎嘎短片 - 正式制作
- 月宫追逐镜头 - 样片验证
- 角色表情包 - 素材整理
- 中文空白验收项目

禁止：

- D4 Real Media Import Verification
- Phase B0 taxonomy live project
- Live Validation Project
- smoke / test / probe / validation 作为正式项目标题

## 资产标题

格式：

主类目 - 主体名 - 用途或版本说明

示例：

- 角色 - 咕咕嘎嘎 - 角色设计板
- 角色 - 咕咕嘎嘎 - 表情参考
- 场景 - 月宫外景 - 清晨氛围参考
- 服装 - 咕咕嘎嘎 - 初始登场服
- 装备 - 机械羽翼 - 展开状态设定
- 道具 - 银色钥匙 - 剧情关键道具
- 音频 - 咕咕嘎嘎 - 试配音第一版
- 风格参考 - 水墨暖光 - 色彩方向

## 文件名

文件名可以使用中文，但必须结构化、可排序、无空格。

推荐格式：

项目名__主类目__主体名__用途__YYYYMMDD__vNN.ext

示例：

- 咕咕嘎嘎短片__角色__咕咕嘎嘎__角色设计板__20260604__v01.png
- 月宫追逐镜头__场景__月宫外景__氛围参考__20260604__v01.jpg
- 咕咕嘎嘎短片__装备__机械羽翼__展开设定__20260604__v02.png
- 咕咕嘎嘎短片__音频__咕咕嘎嘎__试配音__20260604__v01.wav

文件名允许在必要时使用短英文技术后缀：

- proxy
- thumb
- clean
- mix
- export
- v01 / v02

## 版本命名

版本说明使用中文：

- 初始导入
- 调色修订
- 去背景版本
- 降噪版本
- 构图裁切版
- 交付压制版

禁止用无意义版本：

- final
- final2
- new
- test
- copy

## Entity 命名

entity_key 可用稳定 ASCII slug，canonical_name 必须中文。

示例：

- entity_key: char_gugu_gaga
- canonical_name: 咕咕嘎嘎
- entity_key: scene_moon_palace_exterior
- canonical_name: 月宫外景
- entity_key: gear_mechanical_wings
- canonical_name: 机械羽翼

## 审计消息

审计 message 使用中文，说明真实动作：

- 创建中文空白验收项目
- 导入角色设计板
- 确认暂存素材入库
- 归档旧版本
- 更新素材授权来源

避免：

- Created project
- Ingested staging file
- test upload
- live smoke

## 最低合格门

验收前，active UI 中不应出现英文测试标题。若必须保留历史记录，应移入 archive 或 cleanup backup，不放在 active 列表。
