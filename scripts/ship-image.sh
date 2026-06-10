#!/usr/bin/env bash
set -euo pipefail

# Ship a locally-built agent-wechat2 image to one or more hosts WITHOUT a
# registry (GHCR is unreachable from the CN hosts): stream
# `docker save | gzip | ssh <host> docker load`, optionally bring the container
# up via compose afterwards.
#
# Usage:
#   scripts/ship-image.sh <image-tag> <user@host> [user@host ...] [options]
#
# Examples:
#   scripts/ship-image.sh agent-wechat2:0.12.0 root@118.196.48.97 root@43.142.153.128
#   scripts/ship-image.sh agent-wechat2:0.12.0 root@host --up --dir /root/agent-wechat2
#
# Options:
#   --up            After load, run `docker compose up -d` in --dir on the host
#   --dir <path>    Remote compose dir for --up (default: /root/agent-wechat2)
#   --ssh "<opts>"  Extra ssh options (e.g. "-p 2222 -i ~/.ssh/id_x")
#   --no-gzip       Don't gzip the stream (more bytes, less CPU)
#
# The image must already exist locally (build it with build-images-local.sh and
# `docker tag`). The script refuses to ship an image whose architecture does not
# match the remote host's.

usage() { sed -n '3,28p' "$0"; exit "${1:-0}"; }

IMAGE=""
HOSTS=()
DO_UP=0
REMOTE_DIR="/root/agent-wechat2"
SSH_OPTS=""
GZIP=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --up)      DO_UP=1; shift ;;
    --dir)     REMOTE_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --ssh)     SSH_OPTS="${2:-}"; shift 2 ;;
    --no-gzip) GZIP=0; shift ;;
    -h|--help) usage 0 ;;
    -*)        echo "unknown option: $1" >&2; usage 1 ;;
    *)         if [ -z "$IMAGE" ]; then IMAGE="$1"; else HOSTS+=("$1"); fi; shift ;;
  esac
done

[ -n "$IMAGE" ]          || { echo "error: image tag required" >&2; usage 1; }
[ "${#HOSTS[@]}" -gt 0 ] || { echo "error: at least one host required" >&2; usage 1; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "error: image '$IMAGE' not found locally. Build it first, e.g.:" >&2
  echo "  ./scripts/build-images-local.sh --arch amd64 && docker tag agent-wechat2:amd64 $IMAGE" >&2
  exit 1
fi

# amd64 / arm64
norm_arch() {
  case "$1" in
    x86_64|amd64)         echo amd64 ;;
    aarch64|arm64)        echo arm64 ;;
    *)                    echo "$1" ;;
  esac
}

IMG_ARCH=$(norm_arch "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')")
SIZE_MB=$(( $(docker image inspect "$IMAGE" --format '{{.Size}}') / 1024 / 1024 ))
echo "==> Image $IMAGE (arch=$IMG_ARCH, ~${SIZE_MB} MB uncompressed)"

for host in "${HOSTS[@]}"; do
  echo "==> $host: checking architecture ..."
  # shellcheck disable=SC2086
  REMOTE_ARCH=$(norm_arch "$(ssh $SSH_OPTS "$host" 'docker info --format "{{.Architecture}}" 2>/dev/null || uname -m')")
  if [ "$REMOTE_ARCH" != "$IMG_ARCH" ]; then
    echo "    ERROR: image arch ($IMG_ARCH) != host arch ($REMOTE_ARCH). Build a $REMOTE_ARCH image for $host." >&2
    exit 1
  fi

  echo "==> $host: loading image (this transfers ~${SIZE_MB} MB${GZIP:+, gzipped}) ..."
  # shellcheck disable=SC2086
  if [ "$GZIP" -eq 1 ]; then
    docker save "$IMAGE" | gzip -1 | ssh $SSH_OPTS "$host" 'gunzip | docker load'
  else
    docker save "$IMAGE" | ssh $SSH_OPTS "$host" 'docker load'
  fi

  # shellcheck disable=SC2086
  if ! ssh $SSH_OPTS "$host" "docker image inspect '$IMAGE' >/dev/null 2>&1"; then
    echo "    ERROR: image not present on $host after load" >&2
    exit 1
  fi
  echo "    loaded on $host."

  if [ "$DO_UP" -eq 1 ]; then
    echo "==> $host: docker compose up -d (dir=$REMOTE_DIR) ..."
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "$host" "cd '$REMOTE_DIR' && docker compose up -d"
  fi
done

echo "==> Done."
