import { App, Modal, Notice, Setting, TFile, normalizePath, parseYaml, setIcon } from "obsidian";
import type ClaudeStudio from "./main";
import { findHub } from "./context";
import { DiffModal } from "./ui/diff";
import { ResultModal } from "./ui/result";
import { extractJson, openTasks, sanitizeFileName, stripFrontmatter, truncate } from "./util";
import { clock, type Day } from "./time";

const fmList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);
const catName = (c: string) => c.replace(/^\[\[|\]\]$/g, "").split("|")[0];

/* ------------------------------------------------------------------ */
/* Tags & categories                                                     */
/* ------------------------------------------------------------------ */

export async function suggestTags(plugin: ClaudeStudio, file: TFile) {
  const { app } = plugin;
  if (plugin.core.isExcluded(file)) return new Notice("This note is on the never-send list.");
  const vocab = plugin.ctx.tagVocabulary();
  const categories = app.vault
    .getMarkdownFiles()
    .filter((f) => f.parent?.path === "Categories")
    .map((f) => f.basename);
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  const curTags = fmList(fm.tags);
  const curCats = fmList(fm.categories).map(catName);
  const body = truncate(stripFrontmatter(await app.vault.cachedRead(file)), 8000);

  const notice = new Notice("Reading the note…", 0);
  let out: string;
  try {
    out = await plugin.core.complete({
      model: "fast",
      tools: [],
      persist: false,
      label: "Suggest tags",
      system: "You classify Obsidian notes. Reply with JSON only.",
      prompt: `Suggest tags and categories for the note "${file.basename}".
Use ONLY values from the vocabularies below. Add a category only when the note is genuinely an instance of that type (for example the single hub note of a project for "Projects"), never just because it mentions one.
Return: {"tags": ["..."], "categories": ["..."]}

<tag_vocabulary>
${vocab.join(", ")}
</tag_vocabulary>
<category_vocabulary>
${categories.join(", ")}
</category_vocabulary>
<current>tags: ${curTags.join(", ") || "none"}; categories: ${curCats.join(", ") || "none"}</current>
<note>
${body}
</note>`,
    });
  } catch (e) {
    notice.hide();
    return new Notice((e as Error).message);
  }
  notice.hide();
  const json = extractJson<{ tags?: string[]; categories?: string[] }>(out) ?? {};
  const tags = (json.tags ?? []).map((t) => String(t).replace(/^#/, "")).filter((t) => vocab.includes(t));
  const cats = (json.categories ?? []).map((c) => catName(String(c))).filter((c) => categories.includes(c));
  new TagsModal(app, plugin, file, curTags, curCats, tags, cats).open();
}

class TagsModal extends Modal {
  private pickTags: Set<string>;
  private pickCats: Set<string>;
  constructor(
    app: App,
    private plugin: ClaudeStudio,
    private file: TFile,
    private curTags: string[],
    private curCats: string[],
    private sugTags: string[],
    private sugCats: string[],
  ) {
    super(app);
    this.pickTags = new Set(sugTags.filter((t) => !curTags.includes(t)));
    this.pickCats = new Set(sugCats.filter((c) => !curCats.includes(c)));
  }

  onOpen() {
    this.modalEl.addClass("cs-modal", "cs-tags-modal");
    const head = this.titleEl.createDiv({ cls: "cs-modal-title" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), "tags");
    head.createSpan({ text: `Tags · ${this.file.basename}` });
    this.section("Tags", this.curTags, this.sugTags, this.pickTags, "#");
    this.section("Categories", this.curCats, this.sugCats, this.pickCats, "");
    const btns = this.contentEl.createDiv({ cls: "cs-result-btns" });
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    const apply = btns.createEl("button", { cls: "mod-cta", text: "Add selected" });
    apply.onclick = () => void this.apply();
  }

  private section(title: string, current: string[], suggested: string[], picked: Set<string>, prefix: string) {
    const s = this.contentEl.createDiv({ cls: "cs-tags-section" });
    s.createDiv({ cls: "cs-group", text: title });
    const row = s.createDiv({ cls: "cs-chips" });
    for (const t of current) row.createSpan({ cls: "cs-chip is-current", text: prefix + t });
    const fresh = suggested.filter((t) => !current.includes(t));
    for (const t of fresh) {
      const chip = row.createEl("button", { cls: `cs-chip is-suggested${picked.has(t) ? " is-on" : ""}`, text: `+ ${prefix}${t}` });
      chip.onclick = () => {
        if (picked.has(t)) picked.delete(t);
        else picked.add(t);
        chip.toggleClass("is-on", picked.has(t));
      };
    }
    if (!current.length && !fresh.length) row.createSpan({ cls: "cs-empty", text: "Nothing to suggest." });
  }

  private async apply() {
    if (!this.pickTags.size && !this.pickCats.size) return this.close();
    const before = await this.app.vault.read(this.file);
    await this.app.fileManager.processFrontMatter(this.file, (fm: Record<string, unknown>) => {
      if (this.pickTags.size) fm.tags = [...new Set([...fmList(fm.tags), ...this.pickTags])];
      if (this.pickCats.size) fm.categories = [...new Set([...fmList(fm.categories), ...[...this.pickCats].map((c) => `[[${c}]]`)])];
    });
    const after = await this.app.vault.read(this.file);
    await this.plugin.history.add({ action: "Suggest tags", file: this.file.path, model: this.plugin.core.model("fast"), costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: [...this.pickTags, ...this.pickCats].join(", "), before, after });
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Extract to note                                                       */
/* ------------------------------------------------------------------ */

export async function extractToNote(plugin: ClaudeStudio) {
  const note = plugin.actions.active();
  const sel = note?.editor.getSelection() ?? "";
  if (!note || !sel.trim()) return new Notice("Select the text to extract first.");
  if (plugin.core.isExcluded(note.file)) return new Notice("This note is on the never-send list.");
  const from = note.editor.getCursor("from");
  const to = note.editor.getCursor("to");
  const vocab = plugin.ctx.tagVocabulary();

  let title = "";
  let tags: string[] = [];
  const notice = new Notice("Proposing a title…", 0);
  try {
    const out = await plugin.core.complete({
      model: "fast",
      tools: [],
      persist: false,
      label: "Extract to note",
      system: "Reply with JSON only.",
      prompt: `This text is being moved out of the note "${note.file.basename}" into its own note.
Propose a short descriptive title in the language of the text (no dates, no prefixes unless it clearly belongs to a project like "NLH"), and up to 3 tags chosen ONLY from the vocabulary.
Return {"title": "...", "tags": ["..."]}
<tag_vocabulary>${vocab.join(", ")}</tag_vocabulary>
<text>
${truncate(sel, 6000)}
</text>`,
    });
    const j = extractJson<{ title?: string; tags?: string[] }>(out);
    title = sanitizeFileName(j?.title ?? "");
    tags = (j?.tags ?? []).filter((t) => vocab.includes(t));
  } catch {
    /* fall back to an empty title the user fills in */
  }
  notice.hide();

  new ExtractModal(plugin.app, title, tags, async (finalTitle, finalTags) => {
    const file = await plugin.actions.createNote(sanitizeFileName(finalTitle), sel, note.file, finalTags);
    const link = plugin.app.metadataCache.fileToLinktext(file, note.file.path);
    note.editor.replaceRange(`[[${link}]]`, from, to);
    await plugin.history.add({ action: "Extract to note", file: file.path, model: plugin.core.model("fast"), costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: sel, before: "", after: await plugin.app.vault.read(file) });
    new Notice(`Created ${file.basename}`);
  }).open();
}

class ExtractModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private tags: string[],
    private done: (title: string, tags: string[]) => Promise<void>,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("cs-modal");
    const head = this.titleEl.createDiv({ cls: "cs-modal-title" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), "file-output");
    head.createSpan({ text: "Extract to note" });
    new Setting(this.contentEl).setName("Title").addText((t) => {
      t.setValue(this.title).onChange((v) => (this.title = v));
      window.setTimeout(() => t.inputEl.select(), 20);
      t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && this.submit());
    });
    new Setting(this.contentEl).setName("Tags").setDesc("Comma-separated").addText((t) => t.setValue(this.tags.join(", ")).onChange((v) => (this.tags = v.split(",").map((x) => x.trim()).filter(Boolean))));
    const btns = this.contentEl.createDiv({ cls: "cs-result-btns" });
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    btns.createEl("button", { cls: "mod-cta", text: "Create note" }).onclick = () => this.submit();
  }
  private submit() {
    if (!this.title.trim()) return new Notice("Give the note a title.");
    this.close();
    void this.done(this.title.trim(), this.tags);
  }
  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Daily notes: recaps and carried-over tasks                             */
/* ------------------------------------------------------------------ */

/** Options of a core plugin, which Obsidian doesn't type. */
function internalOptions(app: App, id: string): { folder?: string; format?: string } {
  const internal = (app as unknown as {
    internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: { folder?: string; format?: string } } } | undefined };
  }).internalPlugins;
  return internal?.getPluginById?.(id)?.instance?.options ?? {};
}

