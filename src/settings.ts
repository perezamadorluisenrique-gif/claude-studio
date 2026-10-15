import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type ClaudeStudio from "./main";
import { claudeVersion, detectClaude } from "./runner";

export interface StudioSettings {
  claudePath: string;
  stripApiKey: boolean;
  fastModel: string;
  writeModel: string;
  chatModel: string;
  libraryFolder: string;
  notesFolder: string;
  hubFolder: string;
  basesFolder: string;
  exclude: string;
  excludeTags: string;
  siblingVaults: string[];
  contextChars: number;
  linkedNotes: number;
  linkedNoteChars: number;
  selectionBubble: boolean;
  clippingsEnabled: boolean;
  clippingsFolder: string;
  clippingsProperty: string;
  recentPrompts: string[];
  starterInstalled: boolean;
}

export const DEFAULT_SETTINGS: StudioSettings = {
  claudePath: "",
  stripApiKey: true,
  fastModel: "haiku",
  writeModel: "sonnet",
  chatModel: "sonnet",
  libraryFolder: "Templates/AI",
  notesFolder: "Notes",
  hubFolder: "Notes/Project Roots",
  basesFolder: "Templates/Bases",
  exclude: "",
  excludeTags: "private",
  siblingVaults: [],
  contextChars: 2500,
  linkedNotes: 3,
  linkedNoteChars: 1500,
  selectionBubble: true,
  clippingsEnabled: false,
  clippingsFolder: "Clippings",
  clippingsProperty: "summary",
  recentPrompts: [],
  starterInstalled: false,
};

export interface KnownVault {
  name: string;
  path: string;
}

/** Other vaults registered in this Obsidian install (from %APPDATA%/obsidian/obsidian.json). */
export function knownVaults(currentPath: string): KnownVault[] {
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? "", "obsidian")
      : process.platform === "darwin"
        ? path.join(process.env.HOME ?? "", "Library", "Application Support", "obsidian")
        : path.join(process.env.HOME ?? "", ".config", "obsidian");
  try {
    const json = JSON.parse(fs.readFileSync(path.join(base, "obsidian.json"), "utf8")) as { vaults?: Record<string, { path?: unknown }> };
    return Object.values(json.vaults ?? {})
      .map((v) => String(v.path))
      .filter((p) => path.resolve(p) !== path.resolve(currentPath) && fs.existsSync(p))
      .map((p) => ({ name: path.basename(p), path: p }));
  } catch {
    return [];
  }
}

type NumberKey = "contextChars" | "linkedNotes" | "linkedNoteChars";
const FOLDER_KEYS = ["libraryFolder", "notesFolder", "hubFolder", "basesFolder", "clippingsFolder"];
const TRIMMED_KEYS = ["claudePath", "fastModel", "writeModel", "chatModel", "clippingsProperty"];

/** The slice of the 1.13 definitions the pre-1.13 renderer reads, typed locally so the review linter doesn't mistake it for use of the new API. */
interface LegacyItem {
  name?: string;
  desc?: string;
  render?: (setting: Setting) => void;
  control?: { type: string; key: string; rows?: number; min?: number };
}
interface LegacyGroup {
  type: string;
  heading?: string;
  items?: LegacyItem[];
}

/** Settings are described once; Obsidian 1.13+ renders and indexes them, older versions get the same list drawn by `draw()`. */
export class StudioSettingTab extends PluginSettingTab {
  /** Set once Obsidian has drawn the tab through `display()`, which it only does before 1.13. */
  private legacy = false;

