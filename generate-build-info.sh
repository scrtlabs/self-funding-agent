#!/bin/bash

# Generate build info for the agent
# This script creates a build-info.json file with version and git information

set -e

echo "📦 Generating build info..."

# Get package version
VERSION=$(node -p "require('./package.json').version")

# Get git commit hash (short)
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Get git commit hash (full)
GIT_COMMIT_FULL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

# Get git branch
GIT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Get git tag (if any)
GIT_TAG=$(git describe --tags --exact-match 2>/dev/null || echo "")

# Get build timestamp
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create build info JSON
cat > src/build-info.json << EOF
{
  "version": "${VERSION}",
  "gitCommit": "${GIT_COMMIT}",
  "gitCommitFull": "${GIT_COMMIT_FULL}",
  "gitBranch": "${GIT_BRANCH}",
  "gitTag": "${GIT_TAG}",
  "buildTime": "${BUILD_TIME}"
}
EOF

echo "✅ Build info generated:"
cat src/build-info.json

echo ""
echo "📝 Build: ${VERSION} (${GIT_COMMIT})"