function dailyConfig(app: App): { folder: string; format: string } {
  const opts = internalOptions(app, "daily-notes");
  return { folder: opts.folder || "Daily", format: opts.format || "DD-MM-YYYY" };
}

/** Core Templates folder (falls back to "Templates"); template edits aren't work worth recapping. */
function templatesFolder(app: App): string {
  const opts = internalOptions(app, "templates");
  return normalizePath(opts.folder || "Templates");
}

function dailyFile(app: App, date: Day): TFile | null {
  const { folder, format } = dailyConfig(app);
  const f = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${date.format(format)}.md`));
  return f instanceof TFile ? f : null;
}

async function appendTo(plugin: ClaudeStudio, file: TFile, text: string, label: string) {
  const before = await plugin.actions.readCurrent(file);
  const after = before.replace(/\s*$/, "") + "\n\n" + text.trim() + "\n";
  await plugin.actions.applyWholeNote(file, after);
  await plugin.history.add({ action: label, file: file.path, model: "", costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: text, before, after });
}

export async function weeklyRecap(plugin: ClaudeStudio, days = 7) {
  const { app } = plugin;
  const dailies: { date: string; text: string }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = clock().subtract(i, "days");
    const f = dailyFile(app, d);
    if (f && !plugin.core.isExcluded(f)) dailies.push({ date: d.format("YYYY-MM-DD"), text: truncate(stripFrontmatter(await app.vault.cachedRead(f)), 4000) });
  }
  const since = clock().subtract(days, "days").valueOf();
  const templates = templatesFolder(app);
  const touched = app.vault
    .getMarkdownFiles()
    .filter(
      (f) =>
        f.stat.mtime >= since &&
        !plugin.core.isExcluded(f) &&
        !plugin.library.inLibrary(f) &&
        !f.path.startsWith(dailyConfig(app).folder + "/") &&
        !(templates && f.path.startsWith(templates + "/")),
    )
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, 40);
  const tasks = dailies.flatMap((d) => openTasks(d.text));
  if (!dailies.length && !touched.length) return new Notice(days === 1 ? "Nothing written today." : "Nothing written in the last week.");
  // The most recent edits carry an excerpt so "Hecho"/"En curso" have something real to draw on.
  const excerpts: string[] = [];
  for (const f of touched.slice(0, 12)) excerpts.push(`<edited_note name="${f.basename}">\n${truncate(stripFrontmatter(await app.vault.cachedRead(f)), 900)}\n</edited_note>`);

  const prompt = `Write a recap of my last ${days === 1 ? "day" : `${days} days`} from my daily notes and the notes I edited.
Sections: "## Hecho", "## En curso", "## Tareas abiertas" (copy these exact lines, do not invent tasks), "## Notas tocadas" (as [[wikilinks]] using the exact names listed).
Only what the notes say. Short bullets. If a section has nothing, write "- Nada registrado." under it. Do not comment on what you received or what is missing.

<open_tasks>
${tasks.join("\n") || "(none)"}
</open_tasks>
<edited_notes>
${touched.map((f) => f.basename).join("\n") || "(none)"}
</edited_notes>
${excerpts.join("\n")}
${dailies.map((d) => `<daily date="${d.date}">\n${d.text}\n</daily>`).join("\n")}`;

  const today = dailyFile(app, clock());
  new ResultModal(app, plugin, {
    title: days === 1 ? "Daily recap" : "Weekly recap",
    icon: "calendar-range",
    sourcePath: today?.path ?? "",
    spec: { prompt, model: "write", tools: [], persist: false, label: "Recap" },
    actions: [
      ...(today ? [{ label: "Add to today's note", cta: true, run: (t: string) => appendTo(plugin, today, t, "Weekly recap") }] : []),
      {
        label: "Save as note",
        run: async (t: string) => {
          const f = await plugin.actions.createNote(`Resumen semanal ${clock().format("YYYY-MM-DD")}`, t, null, ["journal"]);
          await app.workspace.getLeaf("tab").openFile(f);
        },
      },
    ],
    onDone: (text, r) => void plugin.history.add({ action: "Recap", model: plugin.core.model("write"), costUsd: r?.costUsd ?? 0, durationMs: r?.durationMs ?? 0, status: "shown", prompt, result: text }),
  }).open();
}

/** Deterministic: copy unchecked tasks from the previous week's dailies into today's note. */
export async function carryOverTasks(plugin: ClaudeStudio) {
  const { app } = plugin;
  const today = dailyFile(app, clock());
  if (!today) return new Notice("Create today's daily note first.");
  const current = await plugin.actions.readCurrent(today);
  const seen = new Set(openTasks(current).map((t) => t.replace(/^[-*+]\s+\[ \]\s+/, "")));
  const carried: string[] = [];
  for (let i = 7; i >= 1; i--) {
    const f = dailyFile(app, clock().subtract(i, "days"));
    if (!f) continue;
    for (const t of openTasks(await app.vault.cachedRead(f))) {
      const key = t.replace(/^[-*+]\s+\[ \]\s+/, "");
      if (!seen.has(key)) {
        seen.add(key);
        carried.push(`- [ ] ${key}`);
      }
    }
  }
  if (!carried.length) return new Notice("No open tasks to carry over.");
  const after = current.replace(/\s*$/, "") + `\n\n## Pendientes arrastrados\n${carried.join("\n")}\n`;
  if (!(await new DiffModal(app, { title: `Carry over · ${today.basename}`, before: current, after, applyLabel: "Add tasks" }).open_())) return;
  await plugin.actions.applyWholeNote(today, after);
  await plugin.history.add({ action: "Carry over tasks", file: today.path, model: "", costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: carried.join("\n"), before: current, after });
}