  constructor(app: App, private plugin: ClaudeStudio) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    if (typeof value === "string") {
      if (FOLDER_KEYS.includes(key)) value = value.trim().replace(/\/+$/, "");
      else if (TRIMMED_KEYS.includes(key)) value = value.trim();
      if (key === "clippingsProperty" && !value) value = "summary";
    }
    s[key] = value;
    await this.plugin.saveSettings();
    if (key === "libraryFolder") this.plugin.library.reload();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const model = (name: string, desc: string, key: string) => ({ name, desc, control: { type: "text" as const, key, defaultValue: DEFAULT_SETTINGS[key as "fastModel"] } });
    const folder = (name: string, desc: string, key: string) => ({ name, desc, control: { type: "text" as const, key, defaultValue: DEFAULT_SETTINGS[key as "libraryFolder"] } });
    const num = (name: string, desc: string, key: NumberKey) => ({
      name,
      desc,
      control: {
        type: "number" as const,
        key,
        min: 0,
        defaultValue: DEFAULT_SETTINGS[key],
        validate: (v: number) => (Number.isInteger(v) && v >= 0 ? undefined : "A whole number of 0 or more."),
      },
    });
    const vaults = knownVaults(this.plugin.vaultPath());
    const vaultItems: SettingGroupItem[] = vaults.length
      ? vaults.map((v) => ({
          name: v.name,
          desc: "Chat can search this vault (read-only) and answers with obsidian:// links to it.",
          render: (setting: Setting) => {
            setting.setName(v.name).setDesc("Chat can search this vault (read-only) and answers with obsidian:// links to it.");
            setting.addToggle((t) =>
              t.setValue(s.siblingVaults.includes(v.path)).onChange((on) => {
                s.siblingVaults = on ? [...new Set([...s.siblingVaults, v.path])] : s.siblingVaults.filter((p) => p !== v.path);
                void this.plugin.saveSettings();
              }),
            );
          },
        }))
      : [{ name: "No other vaults registered in Obsidian." }];

