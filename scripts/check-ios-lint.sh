#!/usr/bin/env bash
# Lint the iOS sources and prove the design-token rules still fire.
set -euo pipefail
cd "$(dirname "$0")/../app-ios"
swiftlint lint --strict --quiet --config .swiftlint.yml
fired="$(swiftlint lint --quiet --config .swiftlint.yml LintFixtures/Bad.swift 2>/dev/null | grep -cE 'no_raw_(color|font_size|spacing)' || true)"
if [ "$fired" -lt 6 ]; then
  echo "token lint rules fired $fired times on LintFixtures/Bad.swift, expected 6" >&2
  exit 1
fi
echo "ios lint ok"
