// mend, the CLI SPEC.md specifies (MIT). Node 22, standard library alone.
// Started from the kit's starter (sections 1-4, 9, 10) and extended with tiered
// line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7) and V4A patches (section 8).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** A successful move edit: the old path is deleted, the new one holds `text`. */
  move(oldPath: string, newPath: string, text: string): void {
    this.now.set(oldPath, null);
    this.now.set(newPath, text);
    this.moves.push([oldPath, newPath]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- section 5

const tierFn: Array<(l: string) => string> = [
  (l) => l,
  (l) => l.replace(/[ \t]+$/, ''),
  (l) => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];
const leadWs = (l: string): string => /^[ \t]*/.exec(l)![0];

interface Ent {
  t: ' ' | '-' | '+' | '\\';
  text: string;
  ctx: boolean;
  empty: boolean; // came from a truly empty patch line (droppable at body end)
}

/** Occurrences of O in lines at the first tier (0, or up to 2 unless strict) with at least one. */
function findTier(o: string[], lines: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 1 : 3;
  for (let t = 0; t < top; t++) {
    const f = tierFn[t]!;
    const pos: number[] = [];
    outer: for (let i = 0; i + o.length <= lines.length; i++) {
      for (let j = 0; j < o.length; j++) {
        if (f(o[j]!) !== f(lines[i + j]!)) continue outer;
      }
      pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * The lines N written in place of the occurrence at `pos` of O in fileLines.
 * Context lines come from the file; at tier 2 other lines are re-indented.
 * `entries` is the hunk/chunk body in order; a context line sits at file line
 * pos + (the count of context and old lines before it).
 */
function buildN(entries: Ent[], oFirstText: string | null, fileLines: string[], pos: number, tier: number): string[] {
  const reindent = tier === 2 && oFirstText !== null;
  const fLead = reindent ? leadWs(fileLines[pos]!) : '';
  const pLead = reindent ? leadWs(oFirstText) : '';
  const out: string[] = [];
  let oIdx = 0;
  for (const e of entries) {
    if (e.t === ' ') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (e.t === '-') {
      oIdx += 1;
    } else if (e.t === '+') {
      if (reindent && e.text.trim() !== '' && e.text.startsWith(pLead)) out.push(fLead + e.text.slice(pLead.length));
      else out.push(e.text);
    }
  }
  return out;
}

// ------------------------------------------------------- files, lines, paths

interface Split {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitText(text: string): Split {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

// ------------------------------------------------------------- section 6

interface Hunk {
  a: number;
  entries: Ent[];
}

interface USection {
  old: string | null;
  new: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newMode: boolean;
  delMode: boolean;
  sawDashes: boolean;
  diffOld: string | null;
  diffNew: string | null;
  hunks: Hunk[];
}

const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function dashPath(l: string): string {
  const raw = l.slice(4).split('\t')[0] ?? '';
  return stripAB(raw.trim());
}

function freshUSection(diffOld: string | null, diffNew: string | null): USection {
  return { old: null, new: null, renameOld: null, renameNew: null, newMode: false, delMode: false, sawDashes: false, diffOld, diffNew, hunks: [] };
}

function lastPlusMarker(entries: Ent[]): boolean {
  let last = -1;
  for (let k = 0; k < entries.length; k++) if (entries[k]!.t === '+') last = k;
  return last >= 0 && entries[last + 1] !== undefined && entries[last + 1]!.t === '\\';
}

function hunkMarker(h: Hunk): boolean {
  const e = h.entries;
  return e.length >= 2 && e[e.length - 1]!.t === '\\' && (e[e.length - 2]!.t === ' ' || e[e.length - 2]!.t === '+');
}

function applyHunks(linesIn: string[], finalIn: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let lines = linesIn;
  let final = finalIn;
  let d = 0;
  for (const h of hunks) {
    const oE = h.entries.filter((e) => e.t === ' ' || e.t === '-');
    const nE = h.entries.filter((e) => e.t === ' ' || e.t === '+');
    const o = oE.map((e) => e.text);
    const n = nE.map((e) => e.text);
    if (o.length > 0) {
      const f = findTier(o, lines, strict);
      if (f === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = f.pos[0]!;
      for (const p of f.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const mid = buildN(h.entries, o.length > 0 ? o[0]! : null, lines, best, f.tier);
      const toEOF = best + o.length === lines.length;
      lines = lines.slice(0, best).concat(mid, lines.slice(best + o.length));
      if (toEOF) final = !hunkMarker(h);
    } else {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const toEOF = at === lines.length;
      lines = lines.slice(0, at).concat(n, lines.slice(at));
      if (toEOF) final = !hunkMarker(h);
    }
    d += n.length - o.length;
  }
  return { lines, final };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inBody = false;
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const endBody = (): void => {
    const h = cur!.hunks[cur!.hunks.length - 1]!;
    while (h.entries.length > 0 && h.entries[h.entries.length - 1]!.empty) h.entries.pop();
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (inBody) {
      const pair = l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
      if (l.startsWith('diff --git ') || pair) {
        endBody();
        inBody = false;
        i -= 1;
        continue;
      }
      if (l === '') {
        cur!.hunks[cur!.hunks.length - 1]!.entries.push({ t: ' ', text: '', ctx: true, empty: true });
        continue;
      }
      const c = l[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        cur!.hunks[cur!.hunks.length - 1]!.entries.push({ t: c, text: l.slice(1), ctx: c === ' ', empty: false });
        continue;
      }
      endBody();
      inBody = false;
      i -= 1;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S*) b\/(\S*)$/.exec(l);
      if (m === null) err(i + 1);
      cur = freshUSection(stripAB(m![1]!), stripAB(m![2]!));
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = freshUSection(null, null);
        sections.push(cur);
        cur.old = dashPath(l);
        cur.new = dashPath(lines[i + 1]!);
        cur.sawDashes = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) err(i + 1);
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) err(i + 1);
      cur.hunks.push({ a: Number(m![1]!), entries: [] });
      inBody = true;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur.sawDashes) {
          cur = freshUSection(null, null);
          sections.push(cur);
        }
        cur.old = dashPath(l);
        cur.new = dashPath(lines[i + 1]!);
        cur.sawDashes = true;
        i += 1;
        continue;
      }
      err(i + 2);
    }
    if (l.startsWith('rename from ')) {
      if (!cur.sawDashes) cur.renameOld = l.slice(12);
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!cur.sawDashes) cur.renameNew = l.slice(10);
      continue;
    }
    if (l.startsWith('new file mode')) cur.newMode = true;
    else if (l.startsWith('deleted file mode')) cur.delMode = true;
    // any other header line (index, modes, similarity, prose, fences) is ignored
  }
  if (inBody && cur !== null) endBody();
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  const edits: Edit[] = [];
  for (const s of sections) {
    const op = s.old ?? (s.sawDashes ? null : s.renameOld) ?? s.diffOld;
    const np = s.new ?? (s.sawDashes ? null : s.renameNew) ?? s.diffNew;
    const isCreate = op === '/dev/null' || s.newMode;
    const isDelete = np === '/dev/null' || s.delMode;
    if (isCreate) {
      const target = np ?? op ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const flat: Ent[] = [];
        for (const h of s.hunks) flat.push(...h.entries);
        const plus = flat.filter((e) => e.t === '+').map((e) => e.text);
        const marker = lastPlusMarker(flat);
        tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (marker ? '' : '\n'));
      });
    } else if (isDelete) {
      const target = op ?? np ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
    } else if (op !== null && np !== null && op !== np) {
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const sp = splitText(before);
        const r = applyHunks(sp.lines, sp.final, s.hunks, strict, op);
        tree.move(op, np, joinText(r.lines, sp.br, r.final));
      });
    } else {
      const target = op ?? np ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        const before = tree.get(target);
        if (before === null) throw new Fail('missing', target);
        const sp = splitText(before);
        const r = applyHunks(sp.lines, sp.final, s.hunks, strict, target);
        tree.now.set(target, joinText(r.lines, sp.br, r.final));
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ------------------------------------------------------------- section 7

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let lastReplace = -1;
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > lastReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) err(i + 1);
    let sep = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') err(i + 1);
    }
    if (sep < 0) err(i + 1);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) err(i + 1);
    blocks.push({ path: path!, old: lines.slice(i + 1, sep), nw: lines.slice(sep + 1, end) });
    prevPath = path;
    lastReplace = end;
    i = end + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSR(lines);
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    const oldE: Ent[] = b.old.map((t) => ({ t: '-' as const, text: t, ctx: false, empty: false }));
    const newE: Ent[] = b.nw.map((t) => ({ t: '+' as const, text: t, ctx: false, empty: false }));
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const sp = splitText(before);
      const f = findTier(b.old, sp.lines, strict);
      if (f === null) throw new Fail('no-match', b.path);
      if (f.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = f.pos[0]!;
      const mid = buildN(newE, b.old.length > 0 ? b.old[0]! : null, sp.lines, pos, f.tier);
      const out = sp.lines.slice(0, pos).concat(mid, sp.lines.slice(pos + b.old.length));
      tree.now.set(b.path, joinText(out, sp.br, sp.final));
    };
  });
}

