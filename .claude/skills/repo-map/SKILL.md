---
name: repo-map
description: Orient yourself in this repo before exploring it. Use when you need to find where something lives, understand the project structure, or start an investigation across multiple files.
---
# Repo map

`.claude/REPO_MAP.md` lists every tracked file by directory with its top-level symbols (functions, classes, exports). A SessionStart hook regenerates it, so it matches the current checkout.

1. Read `.claude/REPO_MAP.md` first and pick candidate files from it. Do not list directories or open files to "get a feel" for the layout.
2. Narrow with Grep/Glob, then Read with `offset`/`limit` for just the relevant range.
3. For investigations that touch many files, delegate to the Explore subagent and ask for paths, symbols and line numbers back, not file contents.
4. If the map is missing or stale (after large edits in this session), run `python3 .claude/scripts/repo-map.py`.

The map header shows a detail level: 0 has symbols, higher levels drop symbols to fit the line budget (`--budget N` raises it).
