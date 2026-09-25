# Project Templates Index

## Available Templates
- `video-project-template/`：标准视频项目模板，适用于从研究、提示词、生成、复核到交付的完整制作链路

## Quick Start
- 脚本创建：`pwsh -File .\projects\templates\create-video-project.ps1 -ProjectName <project-name>`
- 说明入口：`projects/templates/NEW_PROJECT.md`

## Default Usage
1. 在 `projects/active/` 下创建新项目目录，例如：`projects/active/penguin-hotspot-validation/`
2. 将 `projects/templates/video-project-template/` 的结构复制到新项目目录，或直接运行创建脚本
3. 先填写 `project.yaml`、`01-brief/brief.md`、`04-specs/spec.md`
4. 素材统一放入 `assets/`，并在 `05-asset-map/assets-map.md` 记录映射关系
5. 项目完成后移入 `projects/archive/<project-name>/`

## Recommended Project Name
推荐使用小写英文或拼音加短横线，例如：
- `penguin-hotspot-validation`
- `brand-a-spring-launch`
- `virtual-idol-teaser-v1`
