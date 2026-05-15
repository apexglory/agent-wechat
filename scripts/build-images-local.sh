#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOCKER_DIR="$ROOT_DIR/docker"
DOCKERFILE="$DOCKER_DIR/Dockerfile"

ARCH_ONLY=""
NO_CACHE=0
BUILD_MODE="release"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    --debug)
      BUILD_MODE="debug"
      shift
      ;;
    --arch)
      ARCH_ONLY="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

prepare_build_context() {
  echo "==> Preparing build context"
  echo "==> Copying agent-server-rust to docker context"
  rm -rf "$DOCKER_DIR/agent-server-rust"
  mkdir -p "$DOCKER_DIR/agent-server-rust"
  cp "$ROOT_DIR/packages/agent-server-rust/Cargo.toml" "$DOCKER_DIR/agent-server-rust/"
  if [ -f "$ROOT_DIR/packages/agent-server-rust/Cargo.lock" ]; then
    cp "$ROOT_DIR/packages/agent-server-rust/Cargo.lock" "$DOCKER_DIR/agent-server-rust/"
  fi
  cp -r "$ROOT_DIR/packages/agent-server-rust/src" "$DOCKER_DIR/agent-server-rust/"
  cp -r "$ROOT_DIR/packages/agent-server-rust/migrations" "$DOCKER_DIR/agent-server-rust/"
}

cleanup_build_context() {
  echo "==> Cleaning up build context"
  rm -rf "$DOCKER_DIR/agent-server-rust"
}

build_arch() {
  local platform="$1"
  local tag="$2"
  local build_args=()

  echo "==> Building ${tag} (${platform})"
  echo "    WeChat .deb will be downloaded inside Docker build"
  if [ "$NO_CACHE" -eq 1 ]; then
    build_args+=(--no-cache)
  fi

  docker buildx build \
    "${build_args[@]}" \
    --platform "$platform" \
    --build-arg BUILD_MODE="$BUILD_MODE" \
    -t "$tag" \
    --load \
    -f "$DOCKERFILE" \
    "$DOCKER_DIR"
}

# Auto-detect architecture if not specified
if [ -z "$ARCH_ONLY" ]; then
  case "$(uname -m)" in
    x86_64)          ARCH_ONLY="amd64" ;;
    aarch64|arm64)   ARCH_ONLY="arm64" ;;
    *)
      echo "Unknown host architecture: $(uname -m). Use --arch to specify." >&2
      exit 1
      ;;
  esac
  echo "==> Auto-detected architecture: $ARCH_ONLY"
fi

# Prepare build context (copy Rust source)
prepare_build_context

# Ensure cleanup on exit
trap cleanup_build_context EXIT

case "$ARCH_ONLY" in
  amd64)
    build_arch "linux/amd64" "agent-wechat2:amd64"
    printf "\nDone. Built: agent-wechat2:amd64\n"
    ;;
  arm64)
    build_arch "linux/arm64" "agent-wechat2:arm64"
    printf "\nDone. Built: agent-wechat2:arm64\n"
    ;;
  both)
    build_arch "linux/amd64" "agent-wechat2:amd64"
    build_arch "linux/arm64" "agent-wechat2:arm64"
    printf "\nDone. Built: agent-wechat2:amd64, agent-wechat2:arm64\n"
    ;;
  *)
    echo "unsupported arch: $ARCH_ONLY (use amd64, arm64, or both)" >&2
    exit 1
    ;;
esac
