#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix CLI — one-click install                                              ║
# ║                                                                              ║
# ║      curl -fsSL https://kortix.com/install | bash                            ║
# ║                                                                              ║
# ║  Downloads the prebuilt `kortix` binary for your OS + arch from              ║
# ║  GitHub Releases and drops it on PATH. Cleanly replaces any legacy           ║
# ║  ~/.kortix/kortix shell script left over from the old self-host              ║
# ║  installer.                                                                  ║
# ║                                                                              ║
# ║  Re-run any time to update (or use `kortix update`).                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────────────
REPO="${KORTIX_REPO:-kortix-ai/suna}"
INSTALL_HOME="${KORTIX_HOME:-$HOME/.kortix}"
BINARY_NAME="kortix"
TAG_PREFIX="cli-v"

# ─── Colors ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; C=$'\033[0;36m'
  W=$'\033[1;37m'; B=$'\033[1m'; D=$'\033[2m'; F=$'\033[2;37m'; N=$'\033[0m'
else
  R='' G='' Y='' C='' W='' B='' D='' F='' N=''
fi

info()    { printf "  ${C}▸${N}  %s\n" "$*"; }
ok()      { printf "  ${G}✓${N}  %s\n" "$*"; }
warn()    { printf "  ${Y}!${N}  ${Y}%s${N}\n" "$*"; }
fatal()   { printf "  ${R}✗${N}  ${R}%s${N}\n" "$*" >&2; exit 1; }
section() { printf "\n  ${W}${B}%s${N}\n  ${F}%s${N}\n" "$1" "────────────────────────────────────────────────"; }

print_banner() {
  printf "\n"
  printf "${C}"
  cat <<'EOF'
    ██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗
    ██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝
    █████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝
    ██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗
    ██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗
    ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝
EOF
  printf "${N}\n"
  printf "    ${W}The operating system for AI workers${N}\n"
  printf "    ${F}One-click CLI installer${N}\n"
  printf "\n"
}

# ─── Detect platform + arch ──────────────────────────────────────────────────
detect_platform() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    *) fatal "Unsupported OS: $uname_s. Kortix CLI builds for darwin + linux only." ;;
  esac
  case "$uname_m" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) fatal "Unsupported architecture: $uname_m. Need x86_64 or arm64." ;;
  esac
  ASSET="${BINARY_NAME}-${OS}-${ARCH}"
}

# ─── Resolve target version ──────────────────────────────────────────────────
resolve_version() {
  if [ -n "${KORTIX_VERSION:-}" ]; then
    VERSION="$KORTIX_VERSION"
    info "Pinned version (from \$KORTIX_VERSION): $VERSION"
    return
  fi
  info "Resolving latest release from GitHub…"
  local api_url="https://api.github.com/repos/${REPO}/releases"
  local tag
  tag=$(curl -fsSL --connect-timeout 5 "$api_url" 2>/dev/null \
    | grep -E '"tag_name":' \
    | grep -E "\"${TAG_PREFIX}" \
    | head -1 \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)
  if [ -z "$tag" ]; then
    fatal "Could not find a ${TAG_PREFIX}* release on github.com/${REPO}. Pin one with \`KORTIX_VERSION=cli-v0.1.0 …\`."
  fi
  VERSION="$tag"
  ok "Latest release: $VERSION"
}

# ─── Download the binary to a temp file ──────────────────────────────────────
download_binary() {
  local url="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
  TMP_BIN="$(mktemp -t kortix-install.XXXXXX)"
  info "Downloading ${ASSET}…"
  printf "    ${F}from ${url}${N}\n"
  if ! curl -fsSL "$url" -o "$TMP_BIN"; then
    rm -f "$TMP_BIN"
    fatal "Failed to download $url. Check the release page on github.com/${REPO}/releases."
  fi
  chmod +x "$TMP_BIN"
  ok "Downloaded ($(du -h "$TMP_BIN" | awk '{print $1}'))"
}

