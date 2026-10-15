# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.1.0

- First release: an AI palette (`Ctrl/Cmd+J`) with visible, switchable context, an inline answer card that replaces or inserts as normal editor changes, selection toolbar, ghost-text continuation, and a vault chat that can read but never edit your notes.
- Actions and profiles are notes in `Templates/AI/`, so you add or edit them without code; every action is also a command.
- Run history with before/after snapshots and revert, usage limits for the 5-hour and weekly windows, and vault tools (tags, extract, recaps, tasks, Bases, project status).
- Privacy: notes you exclude by name, folder or tag are never sent, and every call also gets deny rules for them.
- Desktop only, using your own Claude Code CLI session. Needs Obsidian 1.7.2 or later.
