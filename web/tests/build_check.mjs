// Checks that the page builds as the GitHub Actions job builds it (.github/workflows/pages.yml): from a clean
// checkout, on a file system that tells upper case from lower case, with `npm run typecheck` and
// `npm run build:web`, and that the build takes its stamp from GITHUB_SHA.
//
//   node web/tests/build_check.mjs [--out DIR] [--library worktree|head] [--names-only]     (from anywhere)
//
// 1. Names. Every relative import of the files the type check reads (src, tests, web, vitest.config.ts), every
//    file a page or a style sheet of web/ refers to, and every path of the repository that a script of
//    web/tests names is compared with the names on disk, letter by letter. Windows and macOS find a file under a
//    name in the wrong case; the job's Linux does not.
// 2. A clean build. What a checkout holds is copied into a new directory outside the repository: the files git
//    tracks (as they are in the working tree, or with --library head as the last commit has them) and, as they
//    are in the working tree, web/ and docs/progress/web.md, tracked or not, without what git ignores. The
//    directory is made case-sensitive where the file system can (Windows: fsutil), so that a wrong case fails
//    here as it would on Linux. There `npm run typecheck` and `npm run build:web` run, the build once without
//    GITHUB_SHA and once with one, and what was built is looked at: one page, one classic script and one style
//    sheet, all referred to relatively; the stamp "dev", then the first seven characters of the commit.
//
// The job's `npm ci` is not run: the directory's node_modules is a link to the repository's. Nothing is written
// inside the repository, and git is only read. It prints what it found and, last, one line of JSON; it exits
// with 0 only if nothing is wrong. The built page stays in DIR/checkout/dist-web, stamped with the commit
// below, for the browser check: `python web/tests/browser_check.py --dist DIR/checkout/dist-web --build 0123456`.

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** The commit the stamped build is told it is built from: no real one. */
const COMMIT = "aeb7cf3d41e60852fa9bc4d01e735f682a094db6";
/** What `npm run typecheck` reads (tsconfig.json's include). */
const TYPE_CHECKED = ["src", "tests", "web", "vitest.config.ts"];
/** What of the working tree belongs to the page, committed yet or not. */
const PAGE_PATHS = ["web", "docs/progress/web.md"];

function argument(name, fallback) {
  const index = process.argv.indexOf(name);

  return index === -1 ? fallback : process.argv[index + 1];
}

const library = argument("--library", "worktree");
const isNamesOnly = process.argv.includes("--names-only");
if (!["worktree", "head"].includes(library)) {
  console.error("--library is worktree or head");
  process.exit(2);
}

const problems = [];
const notes = [];

function git(...parameters) {
  // --no-optional-locks: nothing is written, not even the index's cache of file times
  return execFileSync("git", ["--no-optional-locks", ...parameters], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

function listed(...parameters) {
  return git(...parameters)
    .split("\0")
    .filter((name) => name !== "");
}

// ---------------------------------------------------------------- 1. names

const listings = new Map();

function namesIn(directory) {
  if (!listings.has(directory)) {
    let names = null;
    try {
      names = readdirSync(directory);
    } catch {
      // no such directory
    }
    listings.set(directory, names);
  }

  return listings.get(directory);
}

/** Returns "exact" when ``path`` (below the repository) exists under exactly these names, "case" when only under
 * names in another case, and "missing" when not at all. */
function existence(path) {
  let directory = repository;
  let isExact = true;
  for (const segment of relative(repository, path).split(sep)) {
    if (segment === "" || segment === ".") continue;
    const names = namesIn(directory);
    if (names === null) return "missing";
    if (names.includes(segment)) directory = join(directory, segment);
    else {
      const other = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      if (other === undefined) return "missing";
      isExact = false;
      directory = join(directory, other);
    }
  }

  return isExact ? "exact" : "case";
}

/** The endings a bundler and the type check try for an import without one. */
const ENDINGS = ["", ".ts", ".tsx", ".mts", ".d.ts", ".js", ".mjs", ".json", "/index.ts", "/index.js"];

/** Checks one relative reference of ``file``; ``isImport`` lets it lack its ending. */
function checkReference(file, reference, isImport) {
  const clean = reference.replace(/[?#].*$/, "");
  if (clean === "") return;
  const target = resolve(dirname(file), clean);
  if (relative(repository, target).startsWith("..")) return; // outside the repository: not a file of it
  const found = (isImport ? ENDINGS : [""]).map((ending) => existence(target + ending));
  if (found.includes("exact")) return;

  const where = `${relative(repository, file).split(sep).join("/")}: ${reference}`;
  problems.push(found.includes("case") ? `wrong case: ${where}` : `not found: ${where}`);
}

function filesUnder(path, endings) {
  const start = join(repository, path);
  if (!existsSync(start)) return [];
  if (statSync(start).isFile()) return endings.some((ending) => start.endsWith(ending)) ? [start] : [];

  const found = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const below = join(path, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(below, endings));
    else if (endings.some((ending) => entry.name.endsWith(ending))) found.push(join(repository, below));
  }

  return found;
}

let references = 0;
const sources = TYPE_CHECKED.flatMap((path) => filesUnder(path, [".ts", ".mts", ".mjs", ".js"]));
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const patterns = [
    /\bfrom\s+["']([^"'\n]+)["']/g, // import ... from, export ... from
    /\bimport\s+["']([^"'\n]+)["']/g, // import for its effect
    /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bnew URL\(\s*["']([^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!match[1].startsWith("./") && !match[1].startsWith("../") && match[1] !== "." && match[1] !== "..") continue;
      references += 1;
      checkReference(file, match[1], true);
    }
  }
}
for (const file of filesUnder("web", [".html", ".css"])) {
  const text = readFileSync(file, "utf8");
  const patterns = file.endsWith(".html")
    ? [/\b(?:src|href)\s*=\s*["']([^"']+)["']/g]
    : [/url\(\s*["']?([^"')]+)["']?\s*\)/g, /@import\s+["']([^"']+)["']/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(match[1])) continue; // another site, a place in the page, data
      references += 1;
      checkReference(file, match[1], false);
    }
  }
}
// the paths of the repository that the check's own scripts name
for (const file of filesUnder("web/tests", [".py", ".sh", ".mjs", ".ts"])) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/["'`]((?:web|src|tests|docs|node_modules)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_])["'`]/g)) {
    references += 1;
    const found = existence(join(repository, match[1]));
    const where = `${relative(repository, file).split(sep).join("/")}: ${match[1]}`;
    if (found === "case") problems.push(`wrong case: ${where}`);
    else if (found === "missing") problems.push(`not found: ${where}`);
  }
}
console.log(`names: ${references} references in ${sources.length} scripts and web/'s pages, style sheets and tests compared with the disk`);

