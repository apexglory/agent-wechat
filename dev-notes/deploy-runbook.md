# agent-wechat2 deploy runbook (image-based, no registry)

Goal: every host (3 CN servers + local) runs a **pinned, freshly-built image**,
upgraded by load-and-restart — never by `dev-deploy` patching a stale container.

Decisions this encodes:
- **Release branch:** `agent-wechat2` (not `main` — `main` is frozen at 2026-04).
- **Distribution:** `docker save | ssh docker load` (GHCR is unreachable from CN).
- **Migration:** zero-copy — the new container reuses each host's existing data
  volume, so the WeChat login carries over.

There are TWO artifacts, versioned together off `package.json`:
1. **agent-wechat2 container image** — rust `agent-server` + WeChat + tools. This doc.
2. **openclaw wechat extension** (`@apexglory/agent-wechat2-wechat`, TS) — shipped
   via npm + `openclaw` update on the gateway host. Separate; see "Extension".

---

## 0. Build the image (on a builder)

Servers are amd64; local Mac is arm64. Build for the **target's** arch (cross-arch
on Mac is slow QEMU — prefer building amd64 on one of the amd64 servers).

```bash
git checkout agent-wechat2 && git pull
VERSION=$(node -p "require('./package.json').version")     # e.g. 0.12.0
./scripts/build-images-local.sh --arch amd64              # -> agent-wechat2:amd64
docker tag agent-wechat2:amd64 agent-wechat2:$VERSION
```

(Local arm64: `--arch arm64`, then tag `agent-wechat2:$VERSION`.)

## 1. Ship to hosts (no registry)

```bash
scripts/ship-image.sh agent-wechat2:$VERSION root@118.196.48.97 root@118.196.123.208 root@43.142.153.128
```

Streams `docker save | gzip | ssh docker load`. Refuses on arch mismatch. Add
`--up --dir /root/agent-wechat2` to also `docker compose up -d` after load.

## 2. Per-host setup (once)

On each host, in the deploy dir (e.g. `/root/agent-wechat2`):
- Put `docker-compose.yml` (from this repo) + a `.env` (from `.env.example`).
- **Point the volumes at the host's EXISTING data** so login carries over. Find them:
  ```bash
  docker inspect agent-wechat \
    --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}'
  ```
  Set `AGENT_WECHAT_DATA_VOLUME` / `AGENT_WECHAT_HOME_VOLUME` in `.env` to those.
- Copy the auth token to the new path the CLI expects:
  ```bash
  mkdir -p ~/.config/agent-wechat2
  cp ~/.config/agent-wechat/token ~/.config/agent-wechat2/token   # if migrating
  chmod 600 ~/.config/agent-wechat2/token
  ```

## 3. Migrate an existing host (zero-copy, ~30s downtime)

```bash
docker stop agent-wechat && docker rm agent-wechat   # data lives in the volumes, safe
cd /root/agent-wechat2 && docker compose up -d        # new image, SAME volumes
wx status                                             # Container up / Server reachable / logged in
```
If `wx status` shows logged-out, open noVNC and re-scan once.

> Rollback: `docker compose down` then re-create the old container against the
> same volumes (it was just `docker run ... --name agent-wechat <old-image>`).
> Nothing was copied or deleted, so the old image still works.

## 4. Upgrade later (the steady state — replaces dev-deploy)

```bash
# builder:
./scripts/build-images-local.sh --arch amd64 && docker tag agent-wechat2:amd64 agent-wechat2:$NEW
scripts/ship-image.sh agent-wechat2:$NEW root@host1 root@host2 root@host3
# each host: bump AGENT_WECHAT_IMAGE in .env, then:
docker compose up -d
```

## 5. Add a NEW host (scaling)

```bash
# 1. install docker
# 2. create fresh volumes (no prior login):
docker volume create agent-wechat2-data && docker volume create agent-wechat2-wechat-home
# 3. drop in docker-compose.yml + .env (volumes = the agent-wechat2-* you just made,
#    token path = ~/.config/agent-wechat2/token)
wx auth token                       # generates the token if missing
# 4. ship + up:
scripts/ship-image.sh agent-wechat2:$VERSION root@newhost --up --dir /root/agent-wechat2
# 5. open noVNC, scan QR to log WeChat in
# 6. point openclaw at this host's :6174 + account config, restart gateway
```
No building on the host, no patching.

---

## Extension (openclaw side)

The TS extension is NOT in the image. It's an npm package the openclaw gateway
loads from `~/.openclaw/.../@apexglory/agent-wechat2-wechat`. Deliver via:
- `scripts/deploy-extension.sh` (build + copy dist into `~/.openclaw`), or
- npm publish (CI `release.yml`) + `openclaw` update.
Then restart the gateway. Keep its version aligned with the image version.

## CI follow-ups (not yet done)

- `release.yml` triggers on `push: main` → repoint to `agent-wechat2` so the
  extension/cli npm packages actually publish from the live branch.
- `docker-rebuild.yml` pushes to `ghcr.io/${github.repository}` =
  `ghcr.io/apexglory/agent-wechat` (missing the `2`) — only matters if we ever
  want a registry copy; the ship-image path doesn't need it.
- Bump the version off `0.11.15` via a changeset before the first image build.
