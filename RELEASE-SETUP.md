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
  only two identifiers. Three separate things bind publishing to `v*` tags:
  the workflow's `on: push: tags` trigger, the job's own `if:` guard, and
  the environment's tag rule. The first two are one edit away from being
  changed by anyone who can change the workflow; the environment rule is
  the one that survives that, which is why it exists. What none of them
  constrain is *who* may create the tag — an environment-scoped OIDC
  subject names the environment and carries no ref, so Entra cannot
  distinguish one ref from another, and the ability to create a `v*` tag is
  therefore the ability to publish. Step 6 is where that is addressed.
- **Split build/publish jobs**: Building the `.vsix` and publishing it happen
  in different jobs, so the publishing credential is present in only one of
  them. Neither runs on the shared static runner pool. See
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

These steps are ordered, and steps 5 and 6 must both be complete before any
`v*` tag is pushed.

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
   page. You will need both in steps 4 and 5:
   - **Application (client) ID** → becomes `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → becomes `AZURE_TENANT_ID`

**Do not create a client secret.** If you find yourself on the "Client
secrets" tab, you are about to build the thing this setup exists to avoid —
a stored credential with an expiry date. The next step is what replaces it.
(Step 4 needs one for the few minutes it takes to read an identifier, and
deletes it again there. That is the only exception.)

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

The obstacle here is finding the application in the publisher's member
picker at all. It does not resolve an app registration by name, by client
id, by the service principal's object id, or by any Azure resource id. The
only identifier it accepts is the application's **Azure DevOps profile
id** — a separate GUID that appears nowhere in the Entra portal and can
only be read by presenting a token minted as the application itself.

1. Read the profile id:

   ```bash
   AZURE_CLIENT_ID=<from step 2> AZURE_TENANT_ID=<from step 2> \
       tools/marketplace-profile-id.sh
   ```

   The script asks for a client secret, and step 2 said not to create one.
   This is the single exception: the federated credential from step 3
   trusts GitHub's issuer and nothing else, so there is no way to
   authenticate as this application from a workstation without one. Create
   a secret under **Certificates & secrets** > **Client secrets**, run the
   script, and **delete the secret immediately afterwards**. Nothing in the
   finished setup depends on it, and it should outlive this step by
   minutes.

2. Open the
   [Marketplace publisher management page](https://marketplace.visualstudio.com/manage),
   select the `shakenfist` publisher, and add a member — pasting the
   profile id into the search box.
3. Give it the least role that can publish a new version of an existing
   extension — **Contributor** at the time of writing. **Owner** is not
   needed and should not be granted.

The member looks wrong once it is added, and is not. The application has no
email address, and its display name is the tenant id and the service
principal's object id joined by a backslash, rendering as something like
`51077808-…\aea1b5df-…`. There is no friendly name to confirm against, so
confirm against the profile id the script printed.

**What must be true:** the `shakenfist` publisher's member list contains an
entry whose profile id matches the one the script printed, with a role that
permits publishing.

One thing here is worth recording, because the public advice conflicts on
it. The application needed no Azure DevOps organisation membership and no
Azure subscription role assignment: the profile is created on demand the
first time the identity presents a Marketplace-scoped token, and the call
the script makes is what creates it. Advice that says to add the service
principal as a user in an Azure DevOps organisation first is describing a
different API, and is not needed here.

### 5. Create the tag-protected `release` environment

**Do this before pushing the first release tag.** If a `v*` tag is pushed
before this environment exists, GitHub auto-creates the environment
*unprotected* to satisfy `environment: release`.

That particular case fails closed, and it is worth knowing which way round
this goes before you need to reason about it during an incident. An
auto-created environment has no variables either, so `vars.AZURE_CLIENT_ID`
and `vars.AZURE_TENANT_ID` arrive empty and
`tools/publish-marketplace.sh` exits with `AZURE_CLIENT_ID is not set`
before docker is even invoked. No token is minted and nothing is published.

The case that does bite is an environment created *carelessly later* —
variables added so that publishing works, tag rule forgotten. Then the
OIDC subject GitHub mints names the environment and carries no ref, Entra
cannot tell a run on `main` from a run on a tag, and any run that reaches
the job gets a genuine publishing token. Create the environment with its
tag rule in the same sitting, and never add the variables to an
environment whose protection rules you have not already saved.

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

`release.yml` triggers on any `v*` tag, and step 5 explained why the
environment's tag rule is the only thing deciding which refs reach the
publish job. This is the other half of that: without a ruleset, anyone who
can push to the repository can create a `v*` tag and so start a publish
under the `shakenfist` publisher id. Add a tag ruleset restricting who may
create `v*` tags. Tracked as issue #21.

**Do this before the first release, not after.** Until it exists, the
authority to publish under the `shakenfist` publisher id is held by
everyone with write access to the repository. The credential is
short-lived; the ability to mint one is not rationed. This was equally
true of the PAT setup — it is not a regression introduced by moving to
Entra — but moving to Entra is what makes it the *only* remaining
distinction between "a release" and "anyone with push".

## What the Workflow Then Does

`release.yml` triggers on push of a tag matching `v*` and runs three jobs:

1. **`build`**, on `[self-hosted, vm, debian-13-docker, s]`: checks out the
   tag and runs `tools/build-vsix.sh`, which inside a pinned `node:22`
   container checks that the tag matches the version in `package.json`, runs
   `npm ci --ignore-scripts` and then `npm run package` (`vsce package`). The
   job uploads the resulting `.vsix` as a workflow artifact.
2. **`publish-marketplace`**, on `[self-hosted, vm, debian-13-docker, s]`,
   with `environment: release`: downloads the artifact from `build` and runs
   `tools/publish-marketplace.sh`, which does the rest inside a pinned
   `node:22` container. It is the only job that can obtain a publishing
   credential.
3. **`github-release`**, on `[self-hosted, static]`: attaches the same
   artifact to a GitHub Release, and runs only once the Marketplace publish
   has succeeded.

Four details are deliberate:

- **The runner split.** The `static` pool is a shared, non-ephemeral runner
  used by every repository in both the `shakenfist` and `mach33labs` GitHub
  organisations, with filesystem and process state that outlives a job. A
  credential obtained in a job on that pool is exposed to every other
  repository's jobs that happen to land on the same machine, so
  `publish-marketplace` runs on an ephemeral VM instead.

  `build` runs there too, and for a related but distinct reason: it holds no
  credential, but the `.vsix` it produces is what `publish-marketplace`
  later ships, so a compromise of the pool reached the artifact even where
  it could not reach the token. It used to run a bare `npm ci` on `static`;
  issue #23 is that argument in full. `github-release` is the one job still
  on `static`, because it only attaches bytes the other two produced.
- **The container.** That VM lane carries neither node nor npm — this was
  measured, in run 35141854203, after an earlier version of this workflow
  asserted the opposite in a comment and could never have published.
  `tools/build-vsix.sh` and `tools/publish-marketplace.sh` each supply the
  runtime from a `node:22` image pinned by digest, sharing that pin through
  `tools/container-image.sh` so there is one digest to bump rather than two
  that can drift. The container also resolves a second problem: several of
  `vsce`'s transitive Azure dependencies declare `engines.node ">=22.0.0"`
  while the fleet's runners carry node 20.
- **`npm ci --ignore-scripts`, not a bare `npm ci`.** Both jobs install,
  and a bare `npm ci` runs `preinstall`, `postinstall` and friends from
  every package in the tree. In `publish-marketplace` that is exactly the
  kind of arbitrary code a publishing credential should not be anywhere
  near. In `build` there is no credential to reach, but the same code
  would be running where the bytes users install are produced, which is
  what issue #23 was about. Nothing in this repository's dependency tree
  needs a lifecycle script; that was measured in a clean container rather
  than assumed, and Biome's native binary — the likeliest candidate —
  arrives as a prebuilt platform package rather than being built on
  install.

  Each job installs at all, rather than reaching for `npx @vscode/vsce`,
  so that the `vsce` it runs is the lockfile-pinned one this repository
  has tested against rather than whatever is newest at the time. `build`
  runs it through `npm run package`; `publish-marketplace` runs
  `vsce publish`. In `publish-marketplace` the install also happens
  before the token is minted, and with the OIDC request variables removed
  from its environment, so there is no credential present for it to
  reach.
- **`--packagePath`, never bare `vsce publish`.** Bare `vsce publish`
  repackages the working tree at publish time. Using `--packagePath` against
  the artifact `build` produced means the exact bytes that were built (and
  that could, in principle, be inspected before publish) are the bytes that
  ship — not a second, potentially different, repackaging done later on a
  different runner.

## Cutting a Release

1. Bump the version in `package.json` and `package-lock.json` together:

   ```bash
   npm version --no-git-tag-version 0.1.1
   ```

   That edits both files — the lockfile carries the package's own version
   in two places, at its root and under `packages[""]` — and, unlike a bare
   `npm version`, neither commits nor tags. The tag is pushed from
   `develop` in step 2, once the bump has been reviewed; a tag created here
   would be on the wrong commit. Take the bump through the normal PR
   process.

   Editing `package.json` by hand instead leaves the lockfile's version
   behind, and nothing will tell you: `npm ci` compares dependencies, not
   the package's own version field, so the release still builds and still
   publishes the correct version. The lockfile is simply wrong about which
   version it pins for.

   Dependency drift is the kind that bites, and it bites before a release
   rather than during one. `npm ci` refuses a lockfile that disagrees with
   `package.json`'s dependencies, with `Missing: <package> from lock file`,
   and `ci.yml` runs `npm ci` on every pull request. A lockfile wrong in
   that way cannot reach `develop` green, so by the time you are tagging,
   this has already been checked for you.

   The first release is the exception to all of this: `package.json`
   already declares `0.1.0`, so there is nothing to bump and step 2 is
   where you start.

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

### The publisher's member search finds nothing

The picker resolves only an application's Azure DevOps profile id. A name,
a client id, an object id and an Azure resource id all return no results,
and it does not say why. Step 4 reads the profile id.

### The token is minted but `vsce publish` reports a permission error

Authentication worked and authorisation did not: the application is not a
member of the `shakenfist` publisher, or its role does not permit
publishing. Step 4. Confirm also that the publisher id is exactly
`shakenfist`, matching `package.json`.

### `build` or `publish-marketplace` fails pulling or running the container

Both jobs need a docker daemon, which is what the `debian-13-docker` half of
their runner label selects. If the label was changed, or the run was retried
on a lane without docker, this is where it shows up. The image is pinned by
digest in `tools/container-image.sh`; a digest that no longer exists
upstream fails here too, and is fixed by pulling the current
`node:22-trixie-slim` and recording its new digest. Both jobs read the same
pin, so a stale digest fails both.

### Tag pushed but no workflow run appears

Check the tag actually matches `v*` (e.g. `v0.1.0`, not `0.1.0` or
`release-0.1.0`) — `release.yml`'s trigger and the environment's deployment
tag rule both key off that exact pattern.
