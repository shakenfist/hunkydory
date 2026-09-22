#!/bin/bash
#
# Build the .vsix that release.yml publishes, in a pinned container.
#
# Called by .github/workflows/release.yml's build job, which is the only
# caller. Takes no arguments. Leaves the .vsix in the repository root,
# where the job's upload-artifact step finds it.
#
# This exists because of issue #23. The build job used to run a bare
# `npm ci` directly on [self-hosted, static] -- the persistent bare-metal
# pool shared by every repository in both the shakenfist and mach33labs
# organisations, with filesystem and process state that outlives a job.
# No publishing credential is present in that job, by design, and that is
# the point of release.yml's three-job split. But the .vsix the publish
# job then signs and ships is produced here, so a compromise of the pool
# reached the artifact even though it could not reach the token. The
# argument for keeping the publish job off that pool applies to the
# artifact by the same reasoning.
#
# Two changes together, not one:
#
# * The job moved to [self-hosted, vm, debian-13-docker, s], the same
#   ephemeral VM lane publish-marketplace.sh uses, so the workspace the
#   artifact is built in does not outlive the run. `--ignore-scripts`
#   alone would have narrowed the exposure without closing it.
# * The install is `npm ci --ignore-scripts`, so no package in the tree
#   gets to run preinstall or postinstall. Nothing here needs them --
#   measured in a clean container before this was written, and the
#   likeliest candidate, Biome's native binary, arrives as a prebuilt
#   platform package rather than being built on install. If a future
#   dependency does need a lifecycle script, it will fail loudly here
#   rather than silently ship something different.
#
# The runtime comes from the container rather than the lane because plain
# debian-13 carries neither node nor npm -- measured in run 35141854203,
# not assumed. See tools/container-image.sh for the pin, and
# tools/publish-marketplace.sh, whose structure this follows.
#
# Usage:
#   tools/build-vsix.sh
#
# Environment:
#   HUNKYDORY_RELEASE_TAG  the tag this is a release of, e.g. v0.1.0.
#                          Must be set. Empty means "not a release",
#                          which is what a workflow_dispatch run is, and
#                          skips the version check. Unset is an error
#                          rather than a synonym for empty: see the check
#                          in the host stage for why. To run this by hand
#                          outside CI, pass HUNKYDORY_RELEASE_TAG= .

set -euo pipefail

die() {
    echo "build-vsix: $*" >&2
    exit 1
}

# Derived from this file's own location rather than from `git rev-parse`,
# matching tools/publish-marketplace.sh and tools/check-node.sh. It needs
# no external tool and does not care about the caller's directory -- and
# git is exactly the class of assumption worth avoiding here:
# actions/checkout falls back to a REST tarball when git is missing or too
# old, which leaves no .git at all, and the container carries no git
# either.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# The script runs twice: once on the runner to set the container up, and
# once inside it to do the work. Re-entering the same file keeps the
# container's command a single path rather than a shell one-liner embedded
# in a docker run, which is the same reason the fleet keeps CI logic in
# tools/ rather than in workflow steps.
#
# The dispatch is exhaustive on purpose, as in publish-marketplace.sh. An
# unrecognised stage -- a typo, or the variable surviving in an exported
# environment -- must not fall through to the container half and run it
# against paths that exist only inside a container.
stage="${HUNKYDORY_BUILD_STAGE:-host}"
case "${stage}" in
    host|container) ;;
    *) die "unknown stage: ${stage}" ;;
esac

