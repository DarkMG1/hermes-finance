#!/usr/bin/env bash
# Local iOS gate: generate the project, lint, unit-test HermesKit, build the app for the simulator.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root/app-ios"
xcodegen generate --quiet
"$root/scripts/check-ios-lint.sh"
swift test --package-path HermesKit --quiet
xcodebuild -project Hermes.xcodeproj -scheme Hermes -destination 'generic/platform=iOS Simulator' -quiet build
echo "ios check ok"
