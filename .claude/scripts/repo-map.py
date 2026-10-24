#!/usr/bin/env python3
"""Generate a compact map of the repo (dirs + top-level symbols per file).

Writes .claude/REPO_MAP.md so Claude can orient itself without reading files.
Stdlib only. Usage: repo-map.py [--budget N] [--out PATH]
"""
import argparse
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

SKIP_DIRS = {"node_modules", "dist", "build", "out", "vendor", "target", ".git",
             "__pycache__", ".venv", "venv", ".next", "coverage", "fonts"}
SKIP_NAMES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
              "Cargo.lock", "poetry.lock", "main.js"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".mp4", ".mov", ".pdf",
            ".ttf", ".otf", ".woff", ".woff2", ".zip", ".map", ".min.js", ".lock"}

TS = [r"^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+(\w+)",
      r"^(?:async\s+)?function\*?\s+(\w+)", r"^(?:abstract\s+)?class\s+(\w+)"]
PY = [r"^(?:async\s+)?def\s+(\w+)", r"^class\s+(\w+)"]
PATTERNS = {
    ".ts": TS, ".tsx": TS, ".js": TS, ".jsx": TS, ".mjs": TS, ".cjs": TS,
    ".py": PY,
    ".php": [r"^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+(\w+)",
             r"^\s*(?:public\s+|static\s+)*function\s+(\w+)"],
    ".go": [r"^func\s+(?:\([^)]*\)\s*)?(\w+)", r"^type\s+(\w+)"],
    ".rs": [r"^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)"],
    ".java": [r"^\s*(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+(\w+)"],
    ".kt": [r"^\s*(?:class|object|interface|fun)\s+(\w+)"],
    ".rb": [r"^\s*(?:class|module|def)\s+(\w+)"],
    ".cs": [r"^\s*(?:public\s+|internal\s+)?(?:static\s+)?(?:class|interface|enum|record|struct)\s+(\w+)"],
    ".swift": [r"^\s*(?:public\s+|open\s+)?(?:class|struct|enum|protocol|func)\s+(\w+)"],
    ".sh": [r"^(\w+)\s*\(\)\s*\{"],
}
PATTERNS = {k: [re.compile(p) for p in v] for k, v in PATTERNS.items()}


def tracked_files(root):
    try:
        out = subprocess.run(["git", "-C", root, "ls-files", "-co", "--exclude-standard"],
                             capture_output=True, text=True, check=True).stdout
        files = out.splitlines()
    except Exception:
        files = []
        for d, dirs, names in os.walk(root):
            dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not x.startswith(".")]
            files += [os.path.relpath(os.path.join(d, n), root) for n in names]
    keep = []
    for f in files:
        parts = f.split("/")
        if any(p in SKIP_DIRS for p in parts[:-1]) or parts[-1] in SKIP_NAMES:
            continue
        if f.startswith(".claude/"):
            continue
        if os.path.splitext(f)[1].lower() in SKIP_EXT or not os.path.isfile(os.path.join(root, f)):
            continue
        keep.append(f)
    return sorted(keep)


def symbols(root, f, limit):
    pats = PATTERNS.get(os.path.splitext(f)[1].lower())
    if not pats:
        return []
    found = []
    try:
        with open(os.path.join(root, f), encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                for p in pats:
                    m = p.match(line)
                    if m:
                        if m.group(1) not in found:
                            found.append(m.group(1))
                        break
                if len(found) >= limit:
                    break
    except OSError:
        pass
    return found


def heading(root, f):
    if not f.lower().endswith(".md"):
        return ""
    try:
        with open(os.path.join(root, f), encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if line.startswith("#"):
                    return line.lstrip("# ").strip()[:60]
    except OSError:
        pass
    return ""


def build(root, files, level):
    """level 0: symbols; 1: fewer symbols; 2: filenames only; 3: dirs only."""
    limits = {0: 12, 1: 5, 2: 0, 3: 0}[level]
    by_dir = defaultdict(list)
    for f in files:
        by_dir[os.path.dirname(f) or "."].append(f)
    lines = []
    for d in sorted(by_dir):
        fs = by_dir[d]
        if level == 3:
            ext = Counter(os.path.splitext(x)[1] or x for x in fs)
            lines.append(f"{d}/  ({len(fs)} files: " + ", ".join(f"{n}{e}" for e, n in ext.most_common(4)) + ")")
            continue
        lines.append(f"{d}/")
        # Collapse bulky dirs of same-type files (e.g. chapters, fixtures)
        bulky = level >= 1 or not any(os.path.splitext(x)[1].lower() in PATTERNS for x in fs)
        if len(fs) > 15 and bulky:
            ext = Counter(os.path.splitext(x)[1] for x in fs)
            lines.append("  " + f"({len(fs)} files: " + ", ".join(f"{n}{e}" for e, n in ext.most_common(3)) + ")")
            continue
        for f in fs:
            name = os.path.basename(f)
            syms = symbols(root, f, limits) if limits else []
            extra = heading(root, f) if level < 2 else ""
            if syms:
                lines.append(f"  {name}: " + ", ".join(syms))
            elif extra:
                lines.append(f"  {name} - {extra}")
            else:
                lines.append(f"  {name}")
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=400, help="max lines in the map")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    out = a.out or os.path.join(root, ".claude", "REPO_MAP.md")
    files = tracked_files(root)
    for level in range(4):
        body = build(root, files, level)
        if len(body) <= a.budget or level == 3:
            break
    try:
        head = subprocess.run(["git", "-C", root, "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True).stdout.strip() or "n/a"
    except Exception:
        head = "n/a"
    header = [
        "# Repo map (auto-generated, do not edit)",
        f"Commit {head} · {len(files)} files · detail level {level} (0 = most detail).",
        "Top-level symbols per file; use Grep/Read with offset+limit for the rest.",
        "Regenerate: python3 .claude/scripts/repo-map.py",
        "",
    ]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(header + body) + "\n")
    print(f"wrote {out} ({len(body)} lines, level {level})", file=sys.stderr)


if __name__ == "__main__":
    main()
