$ErrorActionPreference = "Stop"
Set-Location "D:\TG Auto"

$logFile = "D:\TG Auto\logs\scheduled-run.log"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

Add-Content -Path $logFile -Value "`n=== $timestamp : scheduled run starting ==="
& "C:\Program Files\nodejs\node.exe" "src\submit-indexing.mjs" --engine=google *>> $logFile
Add-Content -Path $logFile -Value "=== $timestamp : scheduled run finished (exit $LASTEXITCODE) ==="
