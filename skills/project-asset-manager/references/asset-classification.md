# Asset Classification Spec

## 1. Classification Goal
保证"先下载再分拣"与"先搜集再归档"都能快速落位,减少素材散落、命名混乱与后续找不到的问题。

## 2. Folder Taxonomy

### 2.1 `downloads/`
- `inbox/`:所有新下载、新抓取、新找到的素材第一落点
- `reviewed/`:已看过但暂不投入生产、仍需保留的候选素材
- `rejected/`:确认无用、质量过低、重复、风险高的素材

### 2.2 `references/` - 初级参考素材(网络搜集、看方向用)
- `characters/`:角色参考图、三视图、设定图(网络搜集的原始素材)
- `style/`:视觉风格、配色、光影、质感参考
- `scene/`:场景、空间、置景参考
- `motion/`:动作、运镜、节奏、表演参考
- `competitor/`:竞品、平台爆款、拆解样本

**用途定义**:
- 存放网络搜集来的初级参考素材
- 用于"看方向"、研究、风格判断
- 未经过修改或挑选

### 2.3 `source-images/` - 生产素材(处理后/新生成、进入生产用)
- `characters/`:角色、三视图、表情参考(经过生成/精修/挑选的高质量素材)
  - `characters/original/`:原始高质量角色素材(未经预处理)
  - `characters/preprocessed/`:预处理后的角色素材(用于 Seedance 生成)
- `by-project/`:已明确属于某项目的图片源
- `stock/`:通用图库、贴图、背景、PNG 等
- `extracted-frames/`:从视频中抽出的关键帧与镜头分析图

**用途定义**:
- 存放最终经过修改、挑选、新生成的素材
- 准备进入视频生成生产端
- 质量已验证、可直接使用

### 2.4 `source-video/`
- `by-project/`:已明确归属某项目的视频源
- `raw-clips/`:原始片段、拍摄源、下载源视频
- `screen-recordings/`:网页录屏、界面录屏、流程录屏

### 2.5 `source-audio/`
- `by-project/`:已明确归属某项目的音频源
- `voice/`:人声、配音、对白原始文件
- `music/`:BGM、配乐、节奏参考
- `sfx/`:音效、环境声、拟音

### 2.6 `bundles/`
- `reusable/`:跨项目可复用素材包
- `project-specific/`:特定项目打包的素材组合

## 3. Intake Workflow
1. 搜索/下载完成后,统一进入 `downloads/inbox/`
2. 进行初筛:是否可用、是否合规、是否需要长期保存
3. 重命名并按用途移动到正式目录
4. 在项目侧把使用到的素材登记到 `projects/.../05-asset-map/assets-map.md`
5. 若沉淀为高复用资产,再升到 `bundles/reusable/`

## 4. Decision Rules

### 核心区分:reference vs source

| 目录 | 用途 | 内容来源 | 是否进入生产 |
|------|------|----------|-------------|
| `references/` | 看方向、研究 | 网络搜集 | ❌ 否 |
| `source-*/` | 直接生产 | 生成/精修/挑选 | ✅ 是 |

### 详细规则

- **网络搜集的初级参考素材** → 归 `references/`
  - 角色参考图、风格参考、场景参考等
  - 用于研究方向、风格判断
  - 未经过修改或挑选

- **生成/精修/挑选后的高质量素材** → 归 `source-*/`
  - 角色设计板、高质量参考图等
  - 准备进入视频生成生产端
  - 质量已验证、可直接使用

- **尚未决定用途** → 留 `downloads/inbox/`

- **项目闭环后仍值得复用** → 升 `bundles/reusable/`

- **仅当前项目会用** → 放 `bundles/project-specific/` 或对应 `by-project/`

## 5. By-project Convention
如果素材明确服务某个项目,建议建立:
- `assets/source-images/by-project/<project-name>/`
- `assets/source-video/by-project/<project-name>/`
- `assets/source-audio/by-project/<project-name>/`

## 6. Minimum Metadata
每份高价值素材至少要能回答:
- 从哪来
- 为什么留
- 准备用在哪个项目
- 是否有版权/平台风险

## 7. Cleanup Rule
- `downloads/inbox/` 不长期堆积，阶段结束前清空或转移
- `downloads/rejected/` 可周期性清理
- 已完成项目的专属素材，按需要转 `bundles/project-specific/` 或归档说明中登记

---

## 8. 预处理图像规范（Preprocessed Images）

### 8.1 后缀规则

通过 `image_preprocessor.py` 处理的图像会自动添加标准后缀：

| 处理强度 | 后缀 | 示例 |
|---------|------|------|
| light | `_preprocessed_light` | `character_preprocessed_light.png` |
| standard | `_preprocessed_std` | `character_preprocessed_std.png` |
| strong | `_preprocessed_strong` | `character_preprocessed_strong.png` |
| extreme | `_preprocessed_extreme` | `character_preprocessed_extreme.png` |

### 8.2 落位规则

**原始素材 → 预处理后素材**：