# ─── Handle the legacy ~/.kortix/kortix bash script ──────────────────────────
maybe_migrate_legacy() {
  local legacy="$INSTALL_HOME/$BINARY_NAME"
  if [ ! -f "$legacy" ]; then return; fi
  # Detect: the legacy one is a bash script that mentions "Kortix CLI" near the top.
  if head -3 "$legacy" 2>/dev/null | grep -q '#!/usr/bin/env bash'; then
    warn "Legacy bash CLI detected at $legacy"
    info "Backing it up to ${legacy}.legacy and replacing with the new binary."
    mv "$legacy" "${legacy}.legacy" || fatal "Could not move legacy CLI aside. Try \`sudo rm $legacy\` first."
  fi
}

# ─── Install the binary ──────────────────────────────────────────────────────
install_binary() {
  mkdir -p "$INSTALL_HOME"
  local target="$INSTALL_HOME/$BINARY_NAME"
  mv "$TMP_BIN" "$target"
  chmod +x "$target"
  ok "Installed binary at ${target}"
}

# ─── Symlink it onto $PATH ───────────────────────────────────────────────────
link_onto_path() {
  local target="$INSTALL_HOME/$BINARY_NAME"
  # Preferred: /usr/local/bin (already on most PATHs).
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    ln -sf "$target" "/usr/local/bin/${BINARY_NAME}"
    ok "Symlinked /usr/local/bin/${BINARY_NAME} → ${target}"
    return
  fi
  # Fallback: ~/.local/bin if it exists.
  local local_bin="$HOME/.local/bin"
  if [ -d "$local_bin" ]; then
    mkdir -p "$local_bin"
    ln -sf "$target" "${local_bin}/${BINARY_NAME}"
    ok "Symlinked ${local_bin}/${BINARY_NAME} → ${target}"
    case ":$PATH:" in
      *":${local_bin}:"*) ;;
      *)
        warn "${local_bin} isn't on your PATH. Add this to your shell rc:"
        printf "    ${C}export PATH=\"\$HOME/.local/bin:\$PATH\"${N}\n"
        ;;
    esac
    return
  fi
  # Last resort: try sudo for /usr/local/bin.
  if command -v sudo >/dev/null 2>&1; then
    info "Linking via sudo (you may be prompted for your password)…"
    if sudo ln -sf "$target" "/usr/local/bin/${BINARY_NAME}"; then
      ok "Symlinked /usr/local/bin/${BINARY_NAME} → ${target}"
      return
    fi
  fi
  warn "Could not put kortix on PATH automatically."
  printf "    Run this when convenient:\n"
  printf "    ${C}sudo ln -sf ${target} /usr/local/bin/kortix${N}\n"
}

# ─── Verify installed binary works ───────────────────────────────────────────
verify_install() {
  local target
  target="$(command -v "$BINARY_NAME" 2>/dev/null || true)"
  if [ -z "$target" ]; then
    target="$INSTALL_HOME/$BINARY_NAME"
  fi
  if ! "$target" version >/dev/null 2>&1; then
    warn "Binary installed but \`kortix version\` failed. Try running it directly: $target"
    return
  fi
  ok "kortix --version → $("$target" version | head -1 | sed 's/^[[:space:]]*//')"
}

print_next_steps() {
  printf "\n"
  printf "  ${W}${B}Get started:${N}\n\n"
  printf "    ${C}kortix login${N}           ${F}browser opens — one click to authorize${N}\n"
  printf "    ${C}kortix projects ls${N}     ${F}list your projects${N}\n"
  printf "    ${C}kortix projects link${N}   ${F}bind this directory to a project${N}\n"
  printf "    ${C}kortix --help${N}          ${F}every command${N}\n"
  printf "\n"
  printf "  ${F}Update later:${N} ${C}kortix update${N}\n"
  printf "  ${F}Remove:${N}      ${C}kortix uninstall${N}\n"
  printf "\n"
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  print_banner
  section "Preflight"
  command -v curl >/dev/null 2>&1 || fatal "curl is required."
  ok "curl available"
  detect_platform
  ok "Platform detected: ${OS}-${ARCH}"

  section "Fetching binary"
  resolve_version
  download_binary

  section "Installing"
  maybe_migrate_legacy
  install_binary
  link_onto_path

  section "Verifying"
  verify_install

  print_next_steps
}

main "$@"
