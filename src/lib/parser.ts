import { readdir, readFile } from 'fs/promises';
import { join, basename, dirname, posix } from 'path';
import matter from 'gray-matter';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
} from './wiki-links.js';
import type { ParsedNode, ParsedEdge } from './types.js';

const EXCLUDED_DIRS = new Set(['.obsidian', '_FileOrganizer2000', 'attachments']);

export interface ParseResult {
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  stubIds: Set<string>;
}

export async function parseVault(vaultPath: string): Promise<ParseResult> {
  const mdPaths = await collectMarkdownFiles(vaultPath);
  const stemLookup = buildStemLookup(mdPaths);
  const allPathsSet = new Set(mdPaths);
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const stubIds = new Set<string>();

  for (const relPath of mdPaths) {
    const absPath = join(vaultPath, relPath);
    const raw = await readFile(absPath, 'utf-8');

    let fm: Record<string, unknown>;
    let content: string;
    try {
      const parsed = matter(raw);
      fm = parsed.data;
      content = parsed.content;
    } catch {
      // Malformed YAML frontmatter — treat entire file as content
      console.warn(`Malformed frontmatter in ${relPath}, treating as plain markdown`);
      fm = {};
      content = raw;
    }

    const title = (fm.title as string)
      ?? basename(relPath, '.md');

    const inlineTags = extractInlineTags(content);
    const frontmatter = { ...fm };
    if (inlineTags.length > 0) {
      frontmatter.inline_tags = inlineTags;
    }

    nodes.push({ id: relPath, title, content, frontmatter });

    const links = extractWikiLinks(content);
    const paragraphs = content.split(/\n\n+/);
    const seenEdges = new Set<string>();

    for (const link of links) {
      const targetId = resolveLink(link.raw, stemLookup, allPathsSet);
      const resolvedTarget = targetId ?? `_stub/${link.raw}.md`;

      if (!targetId) {
        stubIds.add(resolvedTarget);
      }

      const context = paragraphs.find(p => p.includes(`[[${link.raw}`))
        ?? paragraphs.find(p => p.includes(link.display ?? link.raw))
        ?? '';

      if (seenEdges.has(resolvedTarget)) continue;
      seenEdges.add(resolvedTarget);
      edges.push({
        sourceId: relPath,
        targetId: resolvedTarget,
        context: context.trim(),
      });
    }

    // r33 declares its curated graph in frontmatter (`related:`, `research:`,
    // `impacts:`, `depends_on:`, `supersedes:`, `requires:`) as relative paths,
    // not `[[wikilinks]]`. Extract those as edges too, else the graph is sparse
    // (the whole point of ADR-053). Unresolvable refs are skipped, not stubbed —
    // frontmatter paths are curated, a miss means the path is stale, not a concept.
    for (const ref of frontmatterRefs(fm)) {
      const targetId = resolveRelated(ref, relPath, allPathsSet);
      if (!targetId || targetId === relPath || seenEdges.has(targetId)) continue;
      seenEdges.add(targetId);
      edges.push({
        sourceId: relPath,
        targetId,
        context: `frontmatter relation: ${ref}`,
      });
    }
  }

  return { nodes, edges, stubIds };
}

// Frontmatter keys whose values are path references to other vault files.
// Matches r33's declared relation vocabulary (ADR-019 M2 / frontmatter-relations).
const RELATION_KEYS = [
  'related',
  'research',
  'impacts',
  'depends_on',
  'supersedes',
  'requires',
];

/** Collect all string path-refs from a node's relation frontmatter keys. */
function frontmatterRefs(fm: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const key of RELATION_KEYS) {
    const val = fm[key];
    if (val == null) continue;
    const arr = Array.isArray(val) ? val : [val];
    for (const v of arr) {
      if (typeof v === 'string' && v.trim()) refs.push(v.trim());
    }
  }
  return refs;
}

/**
 * Resolve a frontmatter relation ref (a relative path from the source file's
 * directory, e.g. `../research/foo.md` or `004-bar.md`) to a vault-relative id.
 * Returns null if it doesn't resolve to a real file (stale/curated miss).
 */
function resolveRelated(
  ref: string,
  sourceRelPath: string,
  allPathsSet: Set<string>,
): string | null {
  // Strip wikilink brackets and any #anchor.
  const raw = ref.replace(/^\[\[/, '').replace(/\]\]$/, '').split('#')[0].trim();
  if (!raw) return null;
  const withMd = raw.endsWith('.md') ? raw : `${raw}.md`;

  // Resolve relative to the source file's directory (posix — ids use `/`).
  const srcDir = dirname(sourceRelPath);
  const joined = posix.normalize(srcDir === '.' ? withMd : `${srcDir}/${withMd}`);
  if (allPathsSet.has(joined)) return joined;

  // Fallbacks: already vault-relative, or a leading `./`/`../` stripped form.
  if (allPathsSet.has(withMd)) return withMd;
  const bare = posix.normalize(withMd.replace(/^(\.\.\/)+/, ''));
  if (allPathsSet.has(bare)) return bare;
  return null;
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const pattern = /(?<!\w)#([a-zA-Z][\w-\/]*)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}

async function collectMarkdownFiles(
  vaultPath: string,
  subdir = '',
): Promise<string[]> {
  const results: string[] = [];
  const dirPath = join(vaultPath, subdir);
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;

    const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectMarkdownFiles(vaultPath, relPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(relPath);
    }
  }

  return results;
}
