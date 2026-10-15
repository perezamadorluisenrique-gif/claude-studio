import { ICON } from "./icon";
import { App, Events, TAbstractFile, TFile, debounce, getAllTags, normalizePath } from "obsidian";
import { stripFrontmatter } from "./util";

export type Scope = "selection" | "note" | "cursor" | "none";
export type Output = "replace" | "below" | "note" | "new-note" | "chat" | "modal" | `property:${string}`;

export interface Action {
  id: string;
  name: string;
  icon: string;
  group: string;
  model: string;
  scope: Scope;
  output: Output;
  tools: string[];
  /** Send the list of note titles so links can point at real notes. */
  index: boolean;
  /** Show in the selection toolbar. */
  bubble: boolean;
  order: number;
  prompt: string;
  path: string;
}

export interface Profile {
  name: string;
  tags: string[];
  folders: string[];
  categories: string[];
  priority: number;
  prompt: string;
  path: string;
}

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(",").map((x) => x.trim()) : [];

/** A frontmatter value as text, or `fallback` when it is missing or not a scalar. */
const text = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Loads Actions/ and Profiles/ under the library folder and reloads when any of them change. */
export class Library extends Events {
  actions: Action[] = [];
  profiles: Profile[] = [];

  constructor(
    private app: App,
    private folder: () => string,
  ) {
    super();
  }

  readonly reload = debounce(() => void this.load(), 400, true);

  inLibrary(f: TAbstractFile | string): boolean {
    const p = typeof f === "string" ? f : f.path;
    return p.startsWith(normalizePath(this.folder()) + "/");
  }

  async load() {
    const root = normalizePath(this.folder());
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(root + "/"));
    const actions: Action[] = [];
    const profiles: Profile[] = [];
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
      const body = stripFrontmatter(await this.app.vault.cachedRead(f)).trim();
      if (f.path.startsWith(root + "/Actions/")) actions.push(this.toAction(f, fm, body));
      else if (f.path.startsWith(root + "/Profiles/")) profiles.push(this.toProfile(f, fm, body));
    }
    actions.sort((a, b) => a.group.localeCompare(b.group) || a.order - b.order || a.name.localeCompare(b.name));
    profiles.sort((a, b) => b.priority - a.priority);
    this.actions = actions;
    this.profiles = profiles;
    this.trigger("changed");
  }

  private toAction(f: TFile, fm: Record<string, unknown>, body: string): Action {
    const scope = (typeof fm.scope === "string" && ["selection", "note", "cursor", "none"].includes(fm.scope) ? fm.scope : "selection") as Scope;
    const output = text(fm.output, scope === "selection" ? "replace" : "below") as Output;
    return {
      id: slug(f.basename),
      name: text(fm.name, f.basename),
      icon: text(fm.icon, ICON),
      group: text(fm.group, "Actions"),
      model: text(fm.model, "fast"),
      scope,
      output,
      tools: list(fm.tools),
      index: fm.index === true,
      bubble: fm.bubble === true,
      order: Number(fm.order ?? 100),
      prompt: body,
      path: f.path,
    };
  }

  private toProfile(f: TFile, fm: Record<string, unknown>, body: string): Profile {
    return {
      name: text(fm.name, f.basename),
      // match_* keys, so a profile note can still carry its own Kepano `tags:`.
      tags: list(fm.match_tags).map((t) => t.replace(/^#/, "").toLowerCase()),
      folders: list(fm.match_folders),
      categories: list(fm.match_categories).map((c) => c.replace(/^\[\[|\]\]$/g, "")),
      priority: Number(fm.priority ?? 0),
      prompt: body,
      path: f.path,
    };
  }

  /** Every matching profile, strongest first. A profile with no rules is the fallback. */
  profilesFor(file: TFile | null): Profile[] {
    if (!file) return this.profiles.filter((p) => !p.tags.length && !p.folders.length && !p.categories.length).slice(0, 1);
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = (cache ? getAllTags(cache) ?? [] : []).map((t) => t.replace(/^#/, "").toLowerCase());
    const cats = list(cache?.frontmatter?.categories).map((c) => c.replace(/^\[\[|\]\]$/g, "").split("|")[0]);
    const matched = this.profiles.filter(
      (p) =>
        p.tags.some((t) => tags.includes(t)) ||
        p.folders.some((d) => file.path.startsWith(d.replace(/\/?$/, "/"))) ||
        p.categories.some((c) => cats.includes(c)),
    );
    if (matched.length) return matched;
    return this.profiles.filter((p) => !p.tags.length && !p.folders.length && !p.categories.length).slice(0, 1);
  }

  byId(id: string): Action | undefined {
    return this.actions.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase());
  }
}
