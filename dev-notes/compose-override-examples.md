# Host-specific docker-compose overrides

The repo's `docker-compose.yml` is **base only** — image, container_name,
ports, mounts, env-agnostic env vars, restart policy, and `external: true`
volume declarations without names.

Host-specific bits (network mode, volume names, proxy env, ...) live in a
`docker-compose.override.yml` next to the base file. Compose merges
`docker-compose.override.yml` automatically when you run `docker compose`
in the same directory.

The override file is **gitignored** — each host owns its own. Two real
examples from the qiafan2 production hosts follow; copy whichever
matches and adapt.

---

## Server A pattern — compose-managed network, prefixed volume names

Original container was created by a previous compose project named
`agent-wechat` (note the trailing `_` prefix it adds to volume names).
Uses the entrypoint redsocks transparent proxy.

```yaml
# docker-compose.override.yml
services:
  agent-wechat:
    environment:
      - PROXY=${PROXY:-}

volumes:
  agent-wechat-data:
    name: agent-wechat_agent-wechat-data
  agent-wechat-home:
    name: agent-wechat_agent-wechat-home
```

---

## Server B pattern — host bridge network, bare volume names

Original container was created manually via `docker run` on Docker's
default bridge. No proxy. Volume names are bare; the home volume
carries a historical typo (`agent-wechat-wechat-home`) that must be
preserved to keep the existing login state.

```yaml
# docker-compose.override.yml
services:
  agent-wechat:
    network_mode: bridge

volumes:
  agent-wechat-data:
    name: agent-wechat-data
  agent-wechat-home:
    name: agent-wechat-wechat-home
```

---

## Fresh-host pattern — no legacy state to preserve

If you're setting up a brand new host with no existing volumes, the
override can be minimal (or absent entirely; compose will auto-create
volumes named `<project>_<volname>`).

```yaml
# docker-compose.override.yml — minimal example, lets compose pick names
volumes:
  agent-wechat-data: {}
  agent-wechat-home: {}
```

(Drop the `external: true` from the base in this case, or override it
to `external: false`.)

---

## Verifying the override took effect

`docker compose config` prints the merged effective compose without
touching the running container. Use it as a dry-run after editing
either file to confirm the final shape matches what you intended.