if [ "${stage}" = "host" ]; then
    [ "$#" -eq 0 ] || die "usage: $0"

    # Set-but-empty is the documented way to say "not a release". Unset
    # is not: the only way it happens is that release.yml's env: key was
    # deleted, renamed or mis-templated, and treating that as "not a
    # release" would silently turn the version check below into a no-op.
    # The symptom would then be the wrong version on the Marketplace,
    # discovered by a user. Checked here rather than in the container so
    # it fails before an image is pulled.
    : "${HUNKYDORY_RELEASE_TAG?must be set; set it empty to build without a release tag}"

    # Checked here rather than beside the version comparison it belongs
    # with, because it is the half that needs no node: the lane has none,
    # so anything requiring it has to wait for the container. Failing on
    # the host costs nothing and saves an image pull.
    #
    # release.yml only triggers on `v*`, so this can currently only fail
    # by mistake -- which is the point, since catching a mistake is the
    # whole job of the version check. Without it `${tag#v}` below is a
    # no-op on a tag that does not start with v, and the comparison
    # silently runs against the wrong string; the `refs/tags/v` strip this
    # replaced failed closed on its own. Not inherited from a trigger
    # filter in another file.
    case "${HUNKYDORY_RELEASE_TAG}" in
        ""|v*) ;;
        *) die "release tag ${HUNKYDORY_RELEASE_TAG} does not start with v" ;;
    esac

    # IMAGE_TAG and IMAGE. Sourced inside this branch rather than at the
    # top of the file because only the host stage starts a container;
    # the container stage has no use for the pin, and not executing a
    # file is better than executing one that does nothing. One file,
    # shared with tools/publish-marketplace.sh, rather than a copy of
    # the digest in each; its header says why, and is where
    # renovate.json's customManager points.
    # shellcheck source=tools/container-image.sh
    source "${repo_root}/tools/container-image.sh"

    echo "build-vsix: building via ${IMAGE_TAG}"

    # --user keeps npm ci, tsc and vsce from leaving root-owned files in
    # the workspace -- including the .vsix the next step uploads. HOME and
    # the npm cache go to /tmp because that user has no home directory
    # inside the container.
    #
    # No --volume for an output directory: `vsce package` writes the .vsix
    # into the working directory, which is the mounted workspace, so it is
    # already where the job's upload-artifact step looks for it.
    exec docker run --rm \
        --user "$(id -u):$(id -g)" \
        --env HUNKYDORY_BUILD_STAGE=container \
        --env HOME=/tmp \
        --env npm_config_cache=/tmp/npm-cache \
        --env HUNKYDORY_RELEASE_TAG \
        --volume "${repo_root}:/src" \
        --workdir /src \
        "${IMAGE}" \
        /src/tools/build-vsix.sh
fi

# From here down we are inside the container.

# vsce publishes whatever version is inside the .vsix, and nothing derives
# that version from the tag the way the fleet's Python projects derive it
# from setuptools_scm. So a tag of v0.2.0 pushed while package.json still
# said 0.1.0 would quietly publish 0.1.0 again -- or fail on the
# Marketplace as a duplicate, long after the mistake.
#
# publish-marketplace.sh checks its environment on the host, before
# anything is pulled, and this check deliberately does not: it needs node
# to read package.json, and the lane has none. So it runs here instead,
# still before anything is installed or built, which is what it is for.
tag="${HUNKYDORY_RELEASE_TAG:-}"
if [ -n "${tag}" ]; then
    # Checked again, not merely checked earlier. The host stage runs this
    # too, and for a different purpose -- there it buys a failure before an
    # image is pulled -- but this file is deliberately two programs and
    # HUNKYDORY_BUILD_STAGE is an ordinary environment variable, so the
    # container stage can be entered without the host stage ever having
    # run. test/scripts.test.ts does exactly that. An earlier revision of
    # this comment claimed the strip was safe *because* the host stage had
    # checked, which is true only of the path through the workflow; the
    # check needs no node, so enforcing it in both places costs nothing.
    case "${tag}" in
        v*) ;;
        *) die "release tag ${tag} does not start with v" ;;
    esac

    want="${tag#v}"
    have=$(node -p 'require("./package.json").version')
    [ "${want}" = "${have}" ] || die "tag ${tag} != package.json ${have}"
fi

# --ignore-scripts, not a bare npm ci: see the header. The lockfile is
# committed and npm ci honours it, which is what the fleet's
# npm-pin-indirect-dependencies criterion checks CI for.
npm ci --ignore-scripts

# vscode:prepublish runs `npm run build` first, so this both compiles and
# packages.
npm run package
