# Claude Studio

Notion-style AI inside Obsidian, powered by your local **Claude Code CLI**. It uses the CLI's logged-in session (your Claude plan), so there is no API key to configure. The vault's `CLAUDE.md` shapes every answer, because the CLI runs with the vault as its working directory.

Desktop only. It needs the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in.

**Interface languages:** English, 简体中文, 日本語, 한국어, Español, Deutsch, Français, Português (Brasil) and Русский, following Obsidian's language setting. A translation that reads wrong? [Open an issue](https://github.com/perezamadorluisenrique-gif/claude-studio/issues/new/choose) with the text and what it should say.

## What it does

| | |
|---|---|
| **AI palette** | Type a prompt or pick an action. The context Claude will see shows up as chips (selection, around cursor, note, project hub, linked notes, snap range, profile), and you can switch each one off. `Tab` sends the question to the vault chat instead. |
| **Inline card** | Answers stream into a card under your text. `Enter` replaces (or inserts), `Shift+Enter` does the other, typing in the box refines the answer, `Alt+R` retries and `Esc` discards. Accepted edits are normal editor changes, so `Ctrl+Z` undoes them. |
| **Link checker** | Any `[[link]]` in an answer that points to a note that doesn't exist is flagged before you accept, with a one-click *Unlink them*. |
| **Selection toolbar** | Appears when you select text. It shows *Ask Claude* plus every action with `bubble: true`. |
| **Ghost text** | *Continue writing* streams a suggestion in grey at the cursor. `Tab` accepts it; typing or `Esc` dismisses it. |
| **Chat panel** | Asks questions about the vault. Claude can Read/Grep/Glob your notes but never edit them, and it cites notes as `[[links]]` you can click. Conversations resume through `--resume` and are kept per chat. Sibling vaults (Settings) can be searched read-only and are cited with `obsidian://` links. |
| **Whole-note actions** | Rewrites always go through a diff view first and are applied as a minimal edit, so undo, folds and scroll position survive. |
| **History** | Logs every run with model, time and cost. Applied changes keep before/after snapshots, so you can **revert** them from the panel. |
| **Usage limits** | Your current 5-hour session and weekly usage as two bars, with when each one resets. The status bar shows the session percentage; click it for the full view. It updates after every run at no extra cost, and *Check now* sends one tiny request. |
| **Vault tools** | Suggest tags/categories (from your existing vocabulary only) · Extract selection to a new note · Recap today / last 7 days · Carry open tasks into today's daily note · Create a Base from a description · Send tasks to the project hub · Project status from the hub and related notes. |
| **Clippings** (opt-in) | New notes in `Clippings/` get a `summary` property. |

## Actions and profiles are notes

On first run the plugin creates `Templates/AI/` (configurable):

- `Actions/*.md`: one action per note. The frontmatter sets `scope`, `output`, `model`, `tools`, `icon`, `group`, `bubble` and `index`, and the body is the prompt. Available variables are `{{selection}}`, `{{cursor}}`, `{{note}}`, `{{title}}`, `{{path}}`, `{{tags}}`, `{{hub}}`, `{{snap}}`, `{{today}}` and `{{input}}`. Any context the prompt doesn't use is attached at the end.
- `Profiles/*.md`: extra instructions picked by the active note's `match_tags`, `match_folders` and `match_categories`. A profile with no rules is the fallback.
- `Cómo funciona.md`: the full reference.

Edits reload instantly, and every action also becomes a command you can bind to a hotkey.

## Privacy

*Never send these notes* (paths, names, folders) and *never send notes with these tags* are enforced twice:

1. The plugin never puts those notes into the context it sends.
2. Every CLI call receives them as `--settings` deny rules for `Read`/`Edit`.

The second layer matters for sibling vaults: a vault's own `.claude/settings.json` only applies when the CLI runs inside that vault. This was tested: without the plugin's rules, a cross-vault search returns a note the deny list names; with them, it doesn't.

