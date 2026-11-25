#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此脚本仅适用于 macOS。Windows 用户请在 PowerShell 运行: irm https://xjzc-mt.github.io/agent-switcher/install.ps1 | iex" >&2
  exit 1
fi

macos_major="$(/usr/bin/sw_vers -productVersion | cut -d. -f1)"
if [[ ! "$macos_major" =~ ^[0-9]+$ ]] || (( macos_major < 13 )); then
  echo "AgentSwitcher 需要 macOS 13 或更高版本（当前: $(/usr/bin/sw_vers -productVersion)）。" >&2
  exit 1
fi

arch="${AGS_ARCH:-}"
if [[ -z "$arch" ]]; then
  if [[ "$(/usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]] || [[ "$(uname -m)" == "arm64" ]]; then
    arch="arm64"
  elif [[ "$(uname -m)" == "x86_64" ]]; then
    arch="x64"
  else
    echo "暂不支持当前处理器架构: $(uname -m)" >&2
    exit 1
  fi
fi

api_url="${AGS_RELEASE_API:-https://api.github.com/repos/xjzc-mt/agent-switcher/releases/latest}"
releases_url="${AGS_RELEASES_URL:-https://github.com/xjzc-mt/agent-switcher/releases}"

stage="$(mktemp -d "${TMPDIR:-/tmp}/ags-install.XXXXXXXX")"
chmod 700 "$stage"
mount_dir="$stage/volume"
cleanup() {
  if [[ -d "$mount_dir" ]]; then
    /usr/bin/hdiutil detach "$mount_dir" -quiet 2>/dev/null || /usr/bin/hdiutil detach -force "$mount_dir" -quiet 2>/dev/null || true
  fi
  rm -rf "$stage"
}
trap cleanup EXIT

echo "正在查询 AgentSwitcher 最新正式版本 (${arch})..."
/usr/bin/curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" -o "$stage/release.json"

metadata="$(/usr/bin/osascript -l JavaScript - "$stage/release.json" "$arch" "$releases_url" <<'JXA'
ObjC.import('Foundation');
function readText(file) {
  const data = $.NSData.dataWithContentsOfFile(file);
  if (!data || data.isNil()) throw new Error('无法读取发布信息');
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
}
function run(argv) {
  const [releaseFile, arch, releasesUrl] = argv;
  const r = JSON.parse(readText(releaseFile));
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const version = tag.replace(/^v/, '');
  const retired = version === '1.0.0' || version === '1.0.1';
  if (r.draft || r.prerelease || retired || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
      r.html_url !== `${releasesUrl}/tag/${encodeURIComponent(tag)}` || !Array.isArray(r.assets)) {
    throw new Error('暂未取得可用的正式版本');
  }
  const dmgName = `AgentSwitcher-${version}-${arch}.dmg`;
  const manifestName = `${dmgName}.signed.json`;
  const valid = (a, expectedName, maxBytes) => a && a.state === 'uploaded' && a.name === expectedName &&
    Number.isSafeInteger(a.size) && a.size > 0 && a.size <= maxBytes &&
    a.browser_download_url === `${releasesUrl}/download/${encodeURIComponent(tag)}/${encodeURIComponent(expectedName)}`;
  const dmgs = r.assets.filter(a => valid(a, dmgName, 2147483647));
  const manifests = r.assets.filter(a => valid(a, manifestName, 4096));
  if (dmgs.length !== 1) throw new Error(`此版本缺少适用于 macOS (${arch}) 的安装包`);
  if (manifests.length !== 1) throw new Error('此版本缺少有效的发布者签名清单');
  return [version, dmgName, String(dmgs[0].size), dmgs[0].browser_download_url, manifests[0].browser_download_url, dmgs[0].digest || ''].join('\t');
}
JXA
)"

IFS=$'\t' read -r version dmg_name expected_size dmg_url manifest_url github_digest <<<"$metadata"

/usr/bin/curl -fsSL "$manifest_url" -o "$stage/manifest.json"
expected_sha256="$(/usr/bin/osascript -l JavaScript - "$stage/manifest.json" "$version" "$dmg_name" "$expected_size" "$github_digest" <<'JXA'
ObjC.import('Foundation');
function run(argv) {
  const [manifestFile, version, name, sizeText, digest] = argv;
  const data = $.NSData.dataWithContentsOfFile(manifestFile);
  if (!data || data.isNil()) throw new Error('无法读取签名清单');
  const m = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)));
  if (!m || m.version !== version || m.name !== name || String(m.size) !== sizeText ||
      typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256) ||
      typeof m.signature !== 'string' || m.signature.length !== 88) {
    throw new Error('签名清单格式或版本信息不匹配');
  }
  if (digest && digest.toLowerCase() !== `sha256:${m.sha256}`) {
    throw new Error('签名清单哈希与发布记录不一致');
  }
  return m.sha256;
}
JXA
)"

