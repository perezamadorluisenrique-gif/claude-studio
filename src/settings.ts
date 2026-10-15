import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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

export class StudioSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ClaudeStudio) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    containerEl.addClass("cs-settings");

    new Setting(containerEl).setName("Claude Code CLI").setHeading();

    const pathSetting = new Setting(containerEl)
      .setName("CLI path")
      .setDesc("Detected automatically. The npm shim is resolved to the native executable it launches.")
      .addText((t) =>
        t
          .setPlaceholder("auto")
          .setValue(s.claudePath)
          .onChange(async (v) => {
            s.claudePath = v.trim();
            await save();
          }),
      )
      .addButton((b) =>
        b.setButtonText("Detect").onClick(async () => {
          const found = await detectClaude();
          if (!found) return new Notice("Claude Code CLI not found. Install it, then run `claude` once to log in.");
          s.claudePath = found;
          await save();
          this.display();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            try {
              const v = await claudeVersion(this.plugin.claudePath());
              pathSetting.setDesc(`Connected: ${v}`);
              new Notice(`Claude Studio: ${v}`);
            } catch (e) {
              pathSetting.setDesc(`Failed: ${(e as Error).message}`);
            }
          }),
      );

    new Setting(containerEl)
      .setName("Use my subscription")
      .setDesc("Remove ANTHROPIC_API_KEY from the CLI's environment so runs use your logged-in Claude plan.")
      .addToggle((t) =>
        t.setValue(s.stripApiKey).onChange(async (v) => {
          s.stripApiKey = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("Models").setHeading();
    const model = (name: string, desc: string, key: "fastModel" | "writeModel" | "chatModel") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim();
            await save();
          }),
        );
    model("Fast", "Selection edits, ghost text, tags, clippings. Actions refer to it as `fast`.", "fastModel");
    model("Write", "Whole-note work, recaps, Bases. Actions refer to it as `write`.", "writeModel");
    model("Chat", "Side panel conversations. Actions refer to it as `chat`.", "chatModel");

    new Setting(containerEl).setName("Vault layout").setHeading();
    const folder = (name: string, desc: string, key: "libraryFolder" | "notesFolder" | "hubFolder" | "basesFolder") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v.trim().replace(/\/+$/, "");
            await save();
            if (key === "libraryFolder") this.plugin.library.reload();
          }),
        );
    folder("Library folder", "Holds Actions/ and Profiles/ — every action and profile is a note you can edit.", "libraryFolder");
    folder("New notes folder", "Where Extract to note creates notes.", "notesFolder");
    folder("Project hubs folder", "Notes here are treated as project hubs and added as context to linked notes.", "hubFolder");
    folder("Bases folder", "Where generated .base files are saved.", "basesFolder");

    new Setting(containerEl).setName("Privacy").setHeading();
    new Setting(containerEl)
      .setName("Never send these notes")
      .setDesc("One per line: a note name, a path, or a folder ending in /. Enforced in the plugin and as CLI deny rules, including sibling vaults.")
      .addTextArea((t) => {
        t.setValue(s.exclude).onChange(async (v) => {
          s.exclude = v;
          await save();
        });
        t.inputEl.rows = 5;
      });
    new Setting(containerEl)
      .setName("Never send notes with these tags")
      .setDesc("Comma-separated, without #.")
      .addText((t) =>
        t.setValue(s.excludeTags).onChange(async (v) => {
          s.excludeTags = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("Context").setHeading();
    const num = (name: string, desc: string, key: "contextChars" | "linkedNotes" | "linkedNoteChars") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 0) {
              s[key] = n;
              await save();
            }
          }),
        );
    num("Text around the cursor", "Characters sent when nothing is selected.", "contextChars");
    num("Linked notes", "How many outgoing links are offered as context chips.", "linkedNotes");
    num("Linked note excerpt", "Characters taken from each linked note.", "linkedNoteChars");

    new Setting(containerEl).setName("Sibling vaults").setHeading();
    const vaults = knownVaults(this.plugin.vaultPath());
    if (!vaults.length) containerEl.createEl("p", { text: "No other vaults registered in Obsidian.", cls: "setting-item-description" });
    for (const v of vaults) {
      new Setting(containerEl)
        .setName(v.name)
        .setDesc("Chat can search this vault (read-only) and answers with obsidian:// links to it.")
        .addToggle((t) =>
          t.setValue(s.siblingVaults.includes(v.path)).onChange(async (on) => {
            s.siblingVaults = on ? [...new Set([...s.siblingVaults, v.path])] : s.siblingVaults.filter((p) => p !== v.path);
            await save();
          }),
        );
    }

    new Setting(containerEl).setName("Editor").setHeading();
    new Setting(containerEl)
      .setName("Selection toolbar")
      .setDesc("Show the floating action bar when you select text.")
      .addToggle((t) =>
        t.setValue(s.selectionBubble).onChange(async (v) => {
          s.selectionBubble = v;
          await save();
        }),
      );

    new Setting(containerEl).setName("Clippings").setHeading();
    new Setting(containerEl)
      .setName("Summarize new clippings")
      .setDesc("When a note appears in the clippings folder, write a short summary into a property. Off by default.")
      .addToggle((t) =>
        t.setValue(s.clippingsEnabled).onChange(async (v) => {
          s.clippingsEnabled = v;
          await save();
        }),
      );
    new Setting(containerEl).setName("Clippings folder").addText((t) =>
      t.setValue(s.clippingsFolder).onChange(async (v) => {
        s.clippingsFolder = v.trim().replace(/\/+$/, "");
        await save();
      }),
    );
    new Setting(containerEl).setName("Summary property").addText((t) =>
      t.setValue(s.clippingsProperty).onChange(async (v) => {
        s.clippingsProperty = v.trim() || "summary";
        await save();
      }),
    );
  }
}