// ---------------------------------------------------------------- 2. a clean build

const summary = { names: references, library, caseSensitive: null, typecheck: null, builds: {}, uncommitted: null };

/** Runs an npm script as the job does and returns whether it succeeded; its last lines are printed if not. */
function npmRun(script, directory, environment) {
  const run = spawnSync(`npm run ${script}`, {
    cwd: directory,
    env: environment,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.status !== 0) {
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
    problems.push(`npm run ${script} failed in the clean copy (exit ${run.status})`);
    console.log(output);
  }

  return run.status === 0;
}

/** Looks at what `npm run build:web` built in ``directory`` and returns the text of the page's script. */
function lookAtBuild(directory, label) {
  const dist = join(directory, "dist-web");
  const pagePath = join(dist, "index.html");
  if (!existsSync(pagePath)) {
    problems.push(`${label}: no dist-web/index.html`);
    return "";
  }
  const page = readFileSync(pagePath, "utf8");
  const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]);
  const sheets = [...page.matchAll(/<link\b([^>]*rel="stylesheet"[^>]*)>/g)].map((match) => match[1]);
  const referred = [...page.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const own = referred.filter((reference) => !/^(?:https?:|#)/.test(reference));
  if (scripts.length !== 1 || !/\bdefer\b/.test(scripts[0]) || /type="module"|crossorigin/.test(scripts[0])) {
    problems.push(`${label}: the page does not have exactly one classic, deferred script: ${scripts.join(" | ")}`);
  }
  if (sheets.length !== 1) problems.push(`${label}: the page does not link exactly one style sheet`);
  if (own.length !== 2 || own.some((reference) => !reference.startsWith("./assets/"))) {
    // a path from the host's root would not be found under https://<host>/<repository>/
    problems.push(`${label}: the page's own files are not all referred to as ./assets/...: ${own.join(", ")}`);
  }
  for (const reference of own) {
    if (!existsSync(join(dist, reference))) problems.push(`${label}: ${reference} is not in dist-web`);
  }
  const names = readdirSync(dist).sort();
  if (names.join(" ") !== "assets index.html") problems.push(`${label}: dist-web holds ${names.join(", ")}`);

  const script = own.find((reference) => reference.endsWith(".js"));

  return script === undefined ? "" : readFileSync(join(dist, script), "utf8");
}

if (!isNamesOnly) {
  const given = argument("--out", null);
  const out = given === null ? mkdtempSync(join(tmpdir(), "pearjs-build-check-")) : resolve(given);
  if (out === repository || !relative(repository, out).startsWith("..")) {
    console.error("--out must not be inside the repository");
    process.exit(2);
  }
  const checkout = join(out, "checkout");
  try {
    // the link of an earlier run, taken away by itself: what it points to is the repository's and stays
    rmdirSync(join(checkout, "node_modules"));
  } catch {
    // there was none
  }
  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(checkout, { recursive: true });

  // a directory that tells upper case from lower case, as the job's file system does
  if (process.platform === "win32") {
    spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", checkout, "enable"], { encoding: "utf8", windowsHide: true });
  }
  writeFileSync(join(checkout, "CaseProbe"), "");
  summary.caseSensitive = !existsSync(join(checkout, "caseprobe"));
  rmSync(join(checkout, "CaseProbe"));
  if (!summary.caseSensitive) {
    notes.push("the clean copy is on a file system that does not tell upper case from lower case: only the comparison of names stands for the job's Linux");
  }

  const isPage = (name) => PAGE_PATHS.some((path) => name === path || name.startsWith(`${path}/`));
  const copy = (name) => {
    const source = join(repository, name);
    if (!existsSync(source)) return false;
    const target = join(checkout, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    return true;
  };

  // what git tracks, without the page's own paths
  let copied = 0;
  if (library === "head") {
    const archive = join(out, "head.tar");
    git("archive", "--format=tar", "-o", archive, "HEAD");
    execFileSync("tar", ["-xf", archive, "-C", checkout], { windowsHide: true });
    rmSync(archive);
    for (const path of PAGE_PATHS) rmSync(join(checkout, path), { recursive: true, force: true });
    copied = listed("ls-tree", "-r", "-z", "--name-only", "HEAD").filter((name) => !isPage(name)).length;
  } else {
    for (const name of listed("ls-files", "-z")) {
      if (!isPage(name) && copy(name)) copied += 1;
    }
  }
  // the page's own paths as they are in the working tree, tracked or not, without what git ignores
  const pageFiles = listed("ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...PAGE_PATHS);
  let pages = 0;
  for (const name of new Set(pageFiles)) {
    if (copy(name)) pages += 1;
  }
  symlinkSync(join(repository, "node_modules"), join(checkout, "node_modules"), "junction");
  console.log(
    `clean copy: ${copied} tracked files (${library === "head" ? "as the last commit has them" : "as in the working tree"}) ` +
      `and ${pages} files of ${PAGE_PATHS.join(", ")}; case-sensitive: ${summary.caseSensitive}`,
  );

  // what a commit of the page has to bring along: the working tree against the last commit
  const untracked = listed("ls-files", "-z", "--others", "--exclude-standard", "--", ...PAGE_PATHS);
  const changed = listed("diff", "--name-only", "-z", "HEAD");
  summary.uncommitted = { pageFilesNotTracked: untracked.length, trackedFilesThatDifferFromHead: changed.length };
  notes.push(
    `not committed yet: ${untracked.length} untracked files of the page; ${changed.length} tracked files differ from the last commit ` +
      `(${changed.filter((name) => name.startsWith("src/")).length} of them under src/)`,
  );

  const environment = { ...process.env };
  delete environment.GITHUB_SHA;
  summary.typecheck = npmRun("typecheck", checkout, environment);
  console.log(`npm run typecheck: ${summary.typecheck ? "passed" : "FAILED"}`);

  // the build as on a developer's machine, then as the job runs it
  for (const [label, sha, stamp] of [
    ["without GITHUB_SHA", null, "dev"],
    ["with GITHUB_SHA", COMMIT, COMMIT.slice(0, 7)],
  ]) {
    rmSync(join(checkout, "dist-web"), { recursive: true, force: true });
    const passed = npmRun("build:web", checkout, sha === null ? environment : { ...environment, GITHUB_SHA: sha });
    const script = passed ? lookAtBuild(checkout, label) : "";
    // the stamp is a constant of the script: the first seven characters, and no more of the commit than those
    const hasStamp = script.includes(`pear.js build ${stamp}`);
    const hasMore = script.includes(COMMIT.slice(0, 8));
    if (passed && !hasStamp) problems.push(`${label}: the script does not say "pear.js build ${stamp}"`);
    if (passed && hasMore) problems.push(`${label}: the script holds more of the commit than seven characters`);
    if (passed && sha === null && script.includes(COMMIT.slice(0, 7))) problems.push(`${label}: the script holds a commit`);
    summary.builds[label] = { passed, stamp: hasStamp ? stamp : null, scriptBytes: script.length };
    console.log(`npm run build:web ${label}: ${passed ? "built" : "FAILED"}${hasStamp ? `, stamped ${stamp}` : ""}`);
  }
  summary.checkout = checkout;
}

for (const note of notes) console.log(`note: ${note}`);
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
console.log(JSON.stringify({ ...summary, problems: problems.length }));
process.exit(problems.length === 0 ? 0 : 1);
