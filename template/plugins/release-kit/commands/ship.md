---
description: Cut a release for the current project
agent: build
---

Ship a release: $ARGUMENTS

Workflow:
1. Confirm the version bump (patch, minor, major) with the user
2. Draft the release notes from the commits since the last tag
3. Tag the release and push the tag