/* ------------------------------------------------------------------ */
/* Bases from a description                                              */
/* ------------------------------------------------------------------ */

export function createBase(plugin: ClaudeStudio) {
  new PromptModal(plugin.app, "Describe the table", "All notes tagged nlh edited this month, newest first", "table", (desc) => void generateBase(plugin, desc)).open();
}

async function generateBase(plugin: ClaudeStudio, desc: string) {
  const { app } = plugin;
  const counts = new Map<string, number>();
  for (const f of app.vault.getMarkdownFiles()) for (const k of Object.keys(app.metadataCache.getFileCache(f)?.frontmatter ?? {})) counts.set(k, (counts.get(k) ?? 0) + 1);
  const props = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, n]) => `${k} (${n})`);
  const folders = [...new Set(app.vault.getMarkdownFiles().map((f) => f.parent?.path ?? "/"))].slice(0, 40);
  const examples = app.vault
    .getFiles()
    .filter((f) => f.extension === "base" && f.path.startsWith(plugin.settings.basesFolder + "/"))
    .slice(0, 3);
  const exText = (await Promise.all(examples.map(async (f) => `<example name="${f.name}">\n${truncate(await app.vault.cachedRead(f), 1200)}\n</example>`))).join("\n");

  const prompt = `Write an Obsidian Bases file (.base, YAML) for: ${desc}

Syntax: top-level "filters" (and/or/not lists of expressions such as file.hasTag("x"), file.inFolder("Notes"), note.categories.contains(link("Projects")), file.mtime > now() - "30d", '!file.name.contains("Template")'), optional "formulas", "properties" (displayName per property: note.<key> or file.<field>), and "views" (type: table or cards, name, order, sort with property/direction, limit). Follow the style of the examples. Use only properties that exist in this vault.
Reply with the YAML only, no fence.

<properties_in_vault>${props.join(", ")}</properties_in_vault>
<tags>${plugin.ctx.tagVocabulary().join(", ")}</tags>
<folders>${folders.join(", ")}</folders>
${exText}`;

  const note = plugin.actions.active();
  const save = async (yaml: string, embed: boolean) => {
    const clean = yaml.replace(/^```(?:yaml)?\n|```\s*$/g, "").trim() + "\n";
    try {
      const parsed = parseYaml(clean) as { views?: unknown } | null;
      if (!parsed || !Array.isArray(parsed.views)) throw new Error("no views");
    } catch (e) {
      return new Notice(`The generated base isn't valid YAML (${(e as Error).message}). Try again with a clearer description.`);
    }
    const folder = normalizePath(plugin.settings.basesFolder);
    if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    const name = sanitizeFileName(desc).slice(0, 60);
    let p = normalizePath(`${folder}/${name}.base`);
    for (let i = 2; app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${folder}/${name} ${i}.base`);
    const file = await app.vault.create(p, clean);
    await plugin.history.add({ action: "Create base", file: file.path, model: plugin.core.model("write"), costUsd: 0, durationMs: 0, status: "applied", prompt: desc, result: clean, before: "", after: clean });
    if (embed && note) note.editor.replaceSelection(`![[${file.name}]]`);
    else await app.workspace.getLeaf("tab").openFile(file);
  };
  new ResultModal(app, plugin, {
    title: "New base",
    icon: "table",
    sourcePath: "",
    spec: { prompt, model: "write", tools: [], persist: false, label: "Create base" },
    actions: [...(note ? [{ label: "Save and embed here", run: (t: string) => void save(t, true) }] : []), { label: "Save base", cta: true, run: (t: string) => void save(t, false) }],
  }).open();
}

/* ------------------------------------------------------------------ */
/* Project hubs                                                          */
/* ------------------------------------------------------------------ */

function hubFor(plugin: ClaudeStudio, file: TFile): TFile | null {
  if (file.path.startsWith(plugin.settings.hubFolder + "/")) return file;
  return findHub(plugin.app, file, plugin.settings.hubFolder);
}

/** Turn the selection (or note) into a checklist appended to the project hub's pending section. */
export async function checklistToHub(plugin: ClaudeStudio) {
  const note = plugin.actions.active();
  if (!note) return new Notice("Open a note first.");
  const hub = hubFor(plugin, note.file);
  if (!hub) return new Notice("This note isn't linked to a project hub.");
  if (plugin.core.isExcluded(hub) || plugin.core.isExcluded(note.file)) return new Notice("A note involved is on the never-send list.");
  const source = note.editor.getSelection() || note.editor.getValue();
  const hubText = await plugin.actions.readCurrent(hub);
  const notice = new Notice("Extracting tasks…", 0);
  let list: string;
  try {
    list = await plugin.core.complete({
      model: "write",
      tools: [],
      persist: false,
      label: "Checklist to hub",
      system: "Reply with a Markdown checklist only.",
      prompt: `Extract the concrete pending actions from the text as a "- [ ] ..." checklist, one per line, imperative, in the text's language. Skip anything already in the hub's existing checklist. If nothing is actionable, reply with nothing.
<hub path="${hub.path}">
${truncate(stripFrontmatter(hubText), 6000)}
</hub>
<text from="${note.file.basename}">
${truncate(source, 12000)}
</text>`,
    });
  } catch (e) {
    notice.hide();
    return new Notice((e as Error).message);
  }
  notice.hide();
  const items = list.split("\n").filter((l) => /^\s*[-*]\s+\[ \]/.test(l));
  if (!items.length) return new Notice("No new tasks found.");
  const block = `${items.join("\n")}\n_De [[${note.file.basename}]]_`;
  const heading = /^##\s+Pendientes\s*$/m;
  let after: string;
  if (heading.test(hubText)) {
    const m = hubText.match(heading)!;
    const start = m.index! + m[0].length;
    const next = hubText.slice(start).search(/^##\s/m);
    const end = next < 0 ? hubText.length : start + next;
    after = hubText.slice(0, end).replace(/\s*$/, "") + "\n" + block + "\n\n" + hubText.slice(end).replace(/^\n+/, "");
  } else after = hubText.replace(/\s*$/, "") + `\n\n## Pendientes\n${block}\n`;
  if (!(await new DiffModal(plugin.app, { title: `Checklist → ${hub.basename}`, before: hubText, after, applyLabel: "Add to hub" }).open_())) return;
  await plugin.actions.applyWholeNote(hub, after);
  await plugin.history.add({ action: "Checklist to hub", file: hub.path, model: plugin.core.model("write"), costUsd: 0, durationMs: 0, status: "applied", prompt: "", result: items.join("\n"), before: hubText, after });
}

/** Status across every note linked to or from the hub, with open tasks collected deterministically. */
export async function projectStatus(plugin: ClaudeStudio) {
  const { app } = plugin;
  const file = plugin.actions.active()?.file ?? app.workspace.getActiveFile();
  if (!file) return new Notice("Open a project note first.");
  const hub = hubFor(plugin, file);
  if (!hub) return new Notice("This note isn't linked to a project hub.");
  const links = app.metadataCache.resolvedLinks;
  const related = new Set<string>(Object.keys(links[hub.path] ?? {}));
  for (const [src, t] of Object.entries(links)) if (t[hub.path]) related.add(src);
  const notes = [...related]
    .map((p) => app.vault.getAbstractFileByPath(p))
    .filter((f): f is TFile => f instanceof TFile && f.extension === "md" && !plugin.core.isExcluded(f) && !plugin.library.inLibrary(f))
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, 15);
  const parts: string[] = [];
  const tasks: string[] = [];
  for (const f of [hub, ...notes]) {
    const text = stripFrontmatter(await app.vault.cachedRead(f));
    for (const t of openTasks(text)) tasks.push(`${t}  ← [[${f.basename}]]`);
    parts.push(`<note name="${f.basename}" modified="${clock(f.stat.mtime).format("YYYY-MM-DD")}">\n${truncate(text, f === hub ? 4000 : 1500)}\n</note>`);
  }
  const prompt = `Give me the current status of the project "${hub.basename}" from its hub and related notes.
Sections: "## Estado" (3-5 bullets, most recent information wins when notes disagree, cite [[note]]), "## Abierto" (copy the open tasks below exactly, grouped by theme), "## Riesgos o contradicciones" (only if the notes show any).
Treat older notes as possibly outdated: prefer what the newest notes say.

<open_tasks>
${tasks.join("\n") || "(none)"}
</open_tasks>
${parts.join("\n")}`;
  new ResultModal(app, plugin, {
    title: `Status · ${hub.basename}`,
    icon: "folder-kanban",
    sourcePath: hub.path,
    spec: { prompt, model: "write", tools: [], persist: false, label: "Project status" },
    actions: [{ label: "Add to hub", cta: true, run: (t) => appendTo(plugin, hub, `## Estado ${clock().format("YYYY-MM-DD")}\n${t.replace(/^##\s+Estado\s*\n/, "")}`, "Project status") }],
    onDone: (text, r) => void plugin.history.add({ action: "Project status", file: hub.path, model: plugin.core.model("write"), costUsd: r?.costUsd ?? 0, durationMs: r?.durationMs ?? 0, status: "shown", prompt, result: text }),
  }).open();
}

/* ------------------------------------------------------------------ */

export class PromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private placeholder: string,
    private icon: string,
    private done: (v: string) => void,
  ) {
    super(app);
  }
  onOpen() {
    this.modalEl.addClass("cs-modal", "cs-prompt-modal");
    const head = this.titleEl.createDiv({ cls: "cs-modal-title" });
    setIcon(head.createSpan({ cls: "cs-card-icon" }), this.icon);
    head.createSpan({ text: this.title });
    const input = this.contentEl.createEl("textarea", { cls: "cs-prompt-input", attr: { rows: "3", placeholder: this.placeholder } });
    input.focus();
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.done(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        go();
      }
    });
    const btns = this.contentEl.createDiv({ cls: "cs-result-btns" });
    btns.createEl("button", { cls: "mod-cta", text: "Generate" }).onclick = go;
  }
  onClose() {
    this.contentEl.empty();
  }
}
