#!/bin/bash
# Run tools/editor-test.sh in a container, which is how CI runs it.
#
# The container brings everything the editor tests need and a runner does
# not have: a virtual display, Electron's libraries and a VS Code install.
# It also keeps an Electron started with --no-sandbox off the machine
# itself. The image is built here rather than pulled, from the node image
# tools/container-image.sh pins, and the VS Code it adds is checked against
# the digest below.
#
# Renovate does not know about VSCODE_VERSION. Bump it by hand, with the
# sha256hash from
#   https://update.code.visualstudio.com/api/versions/<version>/linux-x64/stable
# and keep it a release at least two weeks old.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# shellcheck source=tools/container-image.sh
. "${SCRIPT_DIR}/container-image.sh"

VSCODE_VERSION="1.140.0"
VSCODE_URL="https://update.code.visualstudio.com/${VSCODE_VERSION}/linux-x64/stable"
VSCODE_SHA256="d32031e9e213d59532af3cf32fcb8b357a1cdd10417967b4f5b5ba30436dc0dc"

TAG="hunkydory-editor-test:${VSCODE_VERSION}"

docker build --quiet \
    --tag "${TAG}" \
    --build-arg BASE="${IMAGE}" \
    --build-arg VSCODE_URL="${VSCODE_URL}" \
    --build-arg VSCODE_SHA256="${VSCODE_SHA256}" \
    --file "${SCRIPT_DIR}/editor-test.Dockerfile" \
    "${SCRIPT_DIR}"

# As the calling user, so the build output it leaves in the checkout is not
# owned by root. --ignore-scripts for the reason tools/build-vsix.sh gives:
# nothing needs a lifecycle script, so nothing gets to run one.
#
# --init because xvfb-run waits for a signal from the X server that it never
# receives as PID 1, and would wait for it forever.
exec docker run --rm \
    --init \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    --env npm_config_cache=/tmp/npm-cache \
    --env VSCODE_BIN=/opt/vscode/code \
    --shm-size=1g \
    --volume "${PROJECT_ROOT}:/src" \
    --workdir /src \
    "${TAG}" \
    bash -c 'npm ci --ignore-scripts --silent && xvfb-run --auto-servernum tools/editor-test.sh'
