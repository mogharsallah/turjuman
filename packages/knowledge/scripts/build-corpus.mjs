#!/usr/bin/env node
/**
 * Build-time docs indexer. Globs EVERY `.mdx` under `docs/` (generic — no
 * per-file list, so it scales as the Diátaxis docs grow), splits each page into
 * heading-delimited chunks, strips frontmatter/MDX/JSX down to plain searchable
 * text, and emits `src/generated/corpus.json`. The runtime knowledge layer
 * imports that JSON (bundled into the Lambda asset by esbuild) and indexes it
 * with the SDK operations — so there is no filesystem read at runtime.
 *
 * Pure Node, zero deps. Runs before `tsc` in the package's build/typecheck/test
 * scripts so the JSON always exists.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(scriptsDir, "..");
const repoRoot = join(pkgRoot, "..", "..");
const docsDir = join(repoRoot, "docs");
const outFile = join(pkgRoot, "src", "generated", "corpus.json");

/** Recursively collect every `.mdx` file under a directory (depth-first). */
function collectMdx(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // docs/ absent (e.g. a published install) — emit an empty corpus.
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(collectMdx(full));
    else if (e.isFile() && e.name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

/** Map the first path segment under `docs/` to a knowledge `kind`. */
function kindForPath(relPath) {
  const seg = relPath.split("/")[0];
  if (seg === "guides") return "guide";
  if (seg === "concepts") return "concept";
  if (seg === "reference" || seg === "api-reference") return "reference";
  return "overview"; // top-level pages: introduction, quickstart, self-hosting…
}

/** Pull `title`/`description` out of the leading `--- … ---` frontmatter. */
function parseFrontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { title: "", description: "", body: src };
  const block = m[1];
  const field = (name) => {
    const fm = block.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
    if (!fm) return "";
    return fm[1].trim().replace(/^["']|["']$/g, "");
  };
  return { title: field("title"), description: field("description"), body: src.slice(m[0].length) };
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Strip MDX/JSX noise from one prose line (component tags removed, inner text
 * kept). Only PascalCase component tags (`<Note>`, `</AccordionGroup>`,
 * `<Card … />`) are stripped — NOT lowercase angle-bracket spans like a generic
 * `Record<string, T>` or an inequality `a < b`, which are real prose tokens.
 * Code-fence lines are passed through verbatim by the caller. */
function cleanProse(line) {
  return line
    .replace(/<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*?)?\/?>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** Chunk one page into heading-delimited sections with cleaned text. */
function chunkPage(relPath, title, description, body) {
  const kind = kindForPath(relPath);
  const sections = [];
  let inFence = false;
  let lastH2 = null;
  let current = { heading: title || relPath, anchor: "_intro", path: [title || relPath], lines: [] };

  // Two sections with the same heading text slug to the same anchor; suffix
  // collisions (`-2`, `-3`, …) so every chunk on a page has a unique id —
  // otherwise the later chunk would overwrite the earlier in the runtime byId map.
  const usedAnchors = new Set(["_intro"]);
  const uniqueAnchor = (heading) => {
    const base = slug(heading) || "section";
    let anchor = base;
    for (let n = 2; usedAnchors.has(anchor); n++) anchor = `${base}-${n}`;
    usedAnchors.add(anchor);
    return anchor;
  };

  for (const raw of body.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      current.lines.push(raw);
      continue;
    }
    if (!inFence) {
      const h = raw.match(/^(#{2,3})\s+(.+?)\s*$/);
      if (h) {
        sections.push(current);
        const level = h[1].length;
        const heading = cleanProse(h[2]).trim();
        if (level === 2) lastH2 = heading;
        const path = level === 3 && lastH2 ? [title, lastH2, heading] : [title, heading];
        current = { heading, anchor: uniqueAnchor(heading), path: path.filter(Boolean), lines: [] };
        continue;
      }
      if (/^(import|export)\s/.test(raw)) continue;
      current.lines.push(cleanProse(raw));
      continue;
    }
    current.lines.push(raw);
  }
  sections.push(current);

  return sections
    .map((s) => {
      const text = s.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      return {
        id: `${relPath}#${s.anchor}`,
        kind,
        title: s.heading,
        description,
        path: relPath,
        anchor: s.anchor === "_intro" ? undefined : s.anchor,
        headingPath: s.path,
        text,
      };
    })
    .filter((c) => c.text.length > 0 || c.anchor === undefined);
}

const files = collectMdx(docsDir).sort();
const corpus = [];
for (const file of files) {
  const relPath = relative(docsDir, file).split("\\").join("/");
  const src = readFileSync(file, "utf8");
  const { title, description, body } = parseFrontmatter(src);
  corpus.push(...chunkPage(relPath, title, description, body));
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(corpus, null, 0)}\n`);
console.log(`Built knowledge corpus: ${corpus.length} chunks from ${files.length} docs -> ${relative(repoRoot, outFile)}`);
