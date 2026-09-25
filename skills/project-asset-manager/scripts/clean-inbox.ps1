# Clean Inbox Report
# Lists all files in assets/downloads/inbox/ for manual review

$WorkspaceRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$InboxPath = Join-Path $WorkspaceRoot "assets\downloads\inbox"

if (-not (Test-Path $InboxPath)) {
    Write-Output "Inbox directory does not exist: $InboxPath"
    exit 0
}

$files = Get-ChildItem -Path $InboxPath -File

if ($files.Count -eq 0) {
    Write-Output "Inbox is empty."
    exit 0
}

Write-Output "Files in inbox ($($files.Count) total):"
Write-Output ""

foreach ($file in $files) {
    $size = if ($file.Length -gt 1MB) { "{0:N2} MB" -f ($file.Length / 1MB) }
            elseif ($file.Length -gt 1KB) { "{0:N2} KB" -f ($file.Length / 1KB) }
            else { "{0} B" -f $file.Length }
    Write-Output "  [$($file.Extension.ToLower())] $($file.Name) ($size) - $($file.LastWriteTime.ToString('yyyy-MM-dd'))"
}

Write-Output ""
Write-Output "Use sort-assets.ps1 to move files to proper directories."
