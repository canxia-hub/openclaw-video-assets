#!/usr/bin/env pwsh
# Move-AssetToImageGenRefs.ps1
# 将 inbox 中的参考素材快速归位到 image-gen-refs/ 目录
# 用法: .\Move-AssetToImageGenRefs.ps1 -SourceInbox "assets/downloads/inbox/temp_ref_01.png" -Category "ip-char" -Keyword "tanjiro-demon-slayer"

param(
    [Parameter(Mandatory=$true)]
    [string]$SourceFile,

    [Parameter(Mandatory=$true)]
    [ValidateSet("ip-char","real-person","arch","product","art-style","pose","outfit","texture")]
    [string]$Category,

    [Parameter(Mandatory=$true)]
    [string]$Keyword,

    [string]$Date = (Get-Date -Format "yyyyMMdd")
)

$CategoryDirMap = @{
    "ip-char"      = "ip-characters"
    "real-person"  = "real-people"
    "arch"         = "architecture-landmarks"
    "product"      = "products-brands"
    "art-style"    = "art-styles"
    "pose"         = "poses-compositions"
    "outfit"       = "outfits-costumes"
    "texture"      = "textures-materials"
}

$WorkspaceRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$AssetsRoot = Join-Path $WorkspaceRoot "assets"
$TargetDir = Join-Path $AssetsRoot "references\image-gen-refs\$($CategoryDirMap[$Category])"
$IndexFile = Join-Path $AssetsRoot "references\image-gen-refs\INDEX.md"

# 确保目标目录存在
if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

# 获取文件扩展名
$ext = [System.IO.Path]::GetExtension($SourceFile)
if ([string]::IsNullOrEmpty($ext)) { $ext = ".png" }

# 计算序号
$existingFiles = Get-ChildItem -Path $TargetDir -Filter "$Category`__$Keyword`__$Date`__*" -ErrorAction SilentlyContinue
$seq = ($existingFiles.Count + 1).ToString("D2")

# 生成目标文件名
$targetFileName = "$Category`__$Keyword`__$Date`__$seq$ext"
$targetPath = Join-Path $TargetDir $targetFileName

# 移动文件
Move-Item -Path $SourceFile -Destination $targetPath -Force
Write-Host "[OK] $SourceFile" -ForegroundColor Gray
Write-Host "  → $targetPath" -ForegroundColor Green

# 输出 INDEX.md 追加行
Write-Host ""
Write-Host "=== APPEND TO INDEX.md ===" -ForegroundColor Yellow
Write-Host "| $Date | (任务名) | $Category | $targetFileName | (来源URL) | (用途说明) |" -ForegroundColor Cyan
Write-Host ""
Write-Host "Copy the line above and append to: $IndexFile" -ForegroundColor Gray

return @{
    Source = $SourceFile
    Target = $targetPath
    Category = $Category
    FileName = $targetFileName
}