```
assets/source-images/characters/original/
├── hanfu-girl-design.png          # 原始角色设计板
└── hanfu-girl-expression.png      # 原始表情参考

处理后 ↓

assets/source-images/characters/preprocessed/
├── hanfu-girl-design_preprocessed_std.png      # 标准预处理
└── hanfu-girl-expression_preprocessed_std.png  # 标准预处理
```

### 8.3 目录结构

```
assets/source-images/characters/
├── original/           # 原始高质量角色素材（未经预处理）
│   ├── hanfu-girl/
│   │   ├── design-board.png
│   │   ├── expression-sheet.png
│   │   └── three-view.png
│   └── modern-boy/
│       └── character-ref.png
│
└── preprocessed/       # 预处理后的角色素材（用于 Seedance 生成）
    ├── hanfu-girl/
    │   ├── design-board_preprocessed_std.png
    │   ├── expression-sheet_preprocessed_std.png
    │   └── three-view_preprocessed_std.png
    └── modern-boy/
        └── character-ref_preprocessed_std.png
```

### 8.4 命名规范

**推荐命名格式**：

```
<角色名>-<素材类型>_preprocessed_<强度>.<扩展名>
```

**示例**：
- `hanfu-girl-design_preprocessed_std.png`
- `hanfu-girl-expression_preprocessed_std.png`
- `modern-boy-ref_preprocessed_strong.png`

### 8.5 处理工作流

```
原始素材（original/）
    ↓
判断是否需要预处理
    ├─ 角色设计板/三视图 → 需要预处理
    ├─ 背景参考 → 无需预处理
    ├─ 分镜参考 → 无需预处理
    └─ 场景参考 → 无需预处理
    ↓
运行 image_preprocessor.py
    ↓
输出到 preprocessed/ 目录
    ↓
在项目中使用预处理后的素材
```

### 8.6 批量处理脚本示例

```powershell
# 批量预处理目录下所有角色素材
Get-ChildItem -Path "assets/source-images/characters/original/hanfu-girl" -Filter "*.png" | ForEach-Object {
    python skills/seedance-video-prompting/scripts/image_preprocessor.py $_.FullName --strength standard --output "assets/source-images/characters/preprocessed/hanfu-girl/"
}
```

### 8.7 素材映射表

在项目素材映射表（`assets-map.md`）中，应同时记录原始素材和预处理后素材的关系：

```markdown
## 角色参考

| 素材名 | 原始路径 | 预处理路径 | 处理强度 | 用途 |
|--------|---------|-----------|---------|------|
| 汉服少女设计板 | original/hanfu-girl/design-board.png | preprocessed/hanfu-girl/design-board_preprocessed_std.png | standard | 角色身份锚定 |
| 汉服少女表情 | original/hanfu-girl/expression-sheet.png | preprocessed/hanfu-girl/expression-sheet_preprocessed_std.png | standard | 表情参考 |
```

### 8.8 清理规则

- **原始素材**：保留，不删除
- **预处理素材**：可重新生成，不作为唯一备份
- 如果原始素材丢失，预处理素材无法逆向恢复
- 项目归档时，同时保留原始和预处理版本

### 8.9 质量检查清单

预处理完成后检查：
- [ ] 后缀正确（`_preprocessed_<强度>`）
- [ ] 输出到正确的 `preprocessed/` 子目录
- [ ] 原始素材未被覆盖或删除
- [ ] 在素材映射表中记录两者关系
- [ ] 文件可正常打开和读取

---

## 9. 图像生成参考素材规范 (Image Generation Reference Materials)

### 9.0 用途定义

本目录专用于存放图像生成任务中通过搜索/下载获取的**参考素材**。
这些素材用于提升图像生成质量（多模态参考输入），不同于 "看方向用" 的 `references/` 初级参考。

**核心原则**：
> 每次搜索拉取的素材必须有固定落位，能被轻松找到和管理。

### 9.1 目录结构

```
assets/references/image-gen-refs/
├── INDEX.md                # 索引：记录每次下载的素材清单
├── ip-characters/          # IP 角色参考（动漫/游戏/电影角色官方图、同人图、设定图）
├── real-people/            # 真实人物参考（人物照片、特写、全身照）
├── architecture-landmarks/ # 建筑/地标参考（建筑物、景点、城市景观）
├── products-brands/        # 品牌产品参考（产品图、包装、logo参考）
├── art-styles/             # 艺术风格参考（特定画风、渲染风格示例）
├── poses-compositions/     # 姿势/构图参考（动作参考、构图模板）
├── outfits-costumes/       # 服装/造型参考（服装设计、配饰参考）
└── textures-materials/     # 材质/纹理参考（布料、金属、木材等材质样本）
```

### 9.2 命名规范

**格式**：
```
<category>__<search-keyword>__<yyyymmdd>__<seq>.<ext>
```

**字段说明**：
| 字段 | 说明 | 示例 |
|------|------|------|
| category | 分类简码 | `ip-char`, `real-person`, `arch`, `product`, `art-style`, `pose`, `outfit`, `texture` |
| search-keyword | 搜索关键词（kebab-case） | `tanjiro-demon-slayer` |
| yyyymmdd | 下载日期 | `20260501` |
| seq | 序号（01-99） | `01` |

