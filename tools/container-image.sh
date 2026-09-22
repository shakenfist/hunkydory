# shellcheck shell=bash
# shellcheck disable=SC2034
#
# The two directives above are about this file being a fragment rather
# than a program. It has no shebang and is never executed, so shellcheck
# has to be told which shell to read it as; and IMAGE is used by the two
# scripts that source it rather than here, which standalone looks like an
# unused assignment. Neither suppresses a real finding -- and note that
# SC2034 only appeared once the file was `git add`ed, because pre-commit
# lints what git knows about, so a clean run before staging a new file
# proves less than it looks like it does.
#
# The container image that tools/build-vsix.sh and
# tools/publish-marketplace.sh run node in. Sourced by both, never
# executed -- there is no shebang and the file is not executable.
#
# One file rather than a copy of these two lines in each script. Both
# scripts want the same runtime for the same reason, and the digest is a
# supply-chain control: two copies is two things to bump, and the failure
# of bumping only one is that the build and the publish silently stop
# agreeing about what node they ran.
#
# Pinned by digest as well as by tag, matching tools/mermaid-lint.sh in
# shakenfist/development: a tag is mutable, and these run a third-party
# container on a runner with a docker daemon. The tag is for a human
# reading this; the digest is what pins. trixie rather than bookworm so
# the container's libc matches the Debian 13 host it runs on.
#
# Renovate's stock managers do not read a docker reference out of a shell
# script, so renovate.json carries a customManager that does. It matches
# these two lines as an adjacent pair: keep them adjacent, keep the
# quoting, and do not put a blank line or a comment between them, or the
# digest silently stops being updated.

IMAGE_TAG="node:22-trixie-slim"
IMAGE="${IMAGE_TAG}@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6"
