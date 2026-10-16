---
description: "Tools an agent uses to change the harness itself and see the result."
kind: "package-group"
---

# packages/devtools

## Summary

The devtools group holds tools for working on the harness itself: starting and driving a test copy of the Desktop app, and building one workspace package. They register on the [tool registry](../../docs/subsystems/tools.md) like any other tool, and start child processes as described in the [subprocess reference](../../docs/subsystems/subprocess.md).

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`harness-dev-tools`](harness-dev-tools/README.md) | `desktop_test_instance` and `build_workspace_package` | registers on `ctx.tools` |
