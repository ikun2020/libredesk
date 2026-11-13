# Fork maintenance

This is the `ikun2020/libredesk` fork of `abhinavxd/libredesk`.

Before modifying automation, the conversation composer, or syncing upstream, read
[docs/FORK_MAINTENANCE.md](docs/FORK_MAINTENANCE.md). It records the user's two
required customizations, their commits, affected files, and regression checks.

- Preserve content-based fixed replies for subsequent incoming messages. Match
  the triggering message's text, including empty text, rather than a stale
  conversation preview; keep automated replies from triggering loops.
- Preserve the final iPhone DUO behavior: a directly editable inline composer at
  the bottom of the conversation. Fullscreen is optional and explicit. Keyboard
  or fold-related viewport changes must preserve the editor, focus, and draft.
- The automatic fullscreen behavior introduced by `9fbed06e` was superseded by
  `a08ec969`. Do not restore it while resolving conflicts.
- Integrate upstream on a `codex/` branch, resolve conflicts by behavior, and run
  the documented checks before publishing a code update. Do not discard fork
  commits or force-reset the fork to upstream as a routine sync strategy.
- If upstream implements an equivalent feature, adapt or retire duplicate code
  while preserving the required behavior and regression coverage. Update the
  maintenance record when paths, behavior, or sync results change.
- Also retain this fork's GHCR workflow and application-version resolution.

Explicit user instructions in the current task take precedence over this record.

## Context7

Use Context7 MCP for current library, framework, SDK, API, CLI, and cloud-service
documentation, including syntax, configuration, migrations, and setup. Resolve
the library ID first unless the user supplied an exact ID, select the most
relevant authoritative match, and query the specific question. Prefer Context7
over web search for library docs. It is not required for general programming,
business-logic debugging, refactoring, or code review that does not depend on an
external API.
