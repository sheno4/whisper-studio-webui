#!/bin/sh
# Bootstrap a project-local Node.js on Linux, then use the common launcher.
set -u

script_dir=$(dirname -- "$0") || { printf '[Whisper Studio] Cannot resolve the launcher directory: dirname is missing.\n' >&2; exit 1; }
project_root=$(CDPATH= cd -- "$script_dir" && pwd -P) || exit 1
cd "$project_root" || exit 1
runtime_dir="$project_root/.runtime"
node_dir="$runtime_dir/node"
lock_dir="$runtime_dir/node-bootstrap.lock"
stage_dir=''
owns_lock=0

fail() {
  printf '\n[Whisper Studio] %s\n' "$*" >&2
  exit 1
}

cleanup() {
  # Only remove the temporary directory created by this invocation.
  if [ -n "$stage_dir" ]; then
    case "$stage_dir" in
      "$runtime_dir"/.node-download.*)
        if [ -d "$stage_dir" ] && [ ! -L "$stage_dir" ]; then
          rm -rf -- "$stage_dir"
        fi
        ;;
    esac
  fi
  if [ "$owns_lock" -eq 1 ]; then
    rm -f -- "$lock_dir/pid"
    rmdir -- "$lock_dir" 2>/dev/null || :
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

usable_node() {
  "$1" -e 'const fs = require("node:fs"), path = require("node:path"); const [major, minor] = process.versions.node.split(".").map(Number); const dir = path.dirname(process.execPath); const candidates = [path.join(dir, "node_modules/npm/bin/npm-cli.js"), path.resolve(dir, "../lib/node_modules/npm/bin/npm-cli.js")]; if (process.argv[1] === "system") candidates.push("/usr/share/nodejs/npm/bin/npm-cli.js"); const npm = candidates.some(file => fs.existsSync(file)); process.exit((major > 22 || (major === 22 && minor >= 12)) && npm ? 0 : 1)' "${2:-portable}" >/dev/null 2>&1
}

choose_node() {
  node_exe=''
  if [ -x "$node_dir/bin/node" ] && usable_node "$node_dir/bin/node"; then
    node_exe="$node_dir/bin/node"
  elif [ -x "$node_dir/node.exe" ] && usable_node "$node_dir/node.exe"; then
    node_exe="$node_dir/node.exe"
  elif [ "${WHISPER_PORTABLE_ONLY:-0}" != '1' ]; then
    system_node=$(command -v node 2>/dev/null || :)
    if [ -n "$system_node" ] && usable_node "$system_node" system; then
      node_exe="$system_node"
    fi
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 1200 --output "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget --timeout=20 --tries=3 --output-document="$2" "$1"
  else
    fail 'curl or wget is needed to download Node.js. Install one and start again.'
  fi
}

case "$(uname -s)" in
  Linux) node_platform='linux' ;;
  *) fail 'This project supports Windows and Linux. Use start-webui.bat on Windows.' ;;
esac

