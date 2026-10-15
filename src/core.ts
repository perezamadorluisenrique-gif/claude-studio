import { App, FileSystemAdapter, TFile, getAllTags } from "obsidian";
import { t } from "./i18n";
import type { StudioSettings } from "./settings";
import { runClaude, resolveExecutable, type RateLimitInfo, type RunCallbacks, type RunHandle, type RunRequest } from "./runner";
import { denyRules, isExcludedPath, parsePatterns } from "./util";

const NO_TOOLS =
  "You have no tools in this run: do not search, read files or call functions, and never write tool-call markup. Everything you need is in the request; if something is missing, work with what is there.";

export type RunSpec = Omit<RunRequest, "cwd" | "settings"> & { label?: string };

/** Everything that talks to the CLI goes through here so exclusions and status are applied once. */
export class Core {
  private active = new Set<RunHandle>();
  private listeners = new Set<(running: string[]) => void>();
  private labels = new Map<RunHandle, string>();
  detectedPath = "";
  /** Receives the usage-limit snapshot every run reports. */
  usageSink?: (info: RateLimitInfo) => void;

  constructor(
    private app: App,
    private getSettings: () => StudioSettings,
  ) {}

  get settings() {
    return this.getSettings();
  }

  vaultPath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : "";
  }

  vaultName(): string {
    return this.app.vault.getName();
  }

  claudePath(): string {
    return resolveExecutable(this.settings.claudePath || this.detectedPath || "claude");
  }

  model(m?: string): string {
    const s = this.settings;
    if (!m || m === "fast") return s.fastModel;
    if (m === "write") return s.writeModel;
    if (m === "chat") return s.chatModel;
    return m;
  }

  patterns(): string[] {
    return parsePatterns(this.settings.exclude);
  }

  excludedTags(): string[] {
    return this.settings.excludeTags
      .split(",")
      .map((t) => t.trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean);
  }

  isExcluded(file: TFile | string): boolean {
    const p = typeof file === "string" ? file : file.path;
    if (isExcludedPath(p, this.patterns())) return true;
    const f = typeof file === "string" ? this.app.vault.getAbstractFileByPath(file) : file;
    const tags = this.excludedTags();
    if (!tags.length || !(f instanceof TFile)) return false;
    const cache = this.app.metadataCache.getFileCache(f);
    const own = (cache ? getAllTags(cache) ?? [] : []).map((t) => t.replace(/^#/, "").toLowerCase());
    return own.some((t) => tags.includes(t));
  }

  /** Notes excluded by tag can't be expressed as a static pattern, so they're listed by path. */
  denySettings(): object {
    const tagged = this.excludedTags().length
      ? this.app.vault
          .getMarkdownFiles()
          .filter((f) => !isExcludedPath(f.path, this.patterns()) && this.isExcluded(f))
          .map((f) => f.path)
      : [];
    return { permissions: { deny: denyRules(this.patterns(), tagged) } };
  }

  run(spec: RunSpec, cb: RunCallbacks): RunHandle {
    // Filled in once `runClaude` returns; `onClose` can fire before that, when it is still empty.
    const started: { handle?: RunHandle } = {};
    const close = cb.onClose;
    const wrapped: RunCallbacks = {
      ...cb,
      onRateLimit: (i) => {
        this.usageSink?.(i);
        cb.onRateLimit?.(i);
      },
      onClose: () => {
        if (started.handle) {
          this.active.delete(started.handle);
          this.labels.delete(started.handle);
        }
        this.emit();
        close?.();
      },
    };
    const handle = (started.handle = runClaude(
      this.claudePath(),
      {
        ...spec,
        // Without this, tool-less runs sometimes "call" tools as plain text (seen in recaps).
        system: spec.tools?.length === 0 ? [spec.system, NO_TOOLS].filter(Boolean).join("\n\n") : spec.system,
        model: this.model(spec.model),
        cwd: this.vaultPath(),
        settings: this.denySettings(),
      },
      wrapped,
      { stripApiKey: this.settings.stripApiKey },
    ));
    this.active.add(handle);
    this.labels.set(handle, spec.label ?? t("work.working"));
    this.emit();
    return handle;
  }

  /** Promise form for one-shot calls (API, tags, titles). */
  async complete(spec: RunSpec): Promise<string> {
    let text = "";
    let error = "";
    const h = this.run(spec, {
      onDelta: (t) => (text += t),
      onError: (m) => (error = m),
    });
    const r = await h.done;
    if (!r) throw new Error(error || t("error.noResult"));
    if (r.isError) throw new Error(r.text || error || t("error.claudeError"));
    return r.text || text;
  }

  stopAll() {
    for (const h of [...this.active]) h.cancel();
  }

  running(): string[] {
    return [...this.labels.values()];
  }

  onChange(fn: (running: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const r = this.running();
    for (const l of this.listeners) l(r);
  }
}
