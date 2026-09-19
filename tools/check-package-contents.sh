#!/bin/bash
# Check that the .vsix would contain the extension, and only the extension.
#
# .vscodeignore is an allow-list, and the failure mode of an allow-list that
# is too narrow is silent: the build succeeds, the tests pass, the package is
# produced, and the published extension is missing a file that only fails at
# require() time on a user's machine. A push audit found exactly that --
# "!out/src/*.js" does not cross a directory separator, so a compiled module
# in a subdirectory of src/ was excluded from every package built.
#
# A unit test cannot express this. What ships is decided by vsce's matcher
# reading .vscodeignore, not by anything the TypeScript can reach, so the only
# honest check is to ask vsce. That is why this is a script run from CI rather
# than a case in test/.
#
# It checks both directions, because an allow-list can fail either way:
# everything compiled from src/ must be in the package (including a nested
# probe module this script creates, which is what the original defect would
# fail on), and nothing else may be, because the deny-list this list replaced
# shipped 24 files of repository infrastructure to every user.
#
# Run by .github/workflows/ci.yml, and by hand:
#     npm ci && tools/check-package-contents.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
cd "${PROJECT_ROOT}"

VSCE="node_modules/.bin/vsce"
if [ ! -x "${VSCE}" ]; then
    echo "${VSCE} is not installed; run npm ci first" >&2
    exit 1
fi

echo "=== Checking what the .vsix would contain ==="

npm run --silent build

# A module one directory below out/src/, which is what a nested module under
# src/ compiles to. Created here rather than committed under src/ because it
# must not become part of the extension, and because a probe that ships is
# indistinguishable from the bug it looks for. out/ is gitignored, and the
# trap removes it however this script exits.
PROBE_DIR="out/src/packaging-probe"
cleanup() { rm -rf "${PROBE_DIR}"; }
trap cleanup EXIT
mkdir -p "${PROBE_DIR}"
echo '// Temporary. See tools/check-package-contents.sh.' > "${PROBE_DIR}/probe.js"

listing="$("${VSCE}" ls)"
failed=0

# Every compiled module, nested ones included.
while IFS= read -r module; do
    if ! printf '%s\n' "${listing}" | grep -qxF "${module}"; then
        echo "MISSING from the package: ${module}"
        failed=1
    fi
done < <(find out/src -name '*.js' | sort)

# And nothing else. Note that a shell case pattern is not a pathname glob:
# "*" here does cross a directory separator, which is exactly the property
# .vscodeignore's "*" lacks and the reason this file exists.
while IFS= read -r entry; do
    case "${entry}" in
        package.json | README.md | LICENSE | out/src/*.js) ;;
        '') ;;
        *)
            echo "UNEXPECTED in the package: ${entry}"
            failed=1
            ;;
    esac
done <<< "${listing}"

echo ""

if [ "${failed}" -ne 0 ]; then
    echo "The package contents are wrong. .vscodeignore decides this; the"
    echo "comments in that file explain what its patterns do and do not match."
    echo ""
    echo "What vsce would ship:"
    printf '%s\n' "${listing}"
    exit 1
fi

echo "Package contents are correct."