// ------------------------------------------------------------- section 8

interface VChunk {
  anchor: string | null;
  entries: Ent[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  hdrLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

// Sections and their bodies are collected in parseV4aFull below.
function parseV4aFull(lines: string[]): VSection[] {
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) err(1);
  if (lines[first]!.trim() !== '*** Begin Patch') err(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') err(lines.length + 1);
  const starts = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  const secs: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const st = starts.find((p) => l.startsWith(p));
    if (st !== undefined) {
      cur = { kind: st === '*** Add File: ' ? 'add' : st === '*** Delete File: ' ? 'delete' : 'update', path: l.slice(st.length).trim(), hdrLine: i + 1, addLines: [], moveTo: null, chunks: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      err(i + 1);
    }
    (cur as unknown as { _body: Array<{ l: string; n: number }> })._body ??= [];
    (cur as unknown as { _body: Array<{ l: string; n: number }> })._body.push({ l, n: i + 1 });
  }
  const out: VSection[] = [];
  for (const sec of secs) {
    const body = ((sec as unknown as { _body?: Array<{ l: string; n: number }> })._body ?? []) as Array<{ l: string; n: number }>;
    while (body.length > 0 && blank(body[body.length - 1]!.l)) body.pop();
    if (sec.kind === 'add') {
      for (const { l, n } of body) {
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (blank(l)) sec.addLines.push('');
        else err(n);
      }
    } else if (sec.kind === 'delete') {
      if (body.length > 0) err(body[0]!.n);
    } else {
      let open = false;
      let pending = 0;
      for (let bi = 0; bi < body.length; bi++) {
        const { l, n } = body[bi]!;
        if (bi === 0 && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice(13).trim();
          continue;
        }
        if (l.startsWith('*** End of File')) {
          pending = 0;
          if (!open) err(n);
          sec.chunks[sec.chunks.length - 1]!.eof = true;
          open = false;
          continue;
        }
        if (l.startsWith('@@')) {
          pending = 0;
          open = false;
          sec.chunks.push({ anchor: l.slice(2).trim(), entries: [], eof: false });
          open = true;
          continue;
        }
        if (blank(l)) {
          if (open) sec.chunks[sec.chunks.length - 1]!.entries.push({ t: ' ', text: '', ctx: true, empty: false });
          else pending += 1;
          continue;
        }
        const c = l[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (!open) {
            if (sec.chunks.length > 0) err(n);
            sec.chunks.push({ anchor: null, entries: [], eof: false });
            open = true;
            for (let k = 0; k < pending; k++) sec.chunks[0]!.entries.push({ t: ' ', text: '', ctx: true, empty: false });
          }
          pending = 0;
          sec.chunks[sec.chunks.length - 1]!.entries.push({ t: c, text: l.slice(1), ctx: c === ' ', empty: false });
          continue;
        }
        err(n);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) err(sec.hdrLine);
    }
    out.push(sec);
  }
  return out;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const secs = parseV4aFull(lines);
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    const path = sec.path;
    const moveTo = sec.moveTo;
    const chunks = sec.chunks;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const sp = splitText(before);
      let buf = sp.lines;
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          let found = -1;
          const top = strict ? 1 : 3;
          for (let t = 0; t < top && found < 0; t++) {
            const f = tierFn[t]!;
            for (let idx = cursor; idx < buf.length; idx++) {
              if (f(chunk.anchor) === f(buf[idx]!)) {
                found = idx;
                break;
              }
            }
          }
          if (found < 0) throw new Fail('no-match', path);
          cursor = found + 1;
        }
        const oE = chunk.entries.filter((e) => e.t === ' ' || e.t === '-');
        const nE = chunk.entries.filter((e) => e.t === ' ' || e.t === '+');
        const o = oE.map((e) => e.text);
        const n = nE.map((e) => e.text);
        if (o.length > 0) {
          const f = findTier(o, buf, strict);
          if (f === null) throw new Fail('no-match', path);
          let pos = -1;
          for (const p of f.pos) {
            if (p >= cursor && (!chunk.eof || p + o.length === buf.length)) {
              pos = p;
              break;
            }
          }
          if (pos < 0) throw new Fail('no-match', path);
          const mid = buildN(chunk.entries, o.length > 0 ? o[0]! : null, buf, pos, f.tier);
          buf = buf.slice(0, pos).concat(mid, buf.slice(pos + o.length));
          cursor = pos + mid.length;
        } else {
          const at = chunk.eof ? buf.length : cursor;
          buf = buf.slice(0, at).concat(n, buf.slice(at));
          cursor = at + n.length;
        }
      }
      const text = joinText(buf, sp.br, sp.final);
      if (moveTo !== null) tree.move(path, moveTo, text);
      else tree.now.set(path, text);
    };
  });
}

// ------------------------------------------------------------- section 9

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    if (v.length === 0) throw new Exit2('error: parse 1');
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------- sections 1, 2, 10

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  type Row = { path: string; text: string };
  const rowsMap = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowsMap.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [o, n] of tree.moves) {
    if (rowsMap.get(o) === `D ${o}` && rowsMap.get(n) === `A ${n}`) {
      rowsMap.delete(o);
      rowsMap.delete(n);
      rowsMap.set(n, `R ${o} -> ${n}`);
    }
  }
  const rows: Row[] = [...rowsMap.entries()].map(([p, text2]) => ({ path: p, text: text2 }));
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const out: string[] = rows.map((r) => r.text);
  if (!check) {
    for (const [p, now] of tree.now) {
      const was = tree.original(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
