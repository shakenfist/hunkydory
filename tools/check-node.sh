#!/bin/bash
# Run the build, the unit tests and Biome for hunkydory.
#
# Called by both pre-commit and (in phase 5) CI, so the two checks cannot
# drift from each other. Node runs natively here -- unlike ryll's
# scripts/check-rust.sh, there is no Docker wrapper, because keeping Rust
# toolchains off the host is a Rust-specific concern, not a node one.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

MODE="${1:-check}"  # "check" or "fix"

FAILED=0

echo "=== Checking hunkydory ==="

echo "Building..."
(cd "$PROJECT_ROOT" && npm run build) || FAILED=1

echo "Running unit tests..."
(cd "$PROJECT_ROOT" && npm test) || FAILED=1

echo "Running Biome..."
if [ "$MODE" = "fix" ]; then
    (cd "$PROJECT_ROOT" && npm run --silent lint:fix) || FAILED=1
else
    (cd "$PROJECT_ROOT" && npm run --silent lint) || FAILED=1
fi

echo ""

if [ "$FAILED" -ne 0 ]; then
    echo "Some checks failed!"
    exit 1
fi

echo "All checks passed!"
