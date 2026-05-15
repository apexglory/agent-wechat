#!/usr/bin/env bash
# Multi-arch build + push agent-wechat2 image to ghcr.io/apexglory/agent-wechat2.
# Requires: `docker login ghcr.io -u apexglory` (PAT with write:packages) and a
# docker-container buildx builder (this script creates `agent-wechat2-builder` if missing).
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DOCKER_DIR="$ROOT_DIR/docker"
DOCKERFILE="$DOCKER_DIR/Dockerfile"
IMAGE="ghcr.io/apexglory/agent-wechat2"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILD_MODE="${BUILD_MODE:-release}"
BUILDER_NAME="agent-wechat2-builder"

prepare_build_context() {
  echo "==> Preparing build context (copying agent-server-rust source)"
  rm -rf "$DOCKER_DIR/agent-server-rust"
  mkdir -p "$DOCKER_DIR/agent-server-rust"
  cp "$ROOT_DIR/packages/agent-server-rust/Cargo.toml" "$DOCKER_DIR/agent-server-rust/"
  if [ -f "$ROOT_DIR/packages/agent-server-rust/Cargo.lock" ]; then
    cp "$ROOT_DIR/packages/agent-server-rust/Cargo.lock" "$DOCKER_DIR/agent-server-rust/"
  fi
  cp -r "$ROOT_DIR/packages/agent-server-rust/src" "$DOCKER_DIR/agent-server-rust/"
  cp -r "$ROOT_DIR/packages/agent-server-rust/migrations" "$DOCKER_DIR/agent-server-rust/"
}

stash_arch_specific_wechat_deb() {
  if [ -f "$DOCKER_DIR/wechat.deb" ]; then
    echo "==> Stashing single-arch wechat.deb (Dockerfile will download per-arch)"
    mv "$DOCKER_DIR/wechat.deb" "$DOCKER_DIR/wechat.deb.stash"
  fi
}

restore_arch_specific_wechat_deb() {
  if [ -f "$DOCKER_DIR/wechat.deb.stash" ]; then
    mv "$DOCKER_DIR/wechat.deb.stash" "$DOCKER_DIR/wechat.deb"
  fi
}

cleanup_build_context() {
  echo "==> Cleaning up build context"
  rm -rf "$DOCKER_DIR/agent-server-rust"
  restore_arch_specific_wechat_deb
}

ensure_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    echo "==> Creating buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
  fi
  docker buildx use "$BUILDER_NAME"
  docker buildx inspect --bootstrap >/dev/null
}

trap cleanup_build_context EXIT

ensure_builder
prepare_build_context
stash_arch_specific_wechat_deb

echo "==> Building + pushing $IMAGE:$VERSION + :latest ($PLATFORMS)"
docker buildx build \
  --progress=plain \
  --platform "$PLATFORMS" \
  --build-arg "BUILD_MODE=$BUILD_MODE" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  -f "$DOCKERFILE" \
  --push \
  "$DOCKER_DIR"

echo "==> Done. Pushed $IMAGE:$VERSION and $IMAGE:latest"
