#!/bin/sh
# Ditfa CLI installer for macOS and Linux.
#
#   curl -fsSL https://github.com/ditfa-dev/ditfa-cli/releases/latest/download/install.sh | sh
#
# Environment:
#   DITFA_VERSION      release to install, e.g. 0.2.0 (default: latest)
#   DITFA_INSTALL_DIR  where the binaries go (default: ~/.local/bin)

set -eu

REPO="ditfa-dev/ditfa-cli"
VERSION="${DITFA_VERSION:-latest}"
INSTALL_DIR="${DITFA_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

need() {
  command -v "$1" > /dev/null 2>&1 || fail "'$1' is required but was not found."
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) fail "Unsupported CPU architecture: $arch" ;;
  esac
  case "$os" in
    Darwin)
      # An x86_64 shell under Rosetta still runs the native arm64 build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null || echo 0)" = 1 ]; then
        arch=aarch64
      fi
      printf '%s-apple-darwin\n' "$arch"
      ;;
    Linux) printf '%s-unknown-linux-gnu\n' "$arch" ;;
    *) fail "Unsupported operating system: $os. On Windows, use install.ps1." ;;
  esac
}

download() {
  if command -v curl > /dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required."
  fi
}

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

main() {
  need uname
  need tar
  target=$(detect_target)
  archive="ditfa-$target.tar.gz"
  case "$VERSION" in
    latest) base="https://github.com/$REPO/releases/latest/download" ;;
    v*) base="https://github.com/$REPO/releases/download/$VERSION" ;;
    *) base="https://github.com/$REPO/releases/download/v$VERSION" ;;
  esac

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading Ditfa CLI ($VERSION) for $target"
  download "$base/$archive" "$tmp/$archive"
  download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

  expected=$(grep " $archive\$" "$tmp/SHA256SUMS" | cut -d ' ' -f 1)
  [ -n "$expected" ] || fail "No checksum for $archive in SHA256SUMS."
  actual=$(sha256_of "$tmp/$archive")
  [ "$expected" = "$actual" ] || fail "Checksum mismatch for $archive (expected $expected, got $actual)."

  tar -xzf "$tmp/$archive" -C "$tmp"
  mkdir -p "$INSTALL_DIR"
  for bin in ditfa ditfa-code-mode-host; do
    if [ -f "$tmp/$bin" ]; then
      # Replace atomically so a running ditfa keeps working.
      cp "$tmp/$bin" "$INSTALL_DIR/.$bin.new"
      chmod 755 "$INSTALL_DIR/.$bin.new"
      mv -f "$INSTALL_DIR/.$bin.new" "$INSTALL_DIR/$bin"
    fi
  done
  say "Installed $("$INSTALL_DIR/ditfa" --version 2> /dev/null || echo ditfa) to $INSTALL_DIR"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      # shellcheck disable=SC2016 # $PATH is printed literally for the user to copy.
      printf '\n%s is not on your PATH. Add this line to your shell profile:\n\n  export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" "$INSTALL_DIR"
      ;;
  esac
  printf 'Get started:\n  export DITFA_API_KEY=dt-...   # from https://chat.ditfa.com/api-keys\n  ditfa\n'
}

main "$@"
