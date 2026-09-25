# New Project Quick Start

## One-command Usage
```powershell
pwsh -File .\projects\templates\create-video-project.ps1 -ProjectName <project-name>
```

## What it does
- 复制 `video-project-template/` 到 `projects/active/<project-name>/`
- 自动创建：
  - `assets/source-images/by-project/<project-name>/`
  - `assets/source-video/by-project/<project-name>/`
  - `assets/source-audio/by-project/<project-name>/`
- 自动把 `project.yaml` 里的占位符替换成项目名

## After Creation
1. 填 `project.yaml`
2. 填 `01-brief/brief.md`
3. 填 `04-specs/spec.md`
4. 在 `05-asset-map/assets-map.md` 登记素材映射
