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
#
# The dispatch is exhaustive on purpose. This file is deliberately two
# programs, and an unrecognised stage -- a typo, or the variable surviving
# in an exported environment -- must not fall through to the container half
# and run it against paths that exist only inside a container.
stage="${HUNKYDORY_PUBLISH_STAGE:-host}"
case "${stage}" in
    host|container) ;;
    *) die "unknown stage: ${stage}" ;;
esac

if [ "${stage}" = "host" ]; then
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

    # Derived from this file's own location rather than from
    # `git rev-parse`, matching tools/check-node.sh. It needs no external
    # tool and does not care about the caller's directory -- and git is
    # exactly the class of assumption this file's header is about:
    # actions/checkout falls back to a REST tarball when git is missing or
    # too old, which leaves no .git at all.
    repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

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

# From here down we are inside the container, where the host stage passes
# the mount point as the single argument.
vsix_dir="${1:-/vsix}"
shopt -s nullglob
vsix=( "${vsix_dir}"/*.vsix )
[ "${#vsix[@]}" -eq 1 ] || die "expected one .vsix in ${vsix_dir}, got ${#vsix[@]}"

# Mint first, before anything else runs, so that the two ACTIONS_ variables
# can be stripped from everything after it. They are a credential in their
# own right -- they are what mints this token, and they keep minting for the
# life of the job -- and the code most worth keeping them away from is vsce
# and its 291 packages, not `npm ci --ignore-scripts`, which executes no
# package code at all. An earlier revision of this script had the order the
# other way round, which applied the protection to the harmless command and
# dropped it for the risky one.
#
# marketplace-token.mjs uses only node 22's global fetch, so it needs no
# node_modules and can run before the install.
#
# `token` is a plain shell variable, deliberately not exported: a child
# process does not inherit it, so it reaches vsce only where it is named
# explicitly below.
token=$(node tools/marketplace-token.mjs)

# Ask the Actions runner to redact it from the log. GitHub auto-masks
# values that came from the `secrets` context, and this one deliberately
# never does, so nothing would redact it otherwise -- it would be an
# unmasked credential with publish rights under the shakenfist publisher
# id, one stray `set -x` or verbose HTTP error away from a public log.
# Stdout from inside the container is still the step's log, so the workflow
# command is honoured here.
echo "::add-mask::${token}"

# --ignore-scripts, not a bare npm ci: a bare npm ci runs preinstall,
# postinstall and friends from every package in the tree. The install
# happens at all, rather than `npx @vscode/vsce`, so that the version
# published with is the lockfile-pinned one this repository tested against.
env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    npm ci --ignore-scripts

# VSCE_PAT is vsce's environment variable for -p and the name survives, but
# what it holds is an Entra access token good for about an hour, not an
# Azure DevOps personal access token. Passed by environment rather than on
# the command line so it does not appear in the process list.
#
# --packagePath, never a bare `vsce publish`: a bare publish repackages
# from the working tree, which would ship something other than the artifact
# the build job built and the github-release job attaches.
VSCE_PAT="${token}" \
    env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    node_modules/.bin/vsce publish --packagePath "${vsix[0]}"
