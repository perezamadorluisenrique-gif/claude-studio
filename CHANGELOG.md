# Changelog

The release workflow uses the section named after the version being released
as the release description, so every version needs one. `npm version <x.y.z>`
renames the `Unreleased` heading below to that version.

## 0.1.3

- The interface is also available in Italian, and the "Claude Code CLI not found" message is translated.

## 0.1.2

- The interface is translated into Simplified Chinese, Japanese, Korean, Spanish, German, French, Brazilian Portuguese and Russian, following Obsidian's language setting; English stays the fallback.

## 0.1.1

- Obsidian's directory review: the AI palette no longer ships a default hotkey (assign one in Settings → Hotkeys), the settings use Obsidian 1.13's declarative settings so they appear in settings search, and clearing the history or reverting a created note asks in an Obsidian dialog instead of the system one.
- Safer type handling for linked notes, and the editor widgets and styles no longer rely on features Obsidian 1.6 only partly supports.
- README: lists exactly what the plugin uses Node.js modules, the environment and the vault listing for.

## 0.1.0

- First release: an AI palette (`Ctrl/Cmd+J`) with visible, switchable context, an inline answer card that replaces or inserts as normal editor changes, selection toolbar, ghost-text continuation, and a vault chat that can read but never edit your notes.
- Actions and profiles are notes in `Templates/AI/`, so you add or edit them without code; every action is also a command.
- Run history with before/after snapshots and revert, usage limits for the 5-hour and weekly windows, and vault tools (tags, extract, recaps, tasks, Bases, project status).
- Privacy: notes you exclude by name, folder or tag are never sent, and every call also gets deny rules for them.
- Desktop only, using your own Claude Code CLI session. Needs Obsidian 1.7.2 or later.
