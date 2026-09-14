# Release Infrastructure Setup

This document describes how to configure the VS Code Marketplace and GitHub to
enable automated releases of the Hunky Dory extension using GitHub Actions.

## Overview

The release process uses:

- **VS Code Marketplace publishing (`vsce`)**: The extension is published
  under the `shakenfist` publisher id, using a Personal Access Token (PAT)
  minted from an Azure DevOps organisation. VS Code Marketplace identity is
  layered on top of Azure DevOps — there is no separate Marketplace account
  system.
- **A tag-protected `release` GitHub environment**: The publishing token is
  stored as a secret on this environment, not on the repository, so only a
  workflow run triggered by a `v*` tag can read it.
- **Split build/publish jobs**: Building the `.vsix` and publishing it happen
  in different jobs on different runner pools, so the Marketplace token is
  never present on the repository's shared static runner pool. See
  [What the Workflow Then Does](#what-the-workflow-then-does) for why.
- **A GitHub Release**: Each publish also attaches the `.vsix` that was
  shipped to the Marketplace to a GitHub Release, so it can be downloaded
  without going through the Marketplace.

## One-Time Setup Steps

### 1. Create the Azure DevOps organisation and Marketplace publisher

The VS Code Marketplace publisher id is already fixed in this repository:
`package.json` declares `"publisher": "shakenfist"`. The Azure DevOps side
must be set up to match that exact string.

1. If you do not already have one, create an Azure DevOps organisation at
   [dev.azure.com](https://dev.azure.com). Any organisation you belong to can
   mint a token that publishes under a Marketplace publisher — the publisher
   itself is not tied to a specific organisation.
2. Sign in to the
   [Marketplace publisher management page](https://marketplace.visualstudio.com/manage)
   with the Microsoft account tied to that Azure DevOps organisation.
3. Create a publisher with id `shakenfist` (this must match `package.json`
   exactly) and a display name of your choosing.

If a publisher with id `shakenfist` already exists from earlier work, skip
creating it and confirm you have access instead.

### 2. Generate a Marketplace Personal Access Token (`VSCE_PAT`)

1. In Azure DevOps, open **User settings** (top right) > **Personal access
   tokens**.
2. Click **New Token**.
3. Set **Organization** to **All accessible organizations** — not a specific
   org. `vsce` needs this scope to publish, even though the token is created
   from within one organisation's UI.
4. Click **Show all scopes**, then check **Marketplace** > **Manage**.
5. Set an expiration. Azure DevOps currently allows up to one year; pick the
   longest option available and put a reminder somewhere durable (a calendar
   entry, not just this file) to rotate it before it expires. See
   [Troubleshooting](#troubleshooting) for what happens if you don't.
6. Click **Create** and copy the token immediately — Azure DevOps shows it
   only once.

**Read this before relying on a PAT long-term**: Microsoft is retiring
*global* PATs (the "all accessible organizations" scope this token needs) on
**1 December 2026**, in favour of Microsoft Entra ID / workload identity
federation. The version of `vsce` this repository pins (3.9.2) already
carries the replacement: `vsce publish --azure-credential`, described by its
own help as "Use Microsoft Entra ID for authentication". There is no
`--oidc` flag in this version. A token generated before the retirement date
keeps working until it expires or is revoked, but stops working outright
once global PATs are decommissioned, regardless of the token's own
expiration date. Before that date, revisit this document and switch to
`--azure-credential`, which needs an Entra app registration, a GitHub
federated credential and that identity added as a member of the Marketplace
publisher — do not simply mint a fresh PAT and assume this setup survives
unchanged.

### 3. Create the tag-protected `release` GitHub environment

**Do this before pushing the first release tag.** The environment's tag
restriction is what stops a workflow run on an arbitrary branch from reading
`VSCE_PAT`. If a `v*` tag is pushed before this environment (and its tag
rule) exists, the `publish` job either fails outright (no `release`
environment to satisfy `environment: release`) or, if the environment gets
created carelessly afterwards without the tag restriction, runs with the
secret exposed to any ref. Set this up first; the first tag this repository
pushes will be `v0.1.0`.

1. Go to **Settings** > **Environments** on
   `github.com/shakenfist/hunkydory`.
2. Click **New environment**, name it `release`, and click **Configure
   environment**.
3. Under **Deployment branches and tags**, select **Selected branches and
   tags** and add a rule for pattern `v*`. Leave **Required reviewers**
   unset — this repository does not gate releases on manual approval, only
   on tag protection.
4. Click **Save protection rules**.

### 4. Add `VSCE_PAT` as a secret on the `release` environment

1. Still on the `release` environment's configuration page, find
   **Environment secrets**.
2. Click **Add secret**.
3. Name: `VSCE_PAT`. Value: the token from step 2.
4. Click **Add secret**.

Do not add this as a repository secret (**Settings** > **Secrets and
variables** > **Actions** > **Repository secrets**). A repository secret is
readable by every workflow run regardless of ref, which defeats the point of
restricting the `release` environment to `v*` tags.

## What the Workflow Then Does

`release.yml` triggers on push of a tag matching `v*` and runs two jobs:

1. **`build`**, on `[self-hosted, static]`: checks out the tag, runs `npm ci`
   and `npm run package` (`vsce package`), and uploads the resulting `.vsix`
   as a workflow artifact.
2. **`publish`**, on `[self-hosted, vm, debian-13, s]`, with
   `environment: release`: downloads the artifact from `build` and runs
   `vsce publish --packagePath <the downloaded .vsix>`, then attaches the
   same file to a GitHub Release.

Two details are deliberate:

- **The runner split.** The `static` pool that `build` runs on is a shared,
  non-ephemeral runner used by every repository in both the `shakenfist` and
  `mach33labs` GitHub organisations. A secret placed in a job's environment
  on that pool is exposed to every other repository's jobs that happen to
  land on the same machine. `publish` — the only job that touches
  `VSCE_PAT` — runs instead on the `debian-13`/`vm` pool, where that
  exposure doesn't apply. `publish` also runs no `npm ci` and no package
  lifecycle scripts of any kind, because `npm ci` executes dependency
  install scripts, which is exactly the kind of arbitrary code a shared
  credential should not be anywhere near. It only unpacks the already-built
  artifact and runs `vsce`.
- **`--packagePath`, never bare `vsce publish`.** Bare `vsce publish`
  repackages the working tree at publish time. Using `--packagePath` against
  the artifact `build` produced means the exact bytes that were built (and
  that could, in principle, be inspected before publish) are the bytes that
  ship — not a second, potentially different, repackaging done later on a
  different runner.

## Cutting a Release

1. Bump `"version"` in `package.json` (and run whatever `npm` commands keep
   `package-lock.json` in sync) and commit that change through the normal PR
   process.
2. Once the version bump is on `develop`, tag it and push the tag:
   ```bash
   git checkout develop && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Watch the `release.yml` run in the Actions tab. `build` produces the
   `.vsix`; `publish` ships it to the Marketplace and attaches it to a new
   GitHub Release.
4. Confirm the new version shows up on the
   [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=shakenfist.hunkydory)
   — Marketplace indexing can lag a few minutes behind a successful
   `vsce publish`.

## Troubleshooting

### Publish job fails with an authentication error months after this was set up

This is the PAT expiring, and it is the most likely failure mode of this
whole setup — Azure DevOps PATs are not renewed automatically. Generate a new
token (step 2 above) and update the `VSCE_PAT` secret on the `release`
environment (step 4). You do not need to touch the workflow or re-run the
tag push; re-running the failed `publish` job after updating the secret is
enough. If the token was created before 1 December 2026 and suddenly stops
working with no expiration in sight, that is the global-PAT retirement, not
a normal expiry — see the note in step 2.

### "Publisher not found" or similar from `vsce publish`

- Confirm the publisher id used by the token's account is exactly
  `shakenfist`, matching `package.json`.
- Confirm the PAT's **Organization** scope is **All accessible
  organizations**, not a single org — a single-org token can fail to see a
  publisher that isn't tied to that org.
- Confirm the PAT's scope includes **Marketplace** > **Manage**, not just
  **Marketplace** > **Publish** or **Marketplace** > **Acquire**.

### `publish` job can't find the `release` environment, or runs unprotected

Both symptoms trace back to setup ordering. If the environment doesn't exist
yet, the job fails outright. If the environment exists but its tag rule was
never added, the job succeeds but ran with the secret exposed on whatever ref
triggered it — treat that as a reason to rotate `VSCE_PAT` immediately, then
add the missing tag rule (step 3) before pushing another tag.

### Tag pushed but no workflow run appears

Check the tag actually matches `v*` (e.g. `v0.1.0`, not `0.1.0` or
`release-0.1.0`) — `release.yml`'s trigger and the environment's deployment
tag rule both key off that exact pattern.
