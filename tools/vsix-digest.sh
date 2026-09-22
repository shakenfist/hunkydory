#!/bin/bash
#
# Print, or verify, the sha256 of the one .vsix in a directory.
#
# Called by .github/workflows/release.yml from all three jobs: `build`
# records the digest of what it produced, and `publish-marketplace` and
# `github-release` each check the artifact they downloaded against it
# before doing anything with it.
#
# This exists because of issue #32. `release.yml` had three jobs handing a
# .vsix to each other through the artifact store and nothing anywhere
# comparing the bytes, so the file attached to the GitHub Release -- which
# RELEASE-SETUP.md offers as the copy of what shipped -- could differ from
# the one sent to the Marketplace and no check would have noticed. An
# earlier revision of release.yml's header asserted that github-release
# "only attaches bytes the other two jobs already produced and verified".
# Nothing verified anything. This is what makes that sentence true.
#
# It is deliberately not a trust boundary on its own, but be precise about
# why. The digest is only as trustworthy as the `build` job that computed
# it, and the check only as trustworthy as the runner running it -- a
# compromised consumer does not need to forge anything, it can simply not
# look. What it does cover is anything that can reach the .vsix between
# the jobs without being able to alter a completed job's outputs: GitHub
# fixes `needs.<job>.outputs.*` when the producing job finishes, so a
# concurrent run holding `actions: write`, which can delete and re-upload
# an artifact by name, cannot move the value it is checked against. That,
# artifact-store corruption, and the ordinary mistake of attaching the
# wrong file are the cases this exists for. The control that keeps a job
# off shared infrastructure is its runner label, not this script.
#
# Usage:
#   tools/vsix-digest.sh <directory>                   # prints the sha256
#   tools/vsix-digest.sh <directory> <expected sha256> # verifies it
#
# The second form prints nothing on success and exits non-zero on any
# disagreement.

set -euo pipefail

die() {
    echo "vsix-digest: $*" >&2
    exit 1
}

# Spelled as an if rather than `A && B || die`, which reads as if-then-else
# and is not: with two conditions the die runs when the first passes and the
# second fails, which is right here but only by accident of ordering.
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    die "usage: $0 <directory> [expected sha256]"
fi

dir=$(cd "$1" 2>/dev/null && pwd) || die "no such directory: $1"

# Same shape as the count in tools/publish-marketplace.sh, and for the same
# reason: a glob that matched nothing would otherwise reach sha256sum as a
# literal path, and a glob that matched several would silently digest
# whichever sorted first.
shopt -s nullglob
vsix=( "${dir}"/*.vsix )
[ "${#vsix[@]}" -eq 1 ] || die "expected one .vsix in ${dir}, got ${#vsix[@]}"

# Read from stdin rather than passing the path, so the filename never
# appears in the output: GNU sha256sum escapes a name containing a newline
# or a backslash by prefixing the whole line with one, and `cut` would
# then return 65 characters. That fails closed wherever it is used, but
# not arising at all is better than failing closed.
actual=$(sha256sum < "${vsix[0]}" | cut -d' ' -f1)

if [ "$#" -eq 1 ]; then
    echo "${actual}"
    exit 0
fi

expected="$2"

# Checked for shape before it is compared. An expected value that is empty
# or malformed means the workflow expression that produced it resolved to
# nothing -- a renamed job, a dropped `outputs:` block, a typo in a `needs`
# reference -- and comparing it would report "the artifact does not match"
# for what is really "nobody told me what to match". The two want different
# fixes, so they get different messages. Quoting in the caller is what stops
# an empty value from vanishing into the argument count instead.
# ${expected//[0-9a-f]/} deletes every lowercase hex digit; anything left
# over is a character a sha256 cannot contain. Paired with the length, that
# is an exact check rather than a prefix one.
if [ "${#expected}" -ne 64 ] || [ -n "${expected//[0-9a-f]/}" ]; then
    die "expected sha256 is empty or malformed (${#expected} characters): '${expected}'"
fi

[ "${expected}" = "${actual}" ] || die \
    "$(basename "${vsix[0]}") is ${actual}, expected ${expected}"