**命名示例**：
```
ip-char__tanjiro-demon-slayer__20260501__01.png
ip-char__miku-hatsune__20260501__02.png
real-person__caucasian-male-portrait__20260501__01.jpg
arch__tokyo-tower__20260501__01.png
product__apple-iphone-16__20260501__01.jpg
art-style__ukiyo-e-woodblock__20260501__01.png
pose__action-flying-kick__20260501__01.jpg
outfit__victorian-gothic-dress__20260501__01.png
texture__silk-fabric-closeup__20260501__01.jpg
```

### 9.3 Intake 流程（图像生成参考素材专用）

```
1. 搜索参考素材（quick-web-search / browser）
       ↓
2. 下载到 downloads/inbox/（暂存）
       ↓
3. 立即重命名并移动到 image-gen-refs/ 对应子目录
       ↓
4. 更新 INDEX.md 记录
       ↓
5. 在 prompt 中作为 input_image 传入（图生图模式）
       ↓
6. 任务完成后，在项目 assets-map.md 中登记引用
```

**关键规则**：
- ❌ 禁止直接在 `downloads/inbox/` 中使用而不归位
- ❌ 禁止散落到 output/、临时目录或桌面
- ✅ 每次下载后立即执行步骤 3-4
- ✅ 同一任务的所有参考素材用同一个日期和递增序号

### 9.4 INDEX.md 格式

每次下载参考素材后，在 `INDEX.md` 中追加记录：

```markdown
## 下载记录

| 日期 | 任务 | 分类 | 文件名 | 来源 URL | 用途 |
|------|------|------|--------|----------|------|
| 2026-05-01 | 某角色生成 | ip-char | ip-char__tanjiro__20260501__01.png | https://example.com/ref1 | 服装参考 |
| 2026-05-01 | 某角色生成 | ip-char | ip-char__tanjiro__20260501__02.png | https://example.com/ref2 | 表情参考 |
| 2026-05-01 | 某角色生成 | pose | pose__sword-stance__20260501__01.jpg | https://example.com/ref3 | 姿势参考 |
```

### 9.5 搜索到归位的完整操作步骤

**Agent 执行流程**：

```powershell
# 步骤 1: 搜索参考图像
# → 使用 quick-web-search 或 browser 工具获取图像 URL

# 步骤 2: 下载到 inbox（暂存）
pwsh -Command "Invoke-WebRequest -Uri '<image-url>' -OutFile 'assets/downloads/inbox/temp_ref_01.png'"

# 步骤 3: 重命名并移动到正式目录
# 格式: <category>__<search-keyword>__<yyyymmdd>__<seq>.<ext>
Move-Item "assets/downloads/inbox/temp_ref_01.png" `
  "assets/references/image-gen-refs/ip-characters/ip-char__tanjiro-demon-slayer__20260501__01.png"

# 步骤 4: 更新 INDEX.md
# → 追加下载记录行

# 步骤 5: 传入 API 生成
# → 在 prompt 中引用 image-gen-refs/ 中的素材
```

### 9.6 分类决策表

| 素材类型 | 落位目录 | category 简码 |
|---------|---------|--------------|
| 动漫/游戏/电影 IP 角色参考图 | `ip-characters/` | `ip-char` |
| 真实人物照片/特写 | `real-people/` | `real-person` |
| 建筑/地标/城市景观 | `architecture-landmarks/` | `arch` |
| 品牌产品/包装/logo | `products-brands/` | `product` |
| 特定画风/渲染风格示例 | `art-styles/` | `art-style` |
| 动作姿势/构图参考 | `poses-compositions/` | `pose` |
| 服装设计/造型参考 | `outfits-costumes/` | `outfit` |
| 布料/金属/木材等材质 | `textures-materials/` | `texture` |

### 9.7 清理规则

- **短期任务（单次生成）**：任务完成后，保留 7 天，之后可移入对应 `references/` 子目录或删除
- **项目关联**：如绑定到项目，在项目 `assets-map.md` 中记录引用后，素材永久保留
- **高复用素材**：整理后升入 `bundles/reusable/`
- **INDEX.md** 必须与目录内容保持同步

### 9.8 与 references/ 现有目录的关系

| 目录 | 用途 | 生命周期 |
|------|------|---------|
| `references/characters/` 等 | 看方向、研究、长期积累 | 长期 |
| `references/image-gen-refs/` | 图像生成任务参考输入 | 任务级 → 短期或项目级 |

**转换规则**：
- `image-gen-refs/` 中经确认有长期复用价值的素材 → 移入对应 `references/` 子目录
- 仅服务于单次生成任务的素材 → 任务完成后清理

### 9.9 质量检查清单

- [ ] 素材下载后立即从 inbox 归位到 image-gen-refs/
- [ ] 命名符合 `<category>__<keyword>__<date>__<seq>` 格式
- [ ] INDEX.md 已更新
- [ ] 素材来源 URL 已记录
- [ ] 项目 assets-map.md 已登记（如适用）