## For other plugins and scripts

```js
const cs = app.plugins.plugins["claude-studio"].api;
await cs.run("Three title ideas for: " + tp.file.title);   // Templater
await cs.runAction("resumir-nota");
cs.ask("¿Qué tengo pendiente?");
```

URIs:

- `obsidian://claude-studio?do=chat&prompt=…`
- `obsidian://claude-studio?do=palette`
- `obsidian://claude-studio?do=usage`
- `obsidian://claude-studio?do=recap&days=7`
- `obsidian://claude-studio?do=run&action=Resumir%20nota&file=Notes/X.md`

## Requirements and disclosures

- **Desktop only.** The plugin starts the `claude` command-line program on your computer, which Obsidian on mobile cannot do.
- **Install and log in to Claude Code first.** Run `claude` once in a terminal. The plugin looks for it in the usual install locations, or you can set the path in its settings.
- **Your notes leave your computer.** What you send (the selection, the note around the cursor, linked notes, or what Claude reads while answering in the chat) is processed by Claude through the CLI, under the terms of your own Claude plan. The plugin has no server of its own and no telemetry.
- **Cost.** Runs use your Claude plan's limits; the history and usage views show what each run took.
- **Why it uses Node.js modules, and exactly what for.** The plugin's whole job is to run your own `claude` program, so it needs things Obsidian's API doesn't offer. Each use is listed here:
  - `child_process` (shell execution): starts the `claude` command-line program for each run (`spawn`, no shell except for the Windows `claude.cmd` shim), asks it for `--version` when you press *Test*, looks for it with `where claude` (Windows) or `sh -lc "command -v claude"` (macOS/Linux) when you press *Detect*, and runs `taskkill` on Windows to stop a run you cancel.
  - `fs` (direct filesystem access), only for these reads, none of them in your vault: checking that the `claude` program exists at its usual install paths and, for the Windows `.cmd` shim, reading that one small file to find the real `.exe`; and reading Obsidian's own `obsidian.json` to list your other vaults for the *Sibling vaults* setting. The plugin never writes outside your vault through `fs`; vault notes are always read and written through Obsidian's API.
  - Environment and system information (`os.homedir()`, `process.platform` and the `HOME` and `APPDATA` variables): only to build those install and `obsidian.json` paths per operating system. Nothing is sent anywhere or used to identify you. The CLI process also receives a copy of your environment (so it finds its own login and `PATH`), minus `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` when *Use my subscription* is on.
- **Vault listing.** The plugin lists your notes to find the ones that link to the note you're working on, to match project hubs and profiles, to suggest tags, folders and properties, and to find your Actions and Profiles notes. File paths stay on your computer unless a note you chose as context is sent.
- **Clipboard.** Only when you press a *Copy* button on an answer; the plugin never reads the clipboard.
- **No default hotkey.** *Open AI palette* has no shortcut so it can't clash with yours. Assign one in **Settings → Hotkeys** (search "Claude Studio"); every action is also a command you can bind.
- **Nothing is changed without you.** Answers are inserted only after you accept them, whole-note rewrites go through a diff first, and every applied change can be reverted from the History panel.

## Installation

In Obsidian, open **Settings → Community plugins → Browse** and search for "Claude Studio".

## Development

```
npm ci
npm run lint
npm test             # unit tests for the pure helpers (Node ≥ 22.18)
npm run build        # tsc + esbuild → main.js
```

Code map:

- `src/runner.ts`: spawns the CLI (`stream-json`, partial messages, stdin prompt) and resolves the npm `.cmd` shim to the native exe
- `src/core.ts`: exclusions and deny rules, model aliases, status
- `src/context.ts`: chips and prompt assembly
- `src/library.ts`: actions and profiles
- `src/actions.ts`: output routing
- `src/editor/*`: CodeMirror card, ghost text and bubble
- `src/ui/*`: palette, chat, history, usage limits, diff and result modal
- `src/usage.ts`: last usage-limit snapshot from the CLI (`rate_limit_event`), saved to `usage.json`
- `src/icon.ts`: the plugin's own burst icon
- `src/features.ts`: vault tools
- `src/integrations.ts`: clippings, API and URI

