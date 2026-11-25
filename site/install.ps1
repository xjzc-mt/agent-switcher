$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Msg([string]$text) { [regex]::Unescape($text) }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw (Msg 'AgentSwitcher \u4ec5\u652f\u6301 64 \u4f4d Windows (x64)\u3002')
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$releasesUrl = if ($env:AGS_RELEASES_URL) { $env:AGS_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/xjzc-mt/agent-switcher/releases' }

Write-Host (Msg '\u6b63\u5728\u67e5\u8be2 AgentSwitcher \u6700\u65b0\u6b63\u5f0f\u7248\u672c (Windows x64)...')
$tag = ''
if ($env:AGS_RELEASE_TAG) {
  $tag = [string]$env:AGS_RELEASE_TAG
} else {
  $req = [Net.HttpWebRequest]::Create("$releasesUrl/latest")
  $req.Method = 'HEAD'
  $req.AllowAutoRedirect = $true
  $req.UserAgent = 'AgentSwitcher-Installer'
  $resp = $req.GetResponse()
  try {
    $finalUri = $resp.ResponseUri.AbsoluteUri
  } finally {
    $resp.Close()
  }
  $prefix = "$releasesUrl/tag/"
  if (-not $finalUri.StartsWith($prefix, [StringComparison]::Ordinal)) {
    throw (Msg '\u6682\u672a\u53d6\u5f97\u53ef\u7528\u7684\u6b63\u5f0f\u7248\u672c\u3002')
  }
  $tag = [uri]::UnescapeDataString($finalUri.Substring($prefix.Length).Split('?')[0].TrimEnd('/'))
}

$version = $tag -replace '^v', ''
if ($tag -ne "v$version" -or $version -in @('1.0.0', '1.0.1') -or
    $version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
  throw (Msg '\u6682\u672a\u53d6\u5f97\u53ef\u7528\u7684\u6b63\u5f0f\u7248\u672c\u3002')
}

$exeName = "AgentSwitcher-Setup-$version-x64.exe"
$encodedTag = [uri]::EscapeDataString($tag)
$exeUrl = "$releasesUrl/download/$encodedTag/$([uri]::EscapeDataString($exeName))"
$manifestUrl = "$exeUrl.signed.json"

$stage = Join-Path ([IO.Path]::GetTempPath()) ('ags-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$manifestPath = Join-Path $stage "$exeName.signed.json"
$exePath = Join-Path $stage $exeName

try {
  Invoke-WebRequest -Uri $manifestUrl -OutFile $manifestPath -Headers @{ 'User-Agent' = 'AgentSwitcher-Installer' } -UseBasicParsing
  $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $expectedSize = [int64]$manifest.size
  if ($manifest.version -ne $version -or $manifest.name -ne $exeName -or
      $expectedSize -le 0 -or $expectedSize -ge 2147483648 -or
      $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or ([string]$manifest.signature).Length -ne 88) {
    throw (Msg '\u7b7e\u540d\u6e05\u5355\u683c\u5f0f\u6216\u7248\u672c\u4fe1\u606f\u4e0d\u5339\u914d\u3002')
  }

  Write-Host ((Msg '\u6b63\u5728\u4e0b\u8f7d {0} (v{1})...') -f $exeName, $version)
  Invoke-WebRequest -Uri $exeUrl -OutFile $exePath -Headers @{ 'User-Agent' = 'AgentSwitcher-Installer' } -UseBasicParsing
  $item = Get-Item -LiteralPath $exePath
  $actualHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($item.Length -ne $expectedSize -or $actualHash -ne $manifest.sha256) {
    throw (Msg '\u5b89\u88c5\u5305\u5927\u5c0f\u6216 SHA-256 \u6821\u9a8c\u5931\u8d25\uff0c\u5df2\u4e2d\u6b62\u5b89\u88c5\u3002')
  }

  $installerArgs = if ($env:AGS_INSTALLER_ARGS) { $env:AGS_INSTALLER_ARGS } elseif ($env:AGS_NO_OPEN -eq '1') { '/S' } else { '/S --force-run' }
  Write-Host ((Msg '\u6b63\u5728\u5b89\u88c5 AgentSwitcher v{0}...') -f $version)
  $proc = [Diagnostics.Process]::Start($exePath, $installerArgs)
  if ($null -eq $proc) { throw (Msg '\u65e0\u6cd5\u542f\u52a8\u5b89\u88c5\u7a0b\u5e8f\u3002') }
  $proc.WaitForExit()
  $exitCode = $proc.ExitCode
  $proc.Dispose()
  if ($exitCode -ne 0) { throw ((Msg '\u5b89\u88c5\u7a0b\u5e8f\u5f02\u5e38\u9000\u51fa (\u4ee3\u7801: {0})\u3002') -f $exitCode) }

  $installedExe = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\agent-switcher\AgentSwitcher.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\AgentSwitcher\AgentSwitcher.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($installedExe) {
    Write-Host ((Msg 'AgentSwitcher v{0} \u5df2\u5b89\u88c5\u81f3 {1}\uff08\u5df2\u521b\u5efa\u684c\u9762\u4e0e\u5f00\u59cb\u83dc\u5355\u5feb\u6377\u65b9\u5f0f\uff09\u3002') -f $version, $installedExe)
  } else {
    Write-Host ((Msg 'AgentSwitcher v{0} \u5b89\u88c5\u5b8c\u6210\uff08\u53ef\u5728\u684c\u9762\u6216\u5f00\u59cb\u83dc\u5355\u6253\u5f00 AgentSwitcher\uff09\u3002') -f $version)
  }
} finally {
  for ($i = 0; $i -lt 4 -and (Test-Path -LiteralPath $stage); $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds 250 }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
