# Naming Convention

## Standard Format
`<project-or-topic>__<type>__<subject>__<yyyymmdd>__v01.<ext>`

使用双下划线 `__` 分隔字段，便于解析和搜索。

## Field Definitions

| 字段 | 说明 | 示例 |
|------|------|------|
| `project-or-topic` | 项目名或主题 | `penguin-hotspot`, `brand-a-launch` |
| `type` | 素材类型 | `ref`, `srcimg`, `srcvideo`, `srcaudio`, `bundle` |
| `subject` | 内容主题 | `cute-motion`, `hero-frame`, `bgm-upbeat` |
| `yyyymmdd` | 日期 | `20260413` |
| `v01` | 版本号 | `v01`, `v02`, `v03` |

## Type Codes

| 代码 | 全称 | 用途 |
|------|------|------|
| `ref` | reference | 风格/参考 |
| `srcimg` | source-image | 原始图像 |
| `srcvideo` | source-video | 原始视频 |
| `srcaudio` | source-audio | 原始音频 |
| `bundle` | bundle | 素材包 |

## Examples

### References
- `penguin-hotspot__ref__cute-motion__20260413__v01.mp4`
- `brand-a-launch__ref__color-palette__20260413__v01.png`
- `virtual-idol__ref__character-design__20260413__v02.png`

### Source Images
- `penguin-hotspot__srcimg__hero-frame__20260413__v01.png`
- `brand-a-launch__srcimg__product-shot__20260413__v01.jpg`

### Source Video
- `penguin-hotspot__srcvideo__raw-clip-01__20260413__v01.mp4`
- `tutorial-series__srcvideo__screen-rec__20260413__v01.mp4`

### Source Audio
- `penguin-hotspot__srcaudio__voice-narration__20260413__v01.wav`
- `brand-a-launch__srcaudio__bgm-upbeat__20260413__v01.mp3`

### Bundles
- `penguin-hotspot__bundle__motion-refs__20260413__v01.zip`

## Quick Reference

### 参考类
- `__ref__` → `assets/references/`

### 生产类
- `__srcimg__` → `assets/source-images/`
- `__srcvideo__` → `assets/source-video/`
- `__srcaudio__` → `assets/source-audio/`

### 素材包
- `__bundle__` → `assets/bundles/`

## Tips
- 项目名使用小写英文或拼音加短横线
- 日期使用 `yyyymmdd` 格式
- 版本号从 `v01` 开始递增
- 同一素材的不同版本保持相同前缀

---

## 预处理图像命名规范（Preprocessed Images）

### 后缀规则

预处理后的图像自动添加标准后缀，**不改变原文件名主体**：

| 处理强度 | 后缀 | 示例 |
|---------|------|------|
| light | `_preprocessed_light` | `hanfu-girl__srcimg__design__20260417__v01_preprocessed_light.png` |
| standard | `_preprocessed_std` | `hanfu-girl__srcimg__design__20260417__v01_preprocessed_std.png` |
| strong | `_preprocessed_strong` | `hanfu-girl__srcimg__design__20260417__v01_preprocessed_strong.png` |
| extreme | `_preprocessed_extreme` | `hanfu-girl__srcimg__design__20260417__v01_preprocessed_extreme.png` |

### 命名逻辑

```
原始素材：<project>__srcimg__<subject>__<date>__<version>.<ext>
处理后素材：<project>__srcimg__<subject>__<date>__<version>_preprocessed_<strength>.<ext>
```

### 简化命名（非项目素材）

对于非项目特定的角色参考素材，可使用简化命名：

```
原始素材：<character-name>-<type>.<ext>
处理后素材：<character-name>-<type>_preprocessed_<strength>.<ext>
```

**示例**：
- `hanfu-girl-design.png` → `hanfu-girl-design_preprocessed_std.png`
- `modern-boy-expression.png` → `modern-boy-expression_preprocessed_std.png`

### 目录对应

| 命名模式 | 目录 |
|---------|------|
| `*__srcimg__*` （无预处理后缀） | `assets/source-images/characters/original/` |
| `*__srcimg__*_preprocessed_*` | `assets/source-images/characters/preprocessed/` |
| `*_preprocessed_*` （简化命名） | `assets/source-images/characters/preprocessed/` |

### 批量重命名示例

```powershell
# 检查预处理素材是否正确命名
Get-ChildItem -Path "assets/source-images/characters/preprocessed" -Filter "*.png" | Where-Object {
    $_.Name -notmatch "_preprocessed_(light|std|strong|extreme)"
} | ForEach-Object {
    Write-Warning "缺少标准后缀: $($_.Name)"
}
```

### 验证清单

- [ ] 后缀格式正确：`_preprocessed_<strength>`
- [ ] 强度值有效：`light` | `std` | `strong` | `extreme`
- [ ] 原始素材保留在 `original/` 目录
- [ ] 预处理素材存放在 `preprocessed/` 目录
- [ ] 两者文件名主体一致，仅后缀不同
