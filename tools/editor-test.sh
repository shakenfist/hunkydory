#!/bin/bash
# Run the tests that need a real editor host, against an installed VS Code.
#
# test/editor/ holds what npm test cannot reach: behaviour that lives in
# the editor's undo stack rather than in the counting rules. Each run gets
# a throwaway profile and disables every other extension, so neither the
# user's settings nor their extensions can change the outcome.
#
# Not part of pre-commit or CI yet: it opens a window, so it needs a
# display (run under `xvfb-run -a` on a headless machine) and a VS Code
# install. VSCODE_BIN overrides where that install is.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# The Electron binary itself, not the `code` launcher: the launcher hands
# off to a background process and exits 0 straight away, so it can never
# report a failure.
VSCODE_BIN="${VSCODE_BIN:-/usr/share/code/code}"
if [ ! -x "${VSCODE_BIN}" ]; then
    echo "No VS Code binary at ${VSCODE_BIN}; set VSCODE_BIN." >&2
    exit 1
fi
if [ -z "${DISPLAY}" ] && [ -z "${WAYLAND_DISPLAY}" ]; then
    echo "No display; run this under xvfb-run." >&2
    exit 1
fi

PROFILE="$(mktemp -d)"
trap 'rm -rf "${PROFILE}"' EXIT

(cd "${PROJECT_ROOT}" && npm run --silent build)

# --no-sandbox because a distribution install's chrome-sandbox is often not
# setuid, and Electron then refuses to start at all. What runs unsandboxed
# is a throwaway profile with no other extensions, showing only in-memory
# documents the test creates. The timeout is for a host that hangs (an
# activate() that never settles, say), which would otherwise never return.
timeout 300 "${VSCODE_BIN}" \
    --no-sandbox \
    --disable-gpu \
    --disable-extensions \
    --disable-workspace-trust \
    --skip-welcome \
    --skip-release-notes \
    --new-window \
    --user-data-dir="${PROFILE}/user" \
    --extensions-dir="${PROFILE}/extensions" \
    --extensionDevelopmentPath="${PROJECT_ROOT}" \
    --extensionTestsPath="${PROJECT_ROOT}/out/test/editor/undo.js"
