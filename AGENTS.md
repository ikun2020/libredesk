# Working conventions

This is the `ikun2020/libredesk` fork of `abhinavxd/libredesk`.

## Everyday changes

- Work on the requested change and validate the affected behavior. Choose tests
  and builds according to the change's scope; expand checks when failures or
  broader effects justify it.
- Check for conflicts with upstream and apply the fork customization-preservation
  checklist only when the user explicitly requests fork sync. Routine changes
  still require normal, relevant testing and CI; the maintenance record does not
  add a blanket full-regression requirement to everyday work.
- Sync upstream only when the user explicitly requests it. A normal change or
  image release is not an instruction to sync upstream.
- Keep only `main` as a lasting local and fork branch. Routine changes can use
  small commits directly on `main`. If a complex sync needs a temporary `codex/`
  branch, remove it locally and on the fork after confirming it is merged.
  Record commit SHAs for recovery instead of keeping backup branches.

## Explicit upstream sync only

When the user requests fork sync, upstream synchronization, or merging an
upstream version, first read [docs/FORK_MAINTENANCE.md](docs/FORK_MAINTENANCE.md).
Its customization history and full regression checklist apply to that sync.
Resolve conflicts by the recorded behavior, retain the fork's changes and GHCR
version handling, and update the sync record. Do not force-reset the fork to
upstream or discard its commits as a routine sync strategy.

Explicit user instructions in the current task take precedence over this record.

## Context7

Use Context7 MCP for current library, framework, SDK, API, CLI, and cloud-service
documentation, including syntax, configuration, migrations, and setup. Resolve
the library ID first unless the user supplied an exact ID, select the most
relevant authoritative match, and query the specific question. Prefer Context7
over web search for library docs. It is not required for general programming,
business-logic debugging, refactoring, or code review that does not depend on an
external API.
