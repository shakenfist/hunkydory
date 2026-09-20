# Release Infrastructure Setup

This document describes how to configure the VS Code Marketplace, Microsoft
Entra ID and GitHub to enable automated releases of the Hunky Dory extension
using GitHub Actions.

## Overview

The release process uses:

- **VS Code Marketplace publishing (`vsce`)**: The extension is published
  under the `shakenfist` publisher id. VS Code Marketplace identity is
  layered on top of Azure DevOps and Microsoft Entra ID — there is no
  separate Marketplace account system.
- **No stored publishing credential at all.** The publish job exchanges the
  GitHub OIDC token minted for that specific run for a short-lived Entra
  access token, and publishes with that. Nothing long-lived is stored in
  GitHub, so there is nothing to rotate and nothing to leak. See
  [Why not a Personal Access Token](#why-not-a-personal-access-token).
- **A tag-protected `release` GitHub environment**: it holds no secrets,
  only two identifiers. Its `v*` tag restriction still matters, and now
  matters twice: GitHub will not run the job on another ref, and the subject
  claim GitHub puts in the OIDC token names the environment, so Entra
  refuses to mint a token for a run that reached the job any other way.
- **Split build/publish jobs**: Building the `.vsix` and publishing it happen
  in different jobs on different runner pools, so the publishing credential
  is never present on the repository's shared static runner pool. See
  [What the Workflow Then Does](#what-the-workflow-then-does) for why.
- **A GitHub Release**: Each publish also attaches the `.vsix` that was
  shipped to the Marketplace to a GitHub Release, so it can be downloaded
  without going through the Marketplace.

### Why not a Personal Access Token

An Azure DevOps personal access token (`VSCE_PAT`) is the path most `vsce`
documentation still describes, and an earlier version of this file described
it too. It is not used here, for one decisive reason: Microsoft is retiring
*global* PATs — the "all accessible organizations" scope publishing needs —
on **1 December 2026**, in favour of Entra ID and workload identity
federation. A PAT minted now would need replacing within months, and the
replacement is the setup below, so the setup below is what gets done once.

The mechanism is not `vsce publish --azure-credential`, despite that flag
existing in the pinned version. See the header of
`tools/marketplace-token.mjs` for why, and for the one check to run when
`vsce` is next upgraded that would let this be simplified.

## One-Time Setup Steps

These steps are ordered. Step 5 must be last: the `release` environment must
exist, with its tag rule, before any `v*` tag is pushed.

The Azure and Marketplace web interfaces are re-arranged from time to time,
so treat the menu names below as a description of what you are looking for
rather than a literal path. What must end up true is stated with each step.

### 1. Create the Marketplace publisher

The VS Code Marketplace publisher id is already fixed in this repository:
`package.json` declares `"publisher": "shakenfist"`. The Marketplace side
must be set up to match that exact string.

1. Sign in to the
   [Marketplace publisher management page](https://marketplace.visualstudio.com/manage)
   with the Microsoft account that should own this publisher.
2. Create a publisher with id `shakenfist` (this must match `package.json`
   exactly) and a display name of your choosing.

If a publisher with id `shakenfist` already exists from earlier work, skip
creating it and confirm you have access instead.

**What must be true:** a Marketplace publisher with id `shakenfist` exists
and you can administer it.

### 2. Register an Entra application for the publish job

This is the identity the workflow publishes *as*. It is not a user and it
holds no password.

1. In the [Azure portal](https://portal.azure.com), go to **Microsoft Entra
   ID** > **App registrations** > **New registration**.
2. Give it a name that says what it is — `hunkydory Marketplace publisher`
   is the one this document assumes.
3. Leave the supported account types at the single-tenant default, and leave
   the redirect URI empty. Neither is used.
4. Register it, then record two values from the application's **Overview**
   page. You will need both in step 5:
   - **Application (client) ID** → becomes `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → becomes `AZURE_TENANT_ID`

**Do not create a client secret.** If you find yourself on the "Client
secrets" tab, you are about to build the thing this setup exists to avoid —
a stored credential with an expiry date. The next step is what replaces it.

**What must be true:** an app registration exists, you have its client and
tenant ids, and it has no client secret.

### 3. Add a federated credential for this repository

This is the step that lets GitHub Actions authenticate as that application
without any shared secret. Entra will accept a token that GitHub minted, for
this repository, for this environment, and for nothing else.

1. On the app registration, go to **Certificates & secrets** > **Federated
   credentials** > **Add credential**.
2. Choose the **GitHub Actions deploying Azure resources** scenario.
3. Fill in:
   - **Organization**: `shakenfist`
   - **Repository**: `hunkydory`
   - **Entity type**: **Environment** — not Branch, and not Tag.
   - **Environment name**: `release`
4. Give the credential a name and save it.

**What must be true:** the credential's subject identifier reads exactly
`repo:shakenfist/hunkydory:environment:release`, its issuer is
`https://token.actions.githubusercontent.com`, and its audience is
`api://AzureADTokenExchange`. The portal shows all three after saving;
check them rather than assuming, because the entity type is easy to
misselect and a Branch-scoped credential will simply refuse every real
release with an unhelpful error.

Those three values are also what `tools/marketplace-token.mjs` presents. If
the audience ever differs, it is the constant `EXCHANGE_AUDIENCE` in that
file that has to agree.

### 4. Add the application to the Marketplace publisher

The application can now prove who it is, but it still has no permission to
publish. Marketplace permissions are managed per publisher.

1. Return to the
   [Marketplace publisher management page](https://marketplace.visualstudio.com/manage)
   and open the `shakenfist` publisher.
2. Find its members or permissions list, and add the app registration from
   step 2 as a member, searching for it by the name you gave it.
3. Give it the least role that can publish a new version of an existing
   extension — **Contributor** at the time of writing. **Owner** is not
   needed and should not be granted.

**What must be true:** the app registration appears as a member of the
`shakenfist` publisher with a role that permits publishing.

This step is the one most likely to have moved: if the publisher management
page offers no way to add an application, the Azure DevOps organisation
behind the publisher is where its permissions live, and the app registration
is added there as a service principal instead.

### 5. Create the tag-protected `release` environment

**Do this before pushing the first release tag.** If a `v*` tag is pushed
before this environment exists, GitHub auto-creates the environment
*unprotected* to satisfy `environment: release`, and the run proceeds
against an environment with no tag rule and no variables.

With the Entra setup above, an unprotected environment no longer leaks
anything — there is no secret on it, and Entra refuses a token to a subject
that does not match. The failure is a confusing broken release rather than a
disclosure. Set it up first anyway; there is no reason to find out.

1. Go to **Settings** > **Environments** on
   `github.com/shakenfist/hunkydory`.
2. Click **New environment**, name it `release`, and click **Configure
   environment**.
3. Under **Deployment branches and tags**, select **Selected branches and
   tags** and add a rule for pattern `v*`. Leave **Required reviewers**
   unset — this repository does not gate releases on manual approval, only
   on tag protection.
4. Click **Save protection rules**.
5. Under **Environment variables** — *variables*, not secrets — add:
   - `AZURE_CLIENT_ID`: the Application (client) ID from step 2.
   - `AZURE_TENANT_ID`: the Directory (tenant) ID from step 2.

Neither value is confidential; they identify the application, they do not
authenticate as it. They are on the environment rather than the repository
so that everything this job needs is configured in one place and moves
together.

**What must be true:** the `release` environment exists, is restricted to
`v*` tags, carries those two variables, and carries no secrets.

### 6. Protect the repository's tags

`release.yml` triggers on any `v*` tag. Without a ruleset, anyone who can
push to the repository can start a publish under the `shakenfist` publisher
id from any ref. Add a tag ruleset restricting who may create `v*` tags.
This is tracked as issue #21.

## What the Workflow Then Does

`release.yml` triggers on push of a tag matching `v*` and runs three jobs:

1. **`build`**, on `[self-hosted, static]`: checks out the tag, checks that
   the tag matches the version in `package.json`, runs `npm ci` and `npm run
   package` (`vsce package`), and uploads the resulting `.vsix` as a workflow
   artifact.
2. **`publish-marketplace`**, on `[self-hosted, vm, debian-13-docker, s]`,
   with `environment: release`: downloads the artifact from `build` and runs
   `tools/publish-marketplace.sh`, which does the rest inside a pinned
   `node:22` container. It is the only job that can obtain a publishing
   credential.
3. **`github-release`**, on `[self-hosted, static]`: attaches the same
   artifact to a GitHub Release, and runs only once the Marketplace publish
   has succeeded.

Four details are deliberate:

- **The runner split.** The `static` pool that `build` and `github-release`
  run on is a shared, non-ephemeral runner used by every repository in both
  the `shakenfist` and `mach33labs` GitHub organisations. A credential
  obtained in a job on that pool is exposed to every other repository's jobs
  that happen to land on the same machine. `publish-marketplace` runs
  instead on an ephemeral VM.
- **The container.** That VM lane carries neither node nor npm — this was
  measured, in run 35141854203, after an earlier version of this workflow
  asserted the opposite in a comment and could never have published.
  `tools/publish-marketplace.sh` supplies the runtime from a `node:22`
  image pinned by digest. That also resolves a second problem: several of
  `vsce`'s transitive Azure dependencies declare `engines.node ">=22.0.0"`
  while the fleet's runners carry node 20.
- **`npm ci --ignore-scripts`, not a bare `npm ci`.** A bare `npm ci` runs
  `preinstall`, `postinstall` and friends from every package in the tree,
  which is exactly the kind of arbitrary code a publishing credential should
  not be anywhere near. `--ignore-scripts` removes that while still
  installing the lockfile-pinned `vsce` the job then runs — which is why it
  installs at all rather than reaching for `npx @vscode/vsce`, since that
  would fetch whatever version is newest at publish time rather than the one
  this repository has tested against. The install also runs before the
  token is minted, and with the OIDC request variables removed from its
  environment, so there is no credential present for it to reach.
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
   `.vsix`, `publish-marketplace` ships it to the Marketplace, and
   `github-release` attaches it to a new GitHub Release.
4. Confirm the new version shows up on the
   [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=shakenfist.hunkydory)
   — Marketplace indexing can lag a few minutes behind a successful
   `vsce publish`.

## Troubleshooting

### `AZURE_CLIENT_ID is not set`, or the same for `AZURE_TENANT_ID`

The `release` environment is missing its variables, or they were added as
*secrets* rather than variables — the workflow reads them through the
`vars` context, which does not see secrets. Step 5.

### `ACTIONS_ID_TOKEN_REQUEST_URL is not set`

GitHub did not mint an OIDC token for the job, which means the job is
missing `permissions: id-token: write`. This is a workflow defect rather
than a configuration one; the line is in `release.yml`'s
`publish-marketplace` job and nothing else in the repository needs it.

### Entra returns `AADSTS700213` or "No matching federated identity record"

The federated credential's subject does not match what GitHub sent. The
subject GitHub mints for this job is
`repo:shakenfist/hunkydory:environment:release`. The usual causes, in order
of likelihood: the credential was created with entity type **Branch** or
**Tag** instead of **Environment**; the environment name was typed with
different capitalisation; or the job lost its `environment: release` line,
in which case GitHub sends a ref-based subject instead. Step 3.

### The token is minted but `vsce publish` reports a permission error

Authentication worked and authorisation did not: the application is not a
member of the `shakenfist` publisher, or its role does not permit
publishing. Step 4. Confirm also that the publisher id is exactly
`shakenfist`, matching `package.json`.

### `publish-marketplace` fails pulling or running the container

The job needs a docker daemon, which is what the `debian-13-docker` half of
its runner label selects. If the label was changed, or the run was retried
on a lane without docker, this is where it shows up. The image is pinned by
digest in `tools/publish-marketplace.sh`; a digest that no longer exists
upstream fails here too, and is fixed by pulling the current
`node:22-trixie-slim` and recording its new digest.

### Tag pushed but no workflow run appears

Check the tag actually matches `v*` (e.g. `v0.1.0`, not `0.1.0` or
`release-0.1.0`) — `release.yml`'s trigger and the environment's deployment
tag rule both key off that exact pattern.
