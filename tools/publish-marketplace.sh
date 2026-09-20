#!/bin/bash
#
# Publish an already-built .vsix to the VS Code Marketplace.
#
# Called by .github/workflows/release.yml's publish-marketplace job, which
# is the only caller. Takes one argument: a directory holding exactly one
# .vsix, which the job downloads from the build job's artifact.
#
# Two things about this job are unusual, and both come from phase 7b of the
# TypeScript onboarding plan in shakenfist/development.
#
# It runs in a container. The lane this job used to run on --
# [self-hosted, vm, debian-13, s] -- carries neither node nor npm, which
# was measured, not assumed (run 35141854203). The static pool has node,
# but this job holds a credential that can publish under the shakenfist
# publisher id and that pool is shared with every other repository in both
# organisations, so it is the one pool this job must not use. So the job
# moved to debian-13-docker, the fleet's docker-capable VM image, and the
# runtime comes from a pinned container instead of from the image. That
# also settles a second problem: @vscode/vsce's transitive Azure
# dependencies declare engines.node ">=22.0.0" against a fleet running
# node 20, and the container is node 22.
#
# It mints its own credential. There is no stored secret of any kind. The
# VSCE_PAT environment variable below is vsce's token-passing mechanism and
# holds the exchanged Entra access token, which lives about an hour -- it is
# not the Azure DevOps personal access token this replaced, and there is no
# secrets.VSCE_PAT in the workflow any more. See tools/marketplace-token.mjs
# for why the token is fetched by hand rather than by `vsce publish
# --azure-credential`, and for the two files to re-read when vsce is next
# bumped; and RELEASE-SETUP.md for what has to exist in Entra.
#
# Usage:
#   tools/publish-marketplace.sh <directory containing one .vsix>

set -euo pipefail

# Pinned by digest as well as by tag, matching tools/mermaid-lint.sh in
# shakenfist/development: a tag is mutable, and this runs a third-party
# container on a runner with a docker daemon. The tag is for a human
# reading this; the digest is what pins. trixie rather than bookworm so
# the container's libc matches the Debian 13 host it runs on. Renovate's
# stock managers do not read a docker reference out of a shell script, so
# this moves when somebody moves it.
IMAGE_TAG="node:22-trixie-slim"
IMAGE="${IMAGE_TAG}@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6"

die() {
    echo "publish-marketplace: $*" >&2
    exit 1
}

# The script runs twice: once on the runner to set the container up, and
# once inside it to do the work. Re-entering the same file keeps the
# container's command a single path rather than a shell one-liner embedded
# in a docker run, which is the same reason the fleet keeps CI logic in
# tools/ rather than in workflow steps.
if [ "${HUNKYDORY_PUBLISH_STAGE:-host}" = "host" ]; then
    [ "$#" -eq 1 ] || die "usage: $0 <directory containing one .vsix>"
    vsix_dir=$(cd "$1" 2>/dev/null && pwd) || die "no such directory: $1"

    # Counted here rather than in the container so the failure is reported
    # before anything is pulled or installed. A glob that matched nothing
    # would otherwise reach vsce as a literal path.
    shopt -s nullglob
    vsix=( "${vsix_dir}"/*.vsix )
    [ "${#vsix[@]}" -eq 1 ] || die "expected one .vsix in ${vsix_dir}, got ${#vsix[@]}"

    # Checked on the host for the same reason: a missing variable should
    # fail in a second rather than after an npm install. The two AZURE_
    # variables come from the release environment; the two ACTIONS_ ones
    # exist only because the job declares permissions: id-token: write,
    # and their absence almost always means that line was dropped.
    for required in AZURE_CLIENT_ID AZURE_TENANT_ID \
                    ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
        [ -n "${!required:-}" ] || die "${required} is not set"
    done

    repo_root=$(git rev-parse --show-toplevel)

    echo "publish-marketplace: publishing $(basename "${vsix[0]}") via ${IMAGE_TAG}"

    # --user keeps npm ci from leaving root-owned files in the workspace.
    # HOME and the npm cache go to /tmp because that user has no home
    # directory inside the container.
    exec docker run --rm \
        --user "$(id -u):$(id -g)" \
        --env HUNKYDORY_PUBLISH_STAGE=container \
        --env HOME=/tmp \
        --env npm_config_cache=/tmp/npm-cache \
        --env AZURE_CLIENT_ID \
        --env AZURE_TENANT_ID \
        --env ACTIONS_ID_TOKEN_REQUEST_URL \
        --env ACTIONS_ID_TOKEN_REQUEST_TOKEN \
        --volume "${repo_root}:/src" \
        --volume "${vsix_dir}:/vsix:ro" \
        --workdir /src \
        "${IMAGE}" \
        /src/tools/publish-marketplace.sh /vsix
fi

# From here down we are inside the container.
shopt -s nullglob
vsix=( /vsix/*.vsix )
[ "${#vsix[@]}" -eq 1 ] || die "expected one .vsix in /vsix, got ${#vsix[@]}"

# --ignore-scripts, not a bare npm ci: a bare npm ci runs preinstall,
# postinstall and friends from every package in the tree, and this
# container is about to hold a Marketplace credential. The install happens
# at all, rather than `npx @vscode/vsce`, so that the version published
# with is the lockfile-pinned one this repository tested against.
#
# The two ACTIONS_ variables are removed for the install. They are a
# credential in their own right -- they are what mints the Entra token
# below -- so nothing that runs before the token is needed should be able
# to reach them.
env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    npm ci --ignore-scripts

# VSCE_PAT is vsce's env var for -p and the name survives, but what it
# holds is an Entra access token good for about an hour, not an Azure
# DevOps personal access token. Passed by environment rather than on the
# command line so it does not appear in the container's process list.
VSCE_PAT=$(node tools/marketplace-token.mjs)
export VSCE_PAT

# --packagePath, never a bare `vsce publish`: a bare publish repackages
# from the working tree, which would ship something other than the artifact
# the build job built and the github-release job attaches.
node_modules/.bin/vsce publish --packagePath "${vsix[0]}"