dmg_path="$stage/$dmg_name"
echo "正在下载 ${dmg_name} (v${version})..."
if [[ -t 2 ]]; then
  /usr/bin/curl -fL --progress-bar "$dmg_url" -o "$dmg_path"
else
  /usr/bin/curl -fsSL "$dmg_url" -o "$dmg_path"
fi

actual_size="$(/usr/bin/stat -f%z "$dmg_path")"
actual_sha256="$(/usr/bin/shasum -a 256 "$dmg_path" | /usr/bin/awk '{print $1}')"
if [[ "$actual_size" != "$expected_size" || "$actual_sha256" != "$expected_sha256" ]]; then
  echo "安装包大小或 SHA-256 校验失败，已中止安装。" >&2
  exit 1
fi

mkdir -p "$mount_dir"
/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mount_dir" "$dmg_path" -quiet
app_source="$mount_dir/AgentSwitcher.app"
if [[ ! -x "$app_source/Contents/MacOS/AgentSwitcher" ]]; then
  echo "安装包内缺少完整的 AgentSwitcher.app，已中止安装。" >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$app_source"

target_dir="${AGS_INSTALL_DIR:-}"
if [[ -z "$target_dir" ]]; then
  if [[ -w "/Applications" ]] && { [[ ! -e "/Applications/AgentSwitcher.app" ]] || [[ -w "/Applications/AgentSwitcher.app" ]]; }; then
    target_dir="/Applications"
  else
    target_dir="$HOME/Applications"
  fi
fi
mkdir -p "$target_dir"
target_app="$target_dir/AgentSwitcher.app"

if /usr/bin/pgrep -f "$target_app/Contents/MacOS/AgentSwitcher" >/dev/null 2>&1; then
  echo "正在请求运行中的 AgentSwitcher 安全退出..."
  /usr/bin/osascript -e 'tell application id "com.agent-switcher.app" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    /usr/bin/pgrep -f "$target_app/Contents/MacOS/AgentSwitcher" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if /usr/bin/pgrep -f "$target_app/Contents/MacOS/AgentSwitcher" >/dev/null 2>&1; then
    echo "AgentSwitcher 仍在运行（可能有未保存的操作待确认），请先退出应用后重新执行安装命令。" >&2
    exit 1
  fi
fi

staged_app="$target_dir/.AgentSwitcher.install.$$.app"
rm -rf "$staged_app"
/usr/bin/ditto --noqtn "$app_source" "$staged_app"

if [[ -e "$target_app" ]]; then
  /usr/bin/osascript -l JavaScript -e 'ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]); function run(a) { if ($.renamex_np(a[0], a[1], 2) !== 0) throw Error("swap failed"); }' "$staged_app" "$target_app"
  rm -rf "$staged_app"
else
  mv "$staged_app" "$target_app"
fi

echo "AgentSwitcher v${version} 已安装至 ${target_app}（后续可在「设置 → 应用与更新」一键升级）。"
if [[ "${AGS_NO_OPEN:-0}" != "1" ]]; then
  /usr/bin/open "$target_app"
fi
