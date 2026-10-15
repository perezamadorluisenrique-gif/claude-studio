import { spawn, execFile, type ChildProcessWithoutNullStreams } from "child_process";
import { t } from "./i18n";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IS_WIN = process.platform === "win32";

export interface RunRequest {
  prompt: string;
  cwd: string;
  /** Appended to Claude Code's own system prompt (CLAUDE.md is still loaded). */
  system?: string;
  model?: string;
  /** null/undefined = CLI defaults, [] = no tools at all, otherwise the exact built-in set. */
  tools?: string[] | null;
  sessionId?: string;
  addDirs?: string[];
  maxTurns?: number;
  /** Quick inline actions don't need to clutter `claude --resume`. */
  persist?: boolean;
  /** Extra settings JSON (used for deny rules that must also cover --add-dir folders). */
  settings?: object;
}

export interface RunResult {
  text: string;
  sessionId: string;
  isError: boolean;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** One usage window as the CLI reports it (`rate_limit_event`); utilization is 0..1, resetsAt in epoch seconds. */
export interface UsageWindow {
  utilization: number;
  resetsAt: number;
}

export interface RateLimitInfo {
  /** "allowed", "allowed_warning" or "rejected". */
  status: string;
  rateLimitType?: string;
  resetsAt?: number;
  windows: Record<string, UsageWindow>;
}

/** The `rate_limit_info` object of a `rate_limit_event` in the CLI's stream. */
interface RawRateLimit {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number | string;
  unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: number | string } | null>;
}

export function parseRateLimit(m: { rate_limit_info?: RawRateLimit } | null | undefined): RateLimitInfo | null {
  const i = m?.rate_limit_info;
  if (!i) return null;
  const windows: Record<string, UsageWindow> = {};
  for (const [k, w] of Object.entries(i.unifiedWindows ?? {})) {
    if (typeof w?.utilization === "number") windows[k] = { utilization: w.utilization, resetsAt: Number(w.resetsAt) || 0 };
  }
  return { status: String(i.status ?? "allowed"), rateLimitType: i.rateLimitType, resetsAt: Number(i.resetsAt) || undefined, windows };
}

/** One line of the CLI's `stream-json` output; only the fields the plugin reads. */
interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: { type?: string; name?: string; input?: ToolInput; text?: string }[] };
  rate_limit_info?: RawRateLimit;
  result?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ToolInput {
  file_path?: string;
  pattern?: string;
  path?: string;
}

export interface RunCallbacks {
  onInit?: (sessionId: string) => void;
  onRateLimit?: (info: RateLimitInfo) => void;
  onDelta?: (text: string) => void;
  onTool?: (name: string, summary: string) => void;
  onResult?: (r: RunResult) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export interface RunHandle {
  cancel(): void;
  readonly done: Promise<RunResult | null>;
}

/** Resolve the npm `claude.cmd` shim to the native exe it launches, so we can spawn without a shell. */
export function resolveExecutable(p: string): string {
  if (!IS_WIN || !p.toLowerCase().endsWith(".cmd") || !fs.existsSync(p)) return p;
  try {
    const shim = fs.readFileSync(p, "utf8");
    const m = shim.match(/"%dp0%\\([^"]+\.exe)"/i);
    if (m) {
      const exe = path.join(path.dirname(p), m[1]);
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* fall through to the shim itself */
  }
  return p;
}

/** Candidate install locations, most specific first. */
export function candidatePaths(): string[] {
  const home = os.homedir();
  if (IS_WIN) {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(appData, "npm", "claude.cmd"),
      path.join(home, ".claude", "local", "claude.exe"),
    ];
  }
  return [
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

/** Find the CLI: known locations first, then `where`/`which` through a login shell. */
export async function detectClaude(): Promise<string | null> {
  for (const c of candidatePaths()) if (fs.existsSync(c)) return resolveExecutable(c);
  return new Promise((resolve) => {
    const cmd = IS_WIN ? "where" : "/bin/sh";
    const args = IS_WIN ? ["claude"] : ["-lc", "command -v claude"];
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const pick = lines.find((l) => /\.(exe|cmd)$/i.test(l)) ?? lines[0];
      resolve(pick ? resolveExecutable(pick) : null);
    });
  });
}

