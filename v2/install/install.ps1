#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateNotNullOrEmpty()][string]$ServerUrl,
  [Parameter(Mandatory = $true, Position = 1)][ValidateNotNullOrEmpty()][string]$EnrollmentToken
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "codex-meter installer: $Message" }
if ($ServerUrl -notmatch '^https://') {
  if (($env:CODEX_METER_ALLOW_HTTP_TESTS -ne '1') -or ($ServerUrl -notmatch '^http://(127\.0\.0\.1|localhost)(:\d+)?(/|$)')) { Fail 'server URL must use HTTPS' }
}
$ServerUrl = $ServerUrl.TrimEnd('/')
$Platform = if ($env:CODEX_METER_TEST_PLATFORM) { $env:CODEX_METER_TEST_PLATFORM } else { [System.Environment]::OSVersion.Platform.ToString() }
$Arch = if ($env:CODEX_METER_TEST_ARCH) { $env:CODEX_METER_TEST_ARCH } else { [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
if (($Platform -notin @('Win32NT', 'Windows')) -or ($Arch -ne 'X64')) { Fail "unsupported platform: $Platform/$Arch (supported: Windows x64)" }

$StateDir = if ($env:CODEX_METER_TEST_ROOT) { Join-Path $env:CODEX_METER_TEST_ROOT 'CodexMeter' } else { Join-Path $env:LOCALAPPDATA 'CodexMeter' }
$Executable = Join-Path $StateDir 'codex-meter-agent.exe'
$Config = Join-Path $StateDir 'agent.json'
$Candidate = "$Executable.update-$PID.exe"
$ManifestFile = Join-Path $StateDir ".manifest-$PID.json"
$TaskName = 'Codex Meter Agent'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

function Download([string]$Uri, [string]$OutFile) {
  if ($env:CODEX_METER_TEST_DOWNLOAD_COMMAND) { & $env:CODEX_METER_TEST_DOWNLOAD_COMMAND $Uri $OutFile; if ($LASTEXITCODE -ne 0) { Fail "download failed: $Uri" } }
  else { Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile }
}
function Protect([string]$Path) {
  if ($env:CODEX_METER_TEST_SKIP_ACL -eq '1') { return }
  & icacls.exe $Path /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not protect $Path" }
}
try {
  $ManifestUri = "$ServerUrl/api/v1/agent/releases/manifest.json"
  Download $ManifestUri $ManifestFile
  try { $Manifest = Get-Content -LiteralPath $ManifestFile -Raw | ConvertFrom-Json }
  catch { Fail 'invalid release manifest' }
  $Artifact = $Manifest.artifacts.'windows-x64'
  if (($null -eq $Artifact) -or ([string]::IsNullOrWhiteSpace($Artifact.url)) -or ($Artifact.sha256 -notmatch '^[0-9A-Fa-f]{64}$')) { Fail 'manifest has no valid artifact for windows-x64' }
  $ArtifactUri = if ($Artifact.url -match '^https?://') { $Artifact.url } elseif ($Artifact.url.StartsWith('/')) { "$ServerUrl$($Artifact.url)" } else { "$ServerUrl/api/v1/agent/releases/$($Artifact.url)" }
  Remove-Item -Force -ErrorAction SilentlyContinue $Candidate
  Download $ArtifactUri $Candidate
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Candidate).Hash.ToLowerInvariant()
  if ($Actual -ne $Artifact.sha256.ToLowerInvariant()) { Fail 'artifact checksum mismatch; existing installation was not changed' }

  $EnrollArgs = @('enroll', '--server', $ServerUrl, '--token', $EnrollmentToken, '--config', $Config)
  $CodexCommand = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if (($null -ne $CodexCommand) -and [System.IO.Path]::IsPathRooted($CodexCommand.Source)) { $EnrollArgs += @('--codex-executable', $CodexCommand.Source) }
  if ($env:CODEX_METER_ALLOW_HTTP_TESTS -eq '1') { $EnrollArgs += '--allow-http-for-tests' }
  & $Candidate @EnrollArgs
  if ($LASTEXITCODE -ne 0) { Fail 'enrollment failed; existing executable was not changed' }
  Protect $Config
  Move-Item -Force -LiteralPath $Candidate -Destination $Executable
  Protect $Executable

  $TaskCommand = "`"$Executable`" run --config `"$Config`""
  if ($env:CODEX_METER_TEST_TASK_COMMAND) {
    & $env:CODEX_METER_TEST_TASK_COMMAND '/Create' '/TN' $TaskName '/SC' 'ONLOGON' '/RL' 'LIMITED' '/TR' $TaskCommand '/F'
    if ($LASTEXITCODE -ne 0) { Fail 'could not register per-user Scheduled Task' }
    & $env:CODEX_METER_TEST_TASK_COMMAND '/Run' '/TN' $TaskName
  } else {
    & schtasks.exe /Create /TN $TaskName /SC ONLOGON /RL LIMITED /TR $TaskCommand /F | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'could not register per-user Scheduled Task' }
    & schtasks.exe /Run /TN $TaskName | Out-Null
  }
  Write-Output "Codex Meter Agent installed and started: $Executable"
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $ManifestFile, $Candidate
}
