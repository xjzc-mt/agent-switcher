$ErrorActionPreference = 'Stop'

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'AgentSwitcher 仅支持 64 位 Windows (x64)。'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$apiUrl = if ($env:AGS_RELEASE_API) { $env:AGS_RELEASE_API } else { 'https://api.github.com/repos/xjzc-mt/agent-switcher/releases/latest' }
$releasesUrl = if ($env:AGS_RELEASES_URL) { $env:AGS_RELEASES_URL } else { 'https://github.com/xjzc-mt/agent-switcher/releases' }

Write-Host '正在查询 AgentSwitcher 最新正式版本 (Windows x64)...'
$release = Invoke-RestMethod -Uri $apiUrl -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'AgentSwitcher-Installer' }
$tag = [string]$release.tag_name
$version = $tag -replace '^v', ''

if ($release.draft -or $release.prerelease -or $version -in @('1.0.0', '1.0.1') -or
    $version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
    $release.html_url -ne "$releasesUrl/tag/$([uri]::EscapeDataString($tag))") {
  throw '暂未取得可用的正式版本。'
}

$exeName = "AgentSwitcher-Setup-$version-x64.exe"
$manifestName = "$exeName.signed.json"
$assets = @($release.assets)
$exeAssets = @($assets | Where-Object {
  $_.state -eq 'uploaded' -and $_.name -eq $exeName -and $_.size -gt 0 -and $_.size -lt 2147483648 -and
  $_.browser_download_url -eq "$releasesUrl/download/$([uri]::EscapeDataString($tag))/$([uri]::EscapeDataString($exeName))"
})
$manifestAssets = @($assets | Where-Object {
  $_.state -eq 'uploaded' -and $_.name -eq $manifestName -and $_.size -gt 0 -and $_.size -le 4096 -and
  $_.browser_download_url -eq "$releasesUrl/download/$([uri]::EscapeDataString($tag))/$([uri]::EscapeDataString($manifestName))"
})

if ($exeAssets.Count -ne 1) { throw '此版本缺少适用于 Windows x64 的安装程序。' }
if ($manifestAssets.Count -ne 1) { throw '此版本缺少有效的发布者签名清单。' }

$exeAsset = $exeAssets[0]
$manifest = Invoke-RestMethod -Uri $manifestAssets[0].browser_download_url -Headers @{ 'User-Agent' = 'AgentSwitcher-Installer' }
if ($manifest.version -ne $version -or $manifest.name -ne $exeName -or [int64]$manifest.size -ne [int64]$exeAsset.size -or
    $manifest.sha256 -notmatch '^[a-f0-9]{64}$' -or ([string]$manifest.signature).Length -ne 88) {
  throw '签名清单格式或版本信息不匹配。'
}
if ($exeAsset.digest -and ([string]$exeAsset.digest).ToLowerInvariant() -ne "sha256:$($manifest.sha256)") {
  throw '签名清单哈希与发布记录不一致。'
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ("ags-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$exePath = Join-Path $stage $exeName

try {
  Write-Host "正在下载 ${exeName} (v${version})..."
  Invoke-WebRequest -Uri $exeAsset.browser_download_url -OutFile $exePath -UseBasicParsing
  $item = Get-Item -LiteralPath $exePath
  $actualHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($item.Length -ne [int64]$manifest.size -or $actualHash -ne $manifest.sha256) {
    throw '安装包大小或 SHA-256 校验失败，已中止安装。'
  }

  $installerArgs = if ($env:AGS_INSTALLER_ARGS) { $env:AGS_INSTALLER_ARGS } elseif ($env:AGS_NO_OPEN -eq '1') { '/S' } else { '/S --force-run' }
  Write-Host "正在安装 AgentSwitcher v${version}..."
  $proc = [Diagnostics.Process]::Start($exePath, $installerArgs)
  if ($null -eq $proc) { throw '无法启动安装程序。' }
  $proc.WaitForExit()
  $exitCode = $proc.ExitCode
  $proc.Dispose()
  if ($exitCode -ne 0) { throw "安装程序异常退出 (代码: ${exitCode})。" }
  Write-Host "AgentSwitcher v${version} 安装完成（后续可在「设置 → 应用与更新」一键升级）。"
} finally {
  for ($i = 0; $i -lt 4 -and (Test-Path -LiteralPath $stage); $i++) {
    if ($i -gt 0) { Start-Sleep -Milliseconds 250 }
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
