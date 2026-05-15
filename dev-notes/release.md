# Release Process

This repo releases three artifacts together:

1. npm CLI package: `@apexglory/agent-wechat2-cli`
2. npm OpenClaw extension: `@apexglory/agent-wechat2-wechat`
3. Docker image: `ghcr.io/apexglory/agent-wechat2`

## Prepare A Release

1. Add changelog entries:

```bash
pnpm changeset
```

2. Commit the generated changeset file with your code.

3. Merge to main. The changesets GitHub Action opens a "Version Packages" PR with bumped versions and changelogs.

4. Merge the Version Packages PR to publish.

## What CI/CD Does

On merge of the Version Packages PR:

- Publishes `@apexglory/agent-wechat2-cli` and `@apexglory/agent-wechat2-wechat` to npm with provenance.
- Builds and pushes `amd64` and `arm64` Docker images.
- Publishes a multi-arch manifest tag.

Docker tags:

- `<version>` (e.g., `0.2.0`)
- `latest`

## Trusted Publishing (OIDC)

npm trusted publishing lets GitHub Actions publish without a long-lived token. Setup:

1. Go to https://www.npmjs.com/package/@apexglory/agent-wechat2-cli/access
2. Under "Trusted publishers", add GitHub Actions:
   - **Owner**: `apexglory`
   - **Repository**: `agent-wechat`
   - **Workflow**: `release.yml`
   - **Environment**: (leave blank)
3. Repeat for https://www.npmjs.com/package/@apexglory/agent-wechat2-wechat/access

Once configured, delete the `NPM_TOKEN` secret from GitHub repo settings. The workflow uses OIDC automatically (requires npm >= 11.5.1, installed in CI).

**Note**: Trusted publishing can only be configured for packages that already exist on npm. For brand-new packages, the first publish must use a token.

If you need a different GHCR path, update the image name in `.github/workflows/release.yml`.