## More plugins by Siulved54

| Plugin | What it does | Source |
| --- | --- | --- |
| [Shared Blocks](https://obsidian.md/plugins?id=shared-blocks) | Write a block of text once and reuse it in any note. Edit the source and every reference re-renders live. | [shared-blocks](https://github.com/perezamadorluisenrique-gif/shared-blocks) |
| [Text Case and Cleanup](https://obsidian.md/plugins?id=text-format) | Change case, make camelCase or slugs, sort lines and remove duplicates, and repair text pasted out of a PDF, without touching code or URLs. | [text-format](https://github.com/perezamadorluisenrique-gif/text-format) |
| [Typography as You Type](https://obsidian.md/plugins?id=typography-as-you-type) | Curly quotes, dashes and ellipses as you type, kept out of code and maths, with Backspace to take one back. | [smart-typography-plugin](https://github.com/perezamadorluisenrique-gif/smart-typography-plugin) |
| [Section Numbering](https://obsidian.md/plugins?id=section-numbering) | Number headings as an outline (1, 1.1, 1.2) and keep every link to them working when they renumber. | [section-numbering](https://github.com/perezamadorluisenrique-gif/section-numbering) |
| [Spreadsheet to Table](https://obsidian.md/plugins?id=spreadsheet-to-table) | Paste cells from Excel or Google Sheets as a Markdown table with a real header, insert CSV files, and copy tables back out. | [spreadsheet-to-table](https://github.com/perezamadorluisenrique-gif/spreadsheet-to-table) |
| [Hybrid Line Numbers](https://obsidian.md/plugins?id=hybrid-line-numbers) | Relative and hybrid line numbers for Vim-style jumps, where a folded section counts as one line. | [hybrid-line-numbers](https://github.com/perezamadorluisenrique-gif/hybrid-line-numbers) |
| [List Item Callouts](https://obsidian.md/plugins?id=list-item-callouts) | Colour a single list item as a callout by starting it with a character such as `&`, `!` or `?`. | [list-item-callouts](https://github.com/perezamadorluisenrique-gif/list-item-callouts) |
| [Folder Counts](https://obsidian.md/plugins?id=folder-counts) | See how many notes or files each folder holds, right in the file explorer, with a vault total and folder exclusions. | [folder-counts](https://github.com/perezamadorluisenrique-gif/folder-counts) |
| [Note Reading Time](https://obsidian.md/plugins?id=note-reading-time) | Reading time of the current note or your selection in the status bar, optionally saved to a property. | [note-reading-time](https://github.com/perezamadorluisenrique-gif/note-reading-time) |
| [Task Rollover](https://obsidian.md/plugins?id=task-rollover) | Roll unfinished tasks from your last daily note into today's when it is created, with a real undo. | [task-rollover](https://github.com/perezamadorluisenrique-gif/task-rollover) |
| [Zoom Into Section](https://obsidian.md/plugins?id=zoom-into-section) | Zoom into a heading or list item to see only it and its contents, with a breadcrumb bar to climb back out. | [zoom-into-section](https://github.com/perezamadorluisenrique-gif/zoom-into-section) |
| [Link Title on Paste](https://obsidian.md/plugins?id=link-title-on-paste) | Paste a web address and get a Markdown link with the page's title, fetched in the background and undone in one step. | [link-title-on-paste](https://github.com/perezamadorluisenrique-gif/link-title-on-paste) |
| [Update Radar](https://obsidian.md/plugins?id=update-radar) | Checks your installed community plugins for updates in the background, shows what changed, and flags the ones that look abandoned. | [community-update-checker](https://github.com/perezamadorluisenrique-gif/community-update-checker) |
| [Dataview to Bases](https://obsidian.md/plugins?id=dataview-to-bases) | Convert Dataview queries into Bases blocks, and see which queries in your vault can be converted. | [dataview-to-bases](https://github.com/perezamadorluisenrique-gif/dataview-to-bases) |
| [Line Editing Commands](https://obsidian.md/plugins?id=line-editing-commands) | Duplicate, join, sort and reverse lines, insert blank lines and jump to a line number, with multi-cursor support. | [line-editing-commands](https://github.com/perezamadorluisenrique-gif/line-editing-commands) |
| [Note Mover Rules](https://obsidian.md/plugins?id=note-mover-rules) | Move notes into folders by ordered rules on tags, properties, titles and paths, with a preview before any bulk move. | [note-mover-rules](https://github.com/perezamadorluisenrique-gif/note-mover-rules) |
| [Tab History](https://obsidian.md/plugins?id=tab-history) | Keeps each tab's back and forward history across restarts, and adds commands to move, maximize and close tabs. | [tab-history](https://github.com/perezamadorluisenrique-gif/tab-history) |
| [URL Cards](https://obsidian.md/plugins?id=url-cards) | Shows web addresses as cards with title, description and image, and reads existing cardlink blocks. | [url-cards](https://github.com/perezamadorluisenrique-gif/url-cards) |
| [Vim Config](https://obsidian.md/plugins?id=vim-config) | Loads a vimrc-style file from your vault so your key mappings and editor commands are ready when vim mode starts. | [vim-config](https://github.com/perezamadorluisenrique-gif/vim-config) |
| [Task Archive](https://obsidian.md/plugins?id=task-archive) | Moves completed tasks, with their sub-items, into an archive section or note. | [task-archive](https://github.com/perezamadorluisenrique-gif/task-archive) |
| [Revisit Later](https://obsidian.md/plugins?id=revisit-later) | Link the current note into a future daily note, with a date typed in plain English, so it comes back when you want to review it. | [revisit-later](https://github.com/perezamadorluisenrique-gif/revisit-later) |
| [Explorer Colors Plus](https://obsidian.md/plugins?id=explorer-colors-plus) | Color files and folders in the file explorer, with a palette, cascading to children, and import from File Color. | [explorer-colors-plus](https://github.com/perezamadorluisenrique-gif/explorer-colors-plus) |
| [Book Lookup](https://obsidian.md/plugins?id=book-lookup) | Create book notes from Open Library or Google Books, with cover images, ISBN search and Book Search compatible templates. | [book-lookup](https://github.com/perezamadorluisenrique-gif/book-lookup) |
| [Web Search Menu](https://obsidian.md/plugins?id=web-search-menu) | Search the web for selected text or the note title from the right-click menu, with engines you define. | [web-search-menu](https://github.com/perezamadorluisenrique-gif/web-search-menu) |
| [Word Lookup](https://obsidian.md/plugins?id=word-lookup) | Look up any word in a sidebar dictionary with definitions, phonetics, synonyms and antonyms, or create a note for it. | [word-lookup](https://github.com/perezamadorluisenrique-gif/word-lookup) |
| [Quick Translate](https://obsidian.md/plugins?id=quick-translate) | Translate the selection or a whole note into another language with no account, keeping links, code and front matter untouched. | [quick-translate](https://github.com/perezamadorluisenrique-gif/quick-translate) |
| [Dice Rolls](https://obsidian.md/plugins?id=dice-rolls) | Inline dice rolls you click to reroll, in Live Preview and Reading view, with full dice notation, a roll dialog and a roll history. Reads Dice Roller notes. | [dice-rolls](https://github.com/perezamadorluisenrique-gif/dice-rolls) |

All of them are in the community directory: Settings -> Community plugins ->
Browse, then search for the name.
