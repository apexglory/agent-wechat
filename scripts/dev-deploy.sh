#!/usr/bin/env bash
set -euo pipefail

# Compile the Rust server inside Docker and deploy into a running container.
# Also syncs docker/tools/* into the container's /opt/tools so changes to the
# Python helper scripts (a11y-dump, a11y-dumpd, chat-select, …) land without
# needing a full image rebuild. Use --skip-tools to opt out.
#
# Builds in debug mode by default (for debugging). Use --release for optimized builds.
# Usage:
#   ./scripts/dev-deploy.sh                 # debug build (default), syncs tools
#   ./scripts/dev-deploy.sh --release       # release build
#   ./scripts/dev-deploy.sh --container abc # specify container name/id
#   ./scripts/dev-deploy.sh --skip-tools    # only deploy the binary
#   ./scripts/dev-deploy.sh --tools-only    # only sync docker/tools (no rebuild)

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUST_DIR="$ROOT_DIR/packages/agent-server-rust"
TOOLS_DIR="$ROOT_DIR/docker/tools"
BUILDER_IMAGE="rust:1.93-bookworm"
CACHE_VOLUME="agent-wechat-cargo-cache"

CONTAINER=""
BUILD_MODE="debug"
SYNC_TOOLS=1
BUILD_BINARY=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container)
      CONTAINER="${2:-}"
      shift 2
      ;;
    --release)
      BUILD_MODE="release"
      shift
      ;;
    --skip-tools)
      SYNC_TOOLS=0
      shift
      ;;
    --tools-only)
      BUILD_BINARY=0
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "Usage: $0 [--container name] [--release] [--skip-tools] [--tools-only]" >&2
      exit 1
      ;;
  esac
done

# Auto-detect container
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --filter "name=agent-wechat" --format '{{.Names}}' | head -1)
  if [ -z "$CONTAINER" ]; then
    echo "No running agent-wechat container found. Specify with --container" >&2
    exit 1
  fi
fi

# Detect container platform
CONTAINER_ARCH=$(docker inspect --format '{{.Architecture}}' "$CONTAINER" 2>/dev/null || echo "")
case "$CONTAINER_ARCH" in
  amd64)  PLATFORM="linux/amd64" ;;
  arm64)  PLATFORM="linux/arm64" ;;
  *)
    case "$(uname -m)" in
      x86_64)        PLATFORM="linux/amd64" ;;
      aarch64|arm64) PLATFORM="linux/arm64" ;;
      *) echo "Unknown architecture." >&2; exit 1 ;;
    esac
    ;;
esac

CARGO_ARGS="--release"
BINARY_DIR="release"
if [ "$BUILD_MODE" = "debug" ]; then
  CARGO_ARGS=""
  BINARY_DIR="debug"
fi

# Docker cannot create a nested mountpoint under a read-only bind mount,
# so make sure the source tree already contains /build/target.
mkdir -p "$RUST_DIR/target"

DOCKER_RUN_ARGS=(
  --rm
  --platform "$PLATFORM"
  -v "$RUST_DIR:/build:ro"
  -v "$CACHE_VOLUME:/build/target"
  -v "${CACHE_VOLUME}-registry:/usr/local/cargo/registry"
  -w /build
)

# Reuse host Cargo registry configuration (for mirrors, auth, etc.) inside
# the builder container when present.
if [ -f "$HOME/.cargo/config.toml" ]; then
  DOCKER_RUN_ARGS+=(-v "$HOME/.cargo/config.toml:/usr/local/cargo/config.toml:ro")
fi

if [ "$BUILD_BINARY" = 1 ]; then
  echo "==> Building in Docker ($PLATFORM, mode=$BUILD_MODE)"
  docker run "${DOCKER_RUN_ARGS[@]}" \
    "$BUILDER_IMAGE" \
    cargo build $CARGO_ARGS

  echo "==> Deploying binary to container: $CONTAINER"
  # Extract binary from cache volume via a temporary container
  TMP_CT=$(docker create -v "$CACHE_VOLUME:/target:ro" "$BUILDER_IMAGE")
  docker cp "$TMP_CT:/target/$BINARY_DIR/agent-server" - | docker cp - "$CONTAINER:/opt/agent-server/"

  # For debug builds, also extract binary locally for symbol resolution
  if [ "$BUILD_MODE" = "debug" ]; then
    LOCAL_BIN="$RUST_DIR/target/debug-remote"
    mkdir -p "$LOCAL_BIN"
    docker cp "$TMP_CT:/target/$BINARY_DIR/agent-server" "$LOCAL_BIN/agent-server"
    echo "==> Debug binary extracted to $LOCAL_BIN/agent-server"
  fi

  docker rm "$TMP_CT" > /dev/null
fi

if [ "$SYNC_TOOLS" = 1 ]; then
  if [ ! -d "$TOOLS_DIR" ]; then
    echo "==> Skipping tools sync: $TOOLS_DIR not found" >&2
  else
    echo "==> Syncing docker/tools/ → $CONTAINER:/opt/tools/"
    # Copy each regular file individually so we can chmod +x cleanly and so
    # `docker cp` doesn't choke on the directory itself (some daemons reject
    # `docker cp dir/. container:dest/` semantics across versions).
    TOOL_COUNT=0
    while IFS= read -r -d '' f; do
      name=$(basename "$f")
      docker cp "$f" "$CONTAINER:/opt/tools/$name"
      TOOL_COUNT=$((TOOL_COUNT + 1))
    done < <(find "$TOOLS_DIR" -maxdepth 1 -type f -print0)
    # Restore executable bit (lost when host file isn't +x or fs strips it)
    docker exec "$CONTAINER" sh -c 'chmod +x /opt/tools/*' 2>/dev/null || true
    echo "==> Synced $TOOL_COUNT tool(s)"
  fi
fi

if [ "$BUILD_BINARY" = 1 ]; then
  # Kill server process — entrypoint restart loop brings it back with new binary
  docker exec "$CONTAINER" pkill -f '/opt/agent-server/agent-server' 2>/dev/null || true
  echo "==> Server restarting with new binary"
else
  echo "==> Tools-only sync done (server not restarted)"
fi