export function buildEnv(stripApiKey: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const extra = candidatePaths().map((p) => path.dirname(p));
  env[pathKey] = [...extra, env[pathKey] ?? ""].filter(Boolean).join(path.delimiter);
  // With an API key in the environment the CLI bills the API instead of the subscription.
  if (stripApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

export function buildArgs(req: RunRequest): string[] {
  // --strict-mcp-config: none of our runs use MCP, and loading the user's servers costs seconds per call.
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config"];
  if (req.model) args.push("--model", req.model);
  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.tools) args.push("--tools", req.tools.join(","));
  if (req.sessionId) args.push("--resume", req.sessionId);
  if (req.maxTurns) args.push("--max-turns", String(req.maxTurns));
  if (req.persist === false) args.push("--no-session-persistence");
  if (req.settings) args.push("--settings", JSON.stringify(req.settings));
  for (const d of req.addDirs ?? []) args.push("--add-dir", d);
  return args;
}

function summarizeTool(input: ToolInput | undefined): string {
  if (!input) return "";
  if (input.file_path) return path.basename(String(input.file_path));
  if (input.pattern) return String(input.pattern);
  if (input.path) return String(input.path);
  return "";
}

export function runClaude(
  claudePath: string,
  req: RunRequest,
  cb: RunCallbacks,
  opts: { stripApiKey?: boolean } = {},
): RunHandle {
  const exe = resolveExecutable(claudePath || "claude");
  const useShell = IS_WIN && exe.toLowerCase().endsWith(".cmd");
  let resolveDone!: (r: RunResult | null) => void;
  const done = new Promise<RunResult | null>((r) => (resolveDone = r));

  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(exe, buildArgs(req), {
      cwd: req.cwd,
      env: buildEnv(opts.stripApiKey ?? true),
      shell: useShell,
      windowsHide: true,
    });
  } catch (err) {
    cb.onError?.(String(err));
    cb.onClose?.();
    resolveDone(null);
    return { cancel() {}, done };
  }

  let buf = "";
  let stderr = "";
  let result: RunResult | null = null;
  let cancelled = false;
  let spawnError = false;
  let sessionId = req.sessionId ?? "";
  let streamed = false;

  const handle = (line: string) => {
    let m: StreamLine;
    try {
      m = JSON.parse(line) as StreamLine;
    } catch {
      return;
    }
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id ?? sessionId;
      cb.onInit?.(sessionId);
    } else if (m.type === "stream_event") {
      const d = m.event?.delta;
      if (m.event?.type === "content_block_delta" && d?.type === "text_delta" && d.text) {
        streamed = true;
        cb.onDelta?.(d.text);
      }
    } else if (m.type === "assistant") {
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") cb.onTool?.(b.name ?? "", summarizeTool(b.input));
        // Without partial messages (older CLIs) the full text arrives here instead.
        else if (b.type === "text" && !streamed && b.text) cb.onDelta?.(b.text);
      }
      streamed = false;
    } else if (m.type === "rate_limit_event") {
      const info = parseRateLimit(m);
      if (info) cb.onRateLimit?.(info);
    } else if (m.type === "result") {
      const r: RunResult = {
        text: typeof m.result === "string" ? m.result : "",
        sessionId: m.session_id ?? sessionId,
        isError: !!m.is_error || (!!m.subtype && m.subtype !== "success"),
        costUsd: m.total_cost_usd ?? 0,
        durationMs: m.duration_ms ?? 0,
        inputTokens: m.usage?.input_tokens ?? 0,
        outputTokens: m.usage?.output_tokens ?? 0,
      };
      if (m.subtype === "error_max_turns") r.text = t("error.turnLimit");
      result = r;
      cb.onResult?.(r);
    }
  };

  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString("utf8")).slice(-4000);
  });
  proc.on("error", (err: NodeJS.ErrnoException) => {
    spawnError = true;
    cb.onError?.(
      err.code === "ENOENT"
        ? t("error.cliNotFound")
        : err.message,
    );
  });
  proc.on("close", (code) => {
    if (buf.trim()) handle(buf.trim());
    if (!result && !spawnError) {
      if (cancelled) cb.onError?.(t("error.stopped"));
      else if (code !== 0)
        cb.onError?.(stderr.trim() || t("error.exitCode", { code: String(code) }));
    }
    cb.onClose?.();
    resolveDone(result);
  });

  proc.stdin.on("error", () => {});
  proc.stdin.end(req.prompt, "utf8");

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      if (IS_WIN && proc.pid) spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
      else proc.kill("SIGTERM");
    },
  };
}

/** `claude --version`, for the settings "Test" button. */
export function claudeVersion(claudePath: string): Promise<string> {
  const exe = resolveExecutable(claudePath || "claude");
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ["--version"],
      { windowsHide: true, shell: IS_WIN && exe.toLowerCase().endsWith(".cmd"), env: buildEnv(false) },
      (err, stdout) => (err ? reject(err instanceof Error ? err : new Error("claude --version failed")) : resolve(stdout.trim())),
    );
  });
}
