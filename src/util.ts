// Pure helpers (no Obsidian imports) so they can be unit-tested with plain Node.

/** One exclusion pattern per line: `Folder/` excludes a folder, anything else matches a file name or full path. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export function isExcludedPath(path: string, patterns: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;
  return patterns.some((raw) => {
    const pat = raw.replace(/\\/g, "/");
    if (pat.endsWith("/")) return p.startsWith(pat) || p.includes("/" + pat);
    if (pat.includes("/")) return p === pat || p.endsWith("/" + pat);
    const noExt = base.replace(/\.md$/i, "");
    return base === pat || noExt === pat;
  });
}

/** Deny rules for the CLI. They also have to cover --add-dir folders, which project settings don't. */
export function denyRules(patterns: string[], extraPaths: string[] = []): string[] {
  const rules: string[] = [];
  const add = (glob: string) => {
    for (const tool of ["Read", "Edit"]) rules.push(`${tool}(${glob})`);
  };
  for (const raw of patterns) {
    const pat = raw.replace(/\\/g, "/");
    if (pat.endsWith("/")) add(`**/${pat}**`);
    else add(`**/${/\.[a-z0-9]+$/i.test(pat) ? pat : pat + ".md"}`);
  }
  for (const p of extraPaths) add(`**/${p.replace(/\\/g, "/")}`);
  return [...new Set(rules)];
}

export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  const after = text.indexOf("\n", end + 4);
  return after < 0 ? "" : text.slice(after + 1);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[… truncated, ${text.length - max} more characters]`;
}

/** `{{name}}` substitution. Unknown variables are left visible so a typo in an action note is easy to spot. */
export function fillTemplate(tpl: string, vars: Record<string, string | undefined>): { text: string; used: Set<string> } {
  const used = new Set<string>();
  const text = tpl.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, name: string) => {
    const v = vars[name];
    if (v === undefined) return m;
    used.add(name);
    return v;
  });
  return { text, used };
}

export interface WikiLink {
  raw: string;
  target: string;
  from: number;
  to: number;
  embed: boolean;
}

/** Wikilinks outside code spans and fenced blocks. */
export function findWikiLinks(md: string): WikiLink[] {
  const out: WikiLink[] = [];
  const masked = md
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  const re = /(!?)\[\[([^\]\n]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const inner = m[2];
    const target = inner.split("|")[0].split("#")[0].trim();
    out.push({ raw: md.slice(m.index, m.index + m[0].length), target, from: m.index, to: m.index + m[0].length, embed: m[1] === "!" });
  }
  return out;
}

/** Turn `[[Missing note|alias]]` into plain `alias` (or `Missing note`). */
export function unlink(md: string, isBroken: (target: string) => boolean): string {
  const links = findWikiLinks(md).filter((l) => l.target && isBroken(l.target));
  let s = md;
  for (const l of links.reverse()) {
    const inner = l.raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "");
    const label = inner.includes("|") ? inner.split("|").slice(1).join("|") : inner.split("#")[0];
    s = s.slice(0, l.from) + label + s.slice(l.to);
  }
  return s;
}

export type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Line diff via LCS. Fine for notes (thousands of lines), not meant for huge files. */
export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.split("\n");
  const B = b.split("\n");
  // Trim common prefix/suffix first: most edits touch a small region.
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const a2 = A.slice(start, endA);
  const b2 = B.slice(start, endB);
  const n = a2.length;
  const m = b2.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const mid: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a2[i] === b2[j]) {
      mid.push({ type: "same", text: a2[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push({ type: "del", text: a2[i++] });
    else mid.push({ type: "add", text: b2[j++] });
  }
  while (i < n) mid.push({ type: "del", text: a2[i++] });
  while (j < m) mid.push({ type: "add", text: b2[j++] });
  return [
    ...A.slice(0, start).map((text) => ({ type: "same" as const, text })),
    ...mid,
    ...A.slice(endA).map((text) => ({ type: "same" as const, text })),
  ];
}

/** Model output sometimes wraps everything in one ```markdown fence; inline edits never want that. */
export function unwrapFence(text: string): string {
  const m = text.trim().match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  return m ? m[1] : text;
}

/** Pull the first JSON object/array out of a model reply. */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
}

export function openTasks(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => /^\s*[-*+]\s+\[ \]\s+\S/.test(l))
    .map((l) => l.trim());
}

/** If the model dropped or mangled the frontmatter, put the original back. */
export function keepFrontmatter(before: string, after: string): string {
  const fmRe = /^---\n[\s\S]*?\n---\n?/;
  const orig = before.match(fmRe)?.[0];
  if (!orig) return after;
  const body = after.replace(fmRe, "");
  return orig + (orig.endsWith("\n") ? "" : "\n") + body.replace(/^\n+/, "");
}

export type UsageLevel = "ok" | "high" | "full";

/** Bar colour for a 0..1 utilization: calm below 75%, warning up to 95%, full beyond. */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 0.95) return "full";
  if (utilization >= 0.75) return "high";
  return "ok";
}

/** "2 h 14 min", "35 min", "3 d 4 h" — the time left until a reset. */
export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