choose_node
if [ -z "$node_exe" ]; then
  case "$(uname -m)" in
    x86_64|amd64) node_arch='x64' ;;
    arm64|aarch64) node_arch='arm64' ;;
    *) fail 'Automatic Node.js download supports x86-64 and ARM64. Configure a compatible Node.js 22.12 or newer.' ;;
  esac
  command -v tar >/dev/null 2>&1 || fail 'tar is required to unpack Node.js.'
  [ ! -L "$runtime_dir" ] || fail 'The project runtime directory is a symlink. Use a regular project runtime directory.'
  mkdir -p -- "$runtime_dir" || fail 'Cannot create the project runtime directory.'
  # Resolve symlinks once so all temporary cleanup stays in this runtime directory.
  runtime_dir=$(CDPATH= cd -- "$runtime_dir" && pwd -P) || exit 1
  node_dir="$runtime_dir/node"
  lock_dir="$runtime_dir/node-bootstrap.lock"
  attempts=0
  while ! mkdir -- "$lock_dir" 2>/dev/null; do
    if [ -L "$lock_dir" ] || [ ! -d "$lock_dir" ]; then
      fail 'The Node.js setup lock is not a regular directory.'
    fi
    lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || :)
    case "$lock_pid" in
      ''|*[!0-9]*) ;;
      *)
        if ! kill -0 "$lock_pid" 2>/dev/null; then
          rm -f -- "$lock_dir/pid"
          rmdir -- "$lock_dir" 2>/dev/null || :
          continue
        fi
        ;;
    esac
    attempts=$((attempts + 1))
    [ "$attempts" -lt 120 ] || fail 'Another Node.js setup is still running. Wait for it to finish, then start again.'
    [ "$attempts" -ne 1 ] || printf '[Whisper Studio] Waiting for another Node.js setup...\n'
    sleep 2
  done
  owns_lock=1
  printf '%s\n' "$$" > "$lock_dir/pid" || fail 'Cannot write the Node.js setup lock.'
  choose_node
  if [ -z "$node_exe" ]; then
    stage_dir=$(mktemp -d "$runtime_dir/.node-download.XXXXXXXX") || fail 'Cannot create a temporary download directory.'
    node_base='https://nodejs.org/dist/latest-v24.x'
    printf '[Whisper Studio] Downloading Node.js 24 LTS (%s %s)...\n' "$node_platform" "$node_arch"
    download "$node_base/SHASUMS256.txt" "$stage_dir/SHASUMS256.txt" || fail 'Could not download Node.js checksums. Start again to retry.'
    checksum_line=$(awk -v platform="$node_platform" -v arch="$node_arch" \
      '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-" platform "-" arch "[.]tar[.]gz$") { print $1 " " $2; count++ } END { if (count != 1) exit 1 }' \
      "$stage_dir/SHASUMS256.txt") || fail 'The official Node.js manifest has no unique archive for this platform.'
    expected_hash=${checksum_line%% *}
    archive_name=${checksum_line#* }
    [ "${#expected_hash}" -eq 64 ] || fail 'The Node.js checksum is invalid.'
    case "$expected_hash" in *[!0-9a-f]*) fail 'The Node.js checksum is invalid.' ;; esac
    archive="$stage_dir/$archive_name"
    download "$node_base/$archive_name" "$archive" || fail 'Could not download Node.js. Start again to retry.'
    if command -v sha256sum >/dev/null 2>&1; then
      actual_hash=$(sha256sum "$archive" | awk '{ print $1 }')
    elif command -v shasum >/dev/null 2>&1; then
      actual_hash=$(shasum -a 256 "$archive" | awk '{ print $1 }')
    else
      fail 'sha256sum or shasum is required to verify the Node.js download.'
    fi
    [ "$actual_hash" = "$expected_hash" ] || fail 'Node.js checksum mismatch. Start again to download a fresh copy.'
    # Validate member paths before tar can write any archive content.
    tar -tzf "$archive" > "$stage_dir/members.txt" || fail 'Could not inspect the Node.js archive.'
    archive_top=${archive_name%.tar.gz}
    awk -v top="$archive_top" '
      { name = $0; if (name ~ /^\// || name ~ /\\/ || name ~ /^[A-Za-z]:/ || name ~ /(^|\/)\.\.($|\/)/ || (name != top && index(name, top "/") != 1)) exit 1 }
    ' "$stage_dir/members.txt" || fail 'The Node.js archive contains an unsafe or unexpected path.'
    tar -xzf "$archive" -C "$stage_dir" || fail 'Could not unpack Node.js.'
    unpacked_dir="$stage_dir/${archive_name%.tar.gz}"
    usable_node "$unpacked_dir/bin/node" || fail 'The downloaded Node.js cannot run on this system.'
    if [ -e "$node_dir" ] || [ -L "$node_dir" ]; then
      [ ! -L "$node_dir" ] || fail 'The project Node.js directory is a symlink. Replace it with a regular directory or use system Node.js.'
      backup_dir="$runtime_dir/node-backups"
      mkdir -p -- "$backup_dir" || fail 'Cannot preserve the previous Node.js runtime.'
      [ ! -L "$backup_dir" ] || fail 'The Node.js backup directory is a symlink.'
      mv -- "$node_dir" "$backup_dir/node-$(date +%s)-$$" || fail 'Cannot preserve the previous Node.js runtime.'
    fi
    mv -- "$unpacked_dir" "$node_dir" || fail 'Cannot save the project Node.js runtime.'
    node_exe="$node_dir/bin/node"
  fi
  cleanup
  stage_dir=''
  owns_lock=0
fi

node_bin=$(dirname -- "$node_exe") || fail 'Cannot resolve the Node.js executable directory.'
PATH="$node_bin:$PATH"
export PATH
printf '[Whisper Studio] Preparing dependencies and starting the WebUI...\n'
# exec preserves the launcher exit code and Ctrl+C behavior.
exec "$node_exe" "$project_root/scripts/launch.mjs" "$@"
