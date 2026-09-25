param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectName
)

$SkillRoot = Split-Path $PSScriptRoot -Parent
$TemplateRoot = Join-Path $SkillRoot 'assets\video-project-template'
$WorkspaceRoot = Split-Path (Split-Path $SkillRoot -Parent) -Parent
$ActiveRoot = Join-Path $WorkspaceRoot 'projects\active'
$TargetRoot = Join-Path $ActiveRoot $ProjectName

if (Test-Path $TargetRoot) {
    throw "Project already exists: $TargetRoot"
}

Copy-Item -Path $TemplateRoot -Destination $TargetRoot -Recurse

$assetDirs = @(
    (Join-Path $WorkspaceRoot "assets\source-images\by-project\$ProjectName"),
    (Join-Path $WorkspaceRoot "assets\source-video\by-project\$ProjectName"),
    (Join-Path $WorkspaceRoot "assets\source-audio\by-project\$ProjectName")
)
New-Item -ItemType Directory -Force -Path $assetDirs | Out-Null

$projectYaml = Join-Path $TargetRoot 'project.yaml'
$projectYamlContent = Get-Content $projectYaml -Raw
$projectYamlContent = $projectYamlContent.Replace('<replace-me>', $ProjectName)
$projectYamlContent = $projectYamlContent.Replace('<project-slug>', $ProjectName)
Set-Content -Path $projectYaml -Value $projectYamlContent -Encoding UTF8

Write-Output "Created project: $TargetRoot"
Write-Output "Asset roots:"
$assetDirs | ForEach-Object { Write-Output "- $_" }
