#!/usr/bin/env bash
# Refresh the vendored contract files from the upstream GeoNexus SDK repository.
#
# This SDK is published as a standalone repository, but it must validate against
# the *same* GeoCard schema as the Python and Rust SDKs. Rather than trust a
# hand-copy, the schema and the GeoMCP mock responses are vendored here and a
# test asserts they are byte-identical to `schemas/` and `contracts/mocks/`.
#
# Upstream source: muyang/GeoNexus-SDK
# Last synced from commit: 21c6af7b2f8963c9ba7297d1dea0a8716fe47665
#
# Usage: ./scripts/sync-contracts.sh /path/to/GeoNexus-SDK
set -euo pipefail
UPSTREAM="${1:?usage: sync-contracts.sh /path/to/GeoNexus-SDK}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cp "$UPSTREAM/schemas/geocard.schema.json" "$ROOT/schemas/geocard.schema.json"
cp "$UPSTREAM/schemas/geocard.schema.json" "$ROOT/src/geocard.schema.json"
rm -rf "$ROOT/contracts/mocks"
cp -R "$UPSTREAM/contracts/mocks" "$ROOT/contracts/mocks"
echo "synced from $UPSTREAM ($(git -C "$UPSTREAM" rev-parse --short HEAD 2>/dev/null || echo unknown))"
