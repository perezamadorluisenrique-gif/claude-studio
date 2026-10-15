import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isExcludedPath,
  parsePatterns,
  denyRules,
  stripFrontmatter,
  fillTemplate,
  findWikiLinks,
  unlink,
  diffLines,
  unwrapFence,
  extractJson,
  sanitizeFileName,
  openTasks,
  keepFrontmatter,
  usageLevel,
  formatDuration,
} from "../src/util.ts";

test("exclusions match file names, paths and folders", () => {
  const pats = parsePatterns("Contraseña Upwork.md\n# comment\nCorreo 2do\nPrivate/\nNotes/Secret.md\n");
  assert.deepEqual(pats, ["Contraseña Upwork.md", "Correo 2do", "Private/", "Notes/Secret.md"]);
  assert.ok(isExcludedPath("Notes/Contraseña Upwork.md", pats));
  assert.ok(isExcludedPath("Notes/Correo 2do.md", pats));
  assert.ok(isExcludedPath("Private/a.md", pats));
  assert.ok(isExcludedPath("Notes/Private/a.md", pats));
  assert.ok(isExcludedPath("Notes/Secret.md", pats));
  assert.ok(!isExcludedPath("Notes/Correo 2do bis.md", pats));
  assert.ok(!isExcludedPath("Notes/PrivateNotes.md", pats));
});

test("deny rules cover read and edit for files and folders", () => {
  const r = denyRules(["Correo 2do", "Private/"]);
  assert.ok(r.includes("Read(**/Correo 2do.md)"));
  assert.ok(r.includes("Edit(**/Correo 2do.md)"));
  assert.ok(r.includes("Read(**/Private/**)"));
});

test("frontmatter is stripped", () => {
  assert.equal(stripFrontmatter("---\ntags: [a]\n---\nBody\n"), "Body\n");
  assert.equal(stripFrontmatter("No fm"), "No fm");
});

test("templates fill known vars and keep unknown ones", () => {
  const r = fillTemplate("A {{selection}} B {{ title }} {{nope}}", { selection: "x", title: "T" });
  assert.equal(r.text, "A x B T {{nope}}");
  assert.deepEqual([...r.used].sort(), ["selection", "title"]);
});

test("wikilinks are found outside code", () => {
  const md = "See [[Alpha|a]] and ![[Img.png]] and `[[Not]]`\n```\n[[Nope]]\n```\n[[Beta#H]]";
  assert.deepEqual(findWikiLinks(md).map((l) => l.target), ["Alpha", "Img.png", "Beta"]);
});

test("broken links are unlinked keeping the label", () => {
  const out = unlink("x [[Real]] y [[Fake|label]] z [[Gone#h]]", (t) => t !== "Real");
  assert.equal(out, "x [[Real]] y label z Gone");
});

test("line diff", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
  assert.deepEqual(ops.map((o) => o.type[0] + o.text).join(","), "sa,db,aB,sc,sd,ae");
});

test("fence unwrap and json extraction", () => {
  assert.equal(unwrapFence("```markdown\nhi\n```"), "hi");
  assert.equal(unwrapFence("plain"), "plain");
  assert.deepEqual(extractJson('Sure:\n```json\n{"tags":["a"]}\n```'), { tags: ["a"] });
  assert.deepEqual(extractJson('{"a":1} trailing'), { a: 1 });
  assert.equal(extractJson("nothing"), null);
});

test("file names and tasks", () => {
  assert.equal(sanitizeFileName('a/b: "c"?'), "a b c");
  assert.deepEqual(openTasks("- [ ] one\n- [x] done\n  * [ ] two\n- [ ]"), ["- [ ] one", "* [ ] two"]);
});

test("frontmatter survives a rewrite that dropped or changed it", () => {
  const before = "---\ntags:\n  - code\n---\n# T\nold\n";
  assert.equal(keepFrontmatter(before, "# T\nnew\n"), "---\ntags:\n  - code\n---\n# T\nnew\n");
  assert.equal(keepFrontmatter(before, "---\ntags: []\n---\n# T\nnew\n"), "---\ntags:\n  - code\n---\n# T\nnew\n");
  assert.equal(keepFrontmatter("# none\n", "# x\n"), "# x\n");
});

test("usage level thresholds", () => {
  assert.equal(usageLevel(0), "ok");
  assert.equal(usageLevel(0.74), "ok");
  assert.equal(usageLevel(0.75), "high");
  assert.equal(usageLevel(0.95), "full");
  assert.equal(usageLevel(1.2), "full");
});

test("durations until a reset read naturally", () => {
  assert.equal(formatDuration(-5000), "0 min");
  assert.equal(formatDuration(35 * 60000), "35 min");
  assert.equal(formatDuration(120 * 60000), "2 h");
  assert.equal(formatDuration(134 * 60000), "2 h 14 min");
  assert.equal(formatDuration((3 * 24 + 4) * 3600000), "3 d 4 h");
  assert.equal(formatDuration(48 * 3600000), "2 d");
});
