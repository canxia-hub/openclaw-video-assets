param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    
    [Parameter(Mandatory = $true)]
    [ValidateSet('reference', 'source-images', 'source-video', 'source-audio', 'bundle')]
    [string]$Type,
    
    [Parameter(Mandatory = $false)]
    [ValidateSet('style', 'character', 'scene', 'motion', 'competitor', 'by-project', 'stock', 'extracted-frames', 'raw-clips', 'screen-recordings', 'voice', 'music', 'sfx', 'reusable', 'project-specific')]
    [string]$SubType = '',
    
    [Parameter(Mandatory = $false)]
    [string]$ProjectName = ''
)

$WorkspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$DestRoot = Join-Path $WorkspaceRoot "assets\$Type"

if ($SubType) {
    if ($ProjectName -and $SubType -eq 'by-project') {
        $DestPath = Join-Path $DestRoot "$SubType\$ProjectName"
    } else {
        $DestPath = Join-Path $DestRoot $SubType
    }
} else {
    $DestPath = $DestRoot
}

if (-not (Test-Path $DestPath)) {
    New-Item -ItemType Directory -Force -Path $DestPath | Out-Null
}

$files = Get-ChildItem -Path $Source -File
if ($files.Count -eq 0) {
    Write-Output "No files found in $Source"
    exit 0
}

Write-Output "Moving $($files.Count) file(s) from $Source to $DestPath"
foreach ($file in $files) {
    Move-Item -Path $file.FullName -Destination $DestPath -Force
    Write-Output "  Moved: $($file.Name)"
}

Write-Output "Done. Destination: $DestPath"