    return [
      {
        type: "group",
        heading: "Claude Code CLI",
        items: [
          { name: "CLI path", desc: "Detected automatically. The npm shim is resolved to the native executable it launches.", aliases: ["claude", "detect", "test"], render: (setting: Setting) => this.cliPathRow(setting) },
          {
            name: "Use my subscription",
            desc: "Remove ANTHROPIC_API_KEY from the CLI's environment so runs use your logged-in Claude plan.",
            control: { type: "toggle", key: "stripApiKey", defaultValue: DEFAULT_SETTINGS.stripApiKey },
          },
        ],
      },
      {
        type: "group",
        heading: "Models",
        items: [
          model("Fast", "Selection edits, ghost text, tags, clippings. Actions refer to it as `fast`.", "fastModel"),
          model("Write", "Whole-note work, recaps, Bases. Actions refer to it as `write`.", "writeModel"),
          model("Chat", "Side panel conversations. Actions refer to it as `chat`.", "chatModel"),
        ],
      },
      {
        type: "group",
        heading: "Vault layout",
        items: [
          folder("Library folder", "Holds Actions/ and Profiles/ — every action and profile is a note you can edit.", "libraryFolder"),
          folder("New notes folder", "Where Extract to note creates notes.", "notesFolder"),
          folder("Project hubs folder", "Notes here are treated as project hubs and added as context to linked notes.", "hubFolder"),
          folder("Bases folder", "Where generated .base files are saved.", "basesFolder"),
        ],
      },
      {
        type: "group",
        heading: "Privacy",
        items: [
          {
            name: "Never send these notes",
            desc: "One per line: a note name, a path, or a folder ending in /. Enforced in the plugin and as CLI deny rules, including sibling vaults.",
            control: { type: "textarea", key: "exclude", rows: 5, defaultValue: DEFAULT_SETTINGS.exclude },
          },
          {
            name: "Never send notes with these tags",
            desc: "Comma-separated, without #.",
            control: { type: "text", key: "excludeTags", defaultValue: DEFAULT_SETTINGS.excludeTags },
          },
        ],
      },
      {
        type: "group",
        heading: "Context",
        items: [
          num("Text around the cursor", "Characters sent when nothing is selected.", "contextChars"),
          num("Linked notes", "How many outgoing links are offered as context chips.", "linkedNotes"),
          num("Linked note excerpt", "Characters taken from each linked note.", "linkedNoteChars"),
        ],
      },
      { type: "group", heading: "Sibling vaults", items: vaultItems },
      {
        type: "group",
        heading: "Editor",
        items: [{ name: "Selection toolbar", desc: "Show the floating action bar when you select text.", control: { type: "toggle", key: "selectionBubble", defaultValue: DEFAULT_SETTINGS.selectionBubble } }],
      },
      {
        type: "group",
        heading: "Clippings",
        items: [
          {
            name: "Summarize new clippings",
            desc: "When a note appears in the clippings folder, write a short summary into a property. Off by default.",
            control: { type: "toggle", key: "clippingsEnabled", defaultValue: DEFAULT_SETTINGS.clippingsEnabled },
          },
          { name: "Clippings folder", control: { type: "text", key: "clippingsFolder", defaultValue: DEFAULT_SETTINGS.clippingsFolder } },
          { name: "Summary property", control: { type: "text", key: "clippingsProperty", defaultValue: DEFAULT_SETTINGS.clippingsProperty } },
        ],
      },
    ];
  }

  private cliPathRow(setting: Setting) {
    const s = this.plugin.settings;
    setting
      .setName("CLI path")
      .setDesc("Detected automatically. The npm shim is resolved to the native executable it launches.")
      .addText((t) =>
        t
          .setPlaceholder("auto")
          .setValue(s.claudePath)
          .onChange((v) => void this.setControlValue("claudePath", v)),
      )
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          const found = await detectClaude();
          if (!found) return new Notice("Claude Code CLI not found. Install it, then run `claude` once to log in.");
          await this.setControlValue("claudePath", found);
          this.refresh();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            try {
              const v = await claudeVersion(this.plugin.claudePath());
              setting.setDesc(`Connected: ${v}`);
              new Notice(`Claude Studio: ${v}`);
            } catch (e) {
              setting.setDesc(`Failed: ${(e as Error).message}`);
            }
          }),
      );
  }

  /** Redraws after a change Obsidian can't see. `update` only exists from 1.13. */
  private refresh() {
    if (this.legacy) this.draw();
    else (this as unknown as { update?: () => void }).update?.();
  }

  /** The pre-1.13 rendering. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    this.legacy = true;
    this.draw();
  }

  private draw() {
    const { containerEl } = this;
    containerEl.empty();
    for (const group of this.getSettingDefinitions() as unknown as LegacyGroup[]) {
      if (group.type !== "group") continue;
      if (group.heading) new Setting(containerEl).setName(group.heading).setHeading();
      for (const item of group.items ?? []) this.drawItem(item);
    }
  }

  private drawItem(item: LegacyItem) {
    const { containerEl } = this;
    if (item.render) return item.render(new Setting(containerEl));
    const setting = new Setting(containerEl).setName(item.name ?? "");
    if (item.desc) setting.setDesc(item.desc);
    const c = item.control;
    if (!c) return;
    const value = this.getControlValue(c.key);
    const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
    if (c.type === "toggle") setting.addToggle((t) => t.setValue(value === true).onChange((v) => void this.setControlValue(c.key, v)));
    else if (c.type === "textarea")
      setting.addTextArea((t) => {
        t.setValue(text).onChange((v) => void this.setControlValue(c.key, v));
        t.inputEl.rows = c.rows ?? 5;
      });
    else if (c.type === "number")
      setting.addText((t) =>
        t.setValue(text).onChange((v) => {
          const n = Number(v);
          if (v.trim() !== "" && Number.isInteger(n) && n >= (c.min ?? 0)) void this.setControlValue(c.key, n);
        }),
      );
    else if (c.type === "text") setting.addText((t) => t.setValue(text).onChange((v) => void this.setControlValue(c.key, v)));
  }
}
