param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CodexArgs)
# PowerShell passes an argument array to Node; no cmd.exe string concatenation is used.
& node "$PSScriptRoot\..\..\bin\codex-meter.js" @CodexArgs
exit $LASTEXITCODE
