// Self-made edge-case tests for mend, derived from SPEC.md sentences.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const MAIN = '/root/makefun/work/mend/main.ts';
let pass = 0;
const fails = [];

function treeOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

function t(name, files, argv, stdin, expExit, expOut, expChanges) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-self-'));
  try {
    for (const [p, txt] of Object.entries(files)) {
      writeFileSync(join(dir, ...p.split('/')), txt);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin ?? '', encoding: 'utf8' });
    const exit = r.status;
    const gotOut = r.stdout;
    const got = treeOf(dir);
    const want = { ...files };
    for (const [p, v] of Object.entries(expChanges ?? {})) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    const why = [];
    if (exit !== expExit) why.push(`exit ${exit} != ${expExit}`);
    if (gotOut !== expOut) why.push(`stdout ${JSON.stringify(gotOut)} != ${JSON.stringify(expOut)}`);
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) why.push(`${p} should not exist`);
      else if (got[p] === undefined) why.push(`${p} missing`);
      else if (got[p] !== want[p]) why.push(`${p} differs: ${JSON.stringify(want[p])} != ${JSON.stringify(got[p])}`);
    }
    if (why.length === 0) pass += 1;
    else fails.push(`FAIL ${name}\n  ${why.join('\n  ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILE = 'a\nb\nc\nd\ne\n';

// --- unified ---

// \ No newline at end of file when hunk runs to EOF: no final break
t('u-noeol-marker', { f: 'a\nb\nc', p: '--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n\\ No newline at end of file\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc' });
// matched to EOF without marker: result ends with a break (even though file did not)
t('u-eof-added-break', { f: 'a\nb\nc', p: '--- f\n+++ f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc\n' });
// not matched to EOF: final break unchanged
t('u-eof-unchanged', { f: 'a\nb\nc\nd\n', p: '--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc\nd\n' });
// empty-O hunk inserts after A+d lines
t('u-insert-empty-o', { f: FILE, p: '--- f\n+++ f\n@@ -0,0 +1,2 @@\n+x\n+y\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'x\ny\na\nb\nc\nd\ne\n' });
// empty-O with wrong A clamps to file end
t('u-insert-clamp', { f: 'a\n', p: '--- f\n+++ f\n@@ -9,0 +10 @@\n+z\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nz\n' });
// d offset accumulates across hunks
t('u-two-hunks-offset', { f: 'a\nb\nc\nd\n', p: '--- f\n+++ f\n@@ -1,2 +1,3 @@\n a\n+q\n b\n@@ -4 +4,0 @@\n-d\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nq\nb\nc\n' });
// nearest occurrence wins (tie -> earlier)
t('u-nearest-tie', { f: 'x\ny\nx\ny\n', p: '--- f\n+++ f\n@@ -3 +3 @@\n-x\n+Z\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'x\ny\nZ\ny\n' });
// creation via new file mode
t('u-create-newmode', { p: 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n' }, ['p'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'one\ntwo\n' });
// deletion via deleted file mode, hunks not read (garbage hunks ignored)
t('u-delete-mode', { f: 'x\n', p: 'diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' }, ['p'], null, 0, 'D f\nok: 1 file\n', { f: null });
// rename with rename from/to, no dashes
t('u-rename-only', { f: 'a\n', p: 'diff --git a/f b/g\nsimilarity index 100%\nrename from f\nrename to g\n' }, ['p'], null, 0, 'R f -> g\nok: 1 file\n', { f: null, g: 'a\n' });
// malformed diff --git line
t('u-parse-bad-git', { p: 'diff --git foo bar\n' }, ['p'], null, 2, 'error: parse 1\n', {});
// hunk before any section
t('u-parse-hunk-no-section', { p: 'prose\n@@ -1 +1 @@\n a\n' }, ['p', '--format=unified'], null, 2, 'error: parse 2\n', {});
// malformed @@ inside section header
t('u-parse-bad-hunk', { f: 'a\n', p: '--- f\n+++ f\n@@ -x +y @@\n a\n' }, ['p'], null, 2, 'error: parse 3\n', {});
// --- not followed by +++
t('u-parse-dangling-dashes', { p: '--- f\nx\n' }, ['p', '--format=unified'], null, 2, 'error: parse 1\n', {});
// a dangling --- inside an existing section header is a parse error at the line after it
t('u-parse-dangling-in-header', { p: 'diff --git a/f b/f\n--- a/f\nnope\n' }, ['p', '--format=unified'], null, 2, 'error: parse 3\n', {});
// prose-only unified patch: parse 1
t('u-parse-no-edit', { p: 'hello\nworld\n' }, ['p', '--format=unified'], null, 2, 'error: parse 1\n', {});
// path with a/ b/ prefix stripped, tab timestamp
t('u-tab-timestamp', { f: 'a\n', p: '--- a/f\t2026-01-01\n+++ b/f\t2026-01-02\n@@ -1 +1 @@\n-a\n+A\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\n' });
// unsafe path in unified: names path after prefix removal
t('u-unsafe', { p: '--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+A\n' }, ['p'], null, 1, 'error: unsafe ../x\nfailed: 1 of 1 edits\n', {});
// context written from the file, not the patch (tier 1 trailing ws in context)
t('u-ctx-from-file', { f: 'b  \nc\n', p: '--- f\n+++ f\n@@ -1,2 +1,2 @@\n b\n-c\n+C\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'b  \nC\n' });
// tier 2: leading/trailing stripped match; N re-indented (P->F)
t('u-tier2-reindent', { f: '    b\nc\n', p: '--- f\n+++ f\n@@ -1,2 +1,2 @@\n b\n-c\n+  C\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: '    b\n      C\n' });
// strict refuses tier 1 match
t('u-strict-refuses', { f: 'b  \n', p: '--- f\n+++ f\n@@ -1 +1 @@\n b\n-B\n' }, ['p', '--strict'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});
// --check writes nothing
t('u-check-nowrite', { f: 'a\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n' }, ['p', '--check'], null, 0, 'M f\nok: 1 file\n', {});
// fenced prose around sections
t('u-fenced', { f: 'a\n', p: '```diff\n--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n```\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\n' });

// --- search/replace ---

// basic
t('s-basic', { f: FILE, p: 'f\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc\nd\ne\n' });
// path taken from nearest previous non-blank non-fence line
t('s-path-skip-fence', { f: 'a\nb\nc\nd\ne\n', p: '```\nf\n```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\nb\nc\nd\ne\n' });
// no path: previous block's path
t('s-path-inherit', { f: 'a\nb\nc\nd\ne\n', p: 'f\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\nc\n=======\nC\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\nb\nC\nd\ne\n' });
// first block with no path
t('s-parse-no-path', { p: '<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n' }, ['p'], null, 2, 'error: parse 1\n', {});
// SEARCH without ======= then REPLACE
t('s-parse-no-sep', { p: 'f\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n' }, ['p'], null, 2, 'error: parse 2\n', {});
// ambiguous
t('s-ambiguous', { f: 'x\nx\n', p: 'f\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, ['p'], null, 1, 'error: ambiguous f\nfailed: 1 of 1 edits\n', {});
// tier 2 match and re-indent of the whole N
t('s-tier2', { f: '  a\n', p: 'f\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: '  A\n' });
// create when old empty
t('s-create', { p: 'new.txt\n<<<<<<< SEARCH\n=======\nhi\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'hi\n' });
// create when file exists
t('s-create-exists', { f: 'x\n', p: 'f\n<<<<<<< SEARCH\n=======\nhi\n>>>>>>> REPLACE\n' }, ['p'], null, 1, 'error: exists f\nfailed: 1 of 1 edits\n', {});
// CRLF file keeps CRLF
t('s-crlf', { f: 'a\r\nb\r\n', p: 'f\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\r\nB\r\n' });
// delete lines (empty new)
t('s-delete-lines', { f: FILE, p: 'f\n<<<<<<< SEARCH\nb\n=======\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nc\nd\ne\n' });
// marker trailing whitespace tolerated
t('s-marker-ws', { f: 'a\n', p: 'f\n<<<<<<< SEARCH   \na\n=======  \nA\n>>>>>>> REPLACE  \n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\n' });

// --- v4a ---

// update plain, no anchor
t('v-update-plain', { f: FILE, p: '*** Begin Patch\n*** Update File: f\n b\n-c\n+C\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nb\nC\nd\ne\n' });
// anchor moves cursor; second chunk anchored
t('v-anchor-cursor', { f: 'head\nm\nx\nm\ntail\n', p: '*** Begin Patch\n*** Update File: f\n@@ head\n m\n-x\n+X\n-m\n+M\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'head\nm\nX\nM\ntail\n' });
// end-of-file chunk: occurrence must end at last line
t('v-eof', { f: 'a\nb\nc\nc\n', p: '*** Begin Patch\n*** Update File: f\n@@ c\n c\n+b\n*** End of File\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nb\nc\nc\nb\n' });
// empty-O chunk inserts at cursor
t('v-insert', { f: 'a\nb\n', p: '*** Begin Patch\n*** Update File: f\n a\n+q\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nq\nb\n' });
// add file with blank lines
t('v-add-blank', { p: '*** Begin Patch\n*** Add File: n\n+one\n\n+two\n*** End Patch\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: 'one\n\ntwo\n' });
// add file that exists
t('v-add-exists', { f: 'x\n', p: '*** Begin Patch\n*** Add File: f\n+one\n*** End Patch\n' }, ['p'], null, 1, 'error: exists f\nfailed: 1 of 1 edits\n', {});
// delete file
t('v-delete', { f: 'x\n', p: '*** Begin Patch\n*** Delete File: f\n*** End Patch\n' }, ['p'], null, 0, 'D f\nok: 1 file\n', { f: null });
// missing file
t('v-delete-missing', { p: '*** Begin Patch\n*** Delete File: nope\n*** End Patch\n' }, ['p'], null, 1, 'error: missing nope\nfailed: 1 of 1 edits\n', {});
// move to
t('v-move', { f: 'a\nb\n', p: '*** Begin Patch\n*** Update File: f\n*** Move to: g/h\n b\n+B\n*** End Patch\n' }, ['p'], null, 0, 'R f -> g/h\nok: 1 file\n', { f: null, 'g/h': 'a\nb\nB\n' });
// move to existing
t('v-move-exists', { f: 'a\n', g: 'b\n', p: '*** Begin Patch\n*** Update File: f\n*** Move to: g\n*** End Patch\n' }, ['p'], null, 1, 'error: exists g\nfailed: 1 of 1 edits\n', {});
// parse: missing End Patch -> line count + 1
t('v-parse-no-end', { p: '*** Begin Patch\n*** Add File: n\n+x\n' }, ['p'], null, 2, 'error: parse 4\n', {});
// parse: junk line in Add section
t('v-parse-junk', { p: '*** Begin Patch\n*** Add File: n\njunk\n*** End Patch\n' }, ['p'], null, 2, 'error: parse 3\n', {});
// parse: update with no chunk and no move
t('v-parse-empty-update', { p: '*** Begin Patch\n*** Update File: f\n*** End Patch\n' }, ['p'], null, 2, 'error: parse 2\n', {});
// tier-2 reindent in v4a
t('v-tier2', { f: '    a\nb\n', p: '*** Begin Patch\n*** Update File: f\n a\n-b\n+  B\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: '    a\n      B\n' });
// CRLF file update keeps CRLF
t('v-crlf', { f: 'a\r\nb\r\n', p: '*** Begin Patch\n*** Update File: f\n b\n+B\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\r\nb\r\nB\r\n' });
// no-match
t('v-nomatch', { f: FILE, p: '*** Begin Patch\n*** Update File: f\n@@ zz\n-z\n+Z\n*** End Patch\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});

// --- json ---

// jsonl create + str_replace
t('j-jsonl', { p: '{"command":"create","path":"n","file_text":"hi"}\n{"command":"str_replace","path":"n","old_str":"hi","new_str":"yo"}\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: 'yo' });
// create then str_replace in array form
t('j-array', { p: '[{"command":"create","path":"n","file_text":"hi"},{"command":"str_replace","path":"n","old_str":"hi"}]\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: '' });
// array fault
t('j-array-fault', { p: '[{"command":"create"}]\n' }, ['p'], null, 2, 'error: parse 1\n', {});
// jsonl fault on line 2
t('j-jsonl-fault', { p: '{"command":"create","path":"n","file_text":"x"}\nnope\n' }, ['p'], null, 2, 'error: parse 2\n', {});
// insert bounds
t('j-insert-top', { f: FILE, p: '{"command":"insert","path":"f","insert_line":0,"new_str":"top"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'top\na\nb\nc\nd\ne\n' });
// insert past end -> no-match
t('j-insert-oob', { f: 'a\n', p: '{"command":"insert","path":"f","insert_line":5,"new_str":"x"}\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});
// str_replace CRLF
t('j-crlf', { f: 'a\r\nb\r\n', p: '{"command":"str_replace","path":"f","old_str":"a\\nb","new_str":"x\\ny"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'x\r\ny\r\n' });
// str_replace multiset ambiguity with overlap
t('j-ambiguous', { f: 'aaa\n', p: '{"command":"str_replace","path":"f","old_str":"aa"}\n' }, ['p'], null, 1, 'error: ambiguous f\nfailed: 1 of 1 edits\n', {});
// create byte-for-byte (no trailing newline added)
t('j-create-bytes', { p: '{"command":"create","path":"n","file_text":"a\\nb"}\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: 'a\nb' });

// --- cli ---

// empty stdin, auto: format error
t('c-empty-auto', {}, [], '', 2, 'error: format\n', {});
// --format forced on wrong content
t('c-format-forced', { f: 'a\n' }, ['f', '--format=v4a'], null, 2, 'error: parse 1\n', {});
// unknown option
t('c-usage-opt', { f: 'a\n' }, ['f', '--wat'], null, 2, 'error: usage\n', {});
// option twice
t('c-usage-twice', { f: 'a\n' }, ['f', '--check', '--check'], null, 2, 'error: usage\n', {});
// two positionals
t('c-usage-two-pos', {}, ['a', 'b'], null, 2, 'error: usage\n', {});
// after --, dashes are positional
t('c-after-ddash', { f: 'a\n', '--weird': '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n' }, ['--', '--weird'], null, 0, 'M f\nok: 1 file\n', { f: 'A\n' });
// no-patch
t('c-no-patch', {}, ['missing.patch'], null, 2, 'error: no-patch\n', {});
// patch as '-'
t('s-stdin', { f: 'a\n' }, ['-', '--format=search-replace'], 'f\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', 0, 'M f\nok: 1 file\n', { f: 'A\n' });
// unsafe json path
t('c-unsafe-json', { p: '{"command":"create","path":"/abs","file_text":"x"}\n' }, ['p'], null, 1, 'error: unsafe /abs\nfailed: 1 of 1 edits\n', {});
// two edits, second fails: first reported too, nothing written
t('c-partial-fail', { f: 'a\n', p: '{"command":"str_replace","path":"f","old_str":"a","new_str":"A"}\n{"command":"str_replace","path":"zzz","old_str":"q","new_str":"Q"}\n' }, ['p'], null, 1, 'error: missing zzz\nfailed: 1 of 2 edits\n', {});
// all-or-nothing when one of two edits fails
t('c-nothing-written', { f: 'a\n', g: 'b\n', p: '{"command":"str_replace","path":"f","old_str":"a","new_str":"A"}\n{"command":"str_replace","path":"g","old_str":"q","new_str":"Q"}\n' }, ['p'], null, 1, 'error: no-match g\nfailed: 1 of 2 edits\n', { f: 'a\n', g: 'b\n' });
// noop patch: ok 0 files
t('c-noop', { f: 'a\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n a\n' }, ['p'], null, 0, 'ok: 0 files\n', { f: 'a\n' });
// R sorts by new path between other rows
t('c-row-order', { f1: 'a\n', f2: 'b\n', f3: 'a\n', p: '*** Begin Patch\n*** Update File: f1\n*** Move to: zz\n*** Update File: f3\n a\n+A\n*** End Patch\n' }, ['p'], null, 0, 'M f3\nR f1 -> zz\nok: 2 files\n', { f1: null, f2: 'b\n', f3: 'a\nA\n', zz: 'a\n' });

process.stdout.write(`${pass} passed, ${fails.length} failed\n${fails.join('\n')}\n`);

// --- round 2 ---
function t2(name, files, argv, stdin, expExit, expOut, expChanges) { t(name, files, argv, stdin, expExit, expOut, expChanges); }
// empty JSON array: no edits -> parse 1
t2('j-empty-array', { p: '[]\n' }, ['p'], null, 2, 'error: parse 1\n', {});
// two bare ---/+++ sections in one patch
t2('u-two-bare-sections', { f: 'a\nb\nc\n', g: 'x\ny\nz\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n--- g\n+++ g\n@@ -1 +1 @@\n-x\n+X\n' }, ['p'], null, 0, 'M f\nM g\nok: 2 files\n', { f: 'A\nb\nc\n', g: 'X\ny\nz\n' });
// created then deleted: not listed
t2('c-create-delete', { p: '{"command":"create","path":"n","file_text":"x"}\n{"command":"str_replace","path":"n","old_str":"x","new_str":"y"}\n{"command":"str_replace","path":"n","old_str":"y","new_str":"z"}\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: 'z' });
// S/R on file without trailing break
t2('s-no-final-break', { f: 'a\nb', p: 'f\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nB' });
// unified on file without trailing break, not to EOF
t2('u-no-final-break', { f: 'a\nb', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'A\nb' });
// move where hunks leave content unchanged: still R
t2('u-move-unchanged', { f: 'a\n', p: '--- f\n+++ g\n@@ -1 +1 @@\n a\n' }, ['p'], null, 0, 'R f -> g\nok: 1 file\n', { f: null, g: 'a\n' });
// v4a chunk with anchor then EOF chunk
t2('v-anchor-then-eof', { f: 'q\nm\nx\ny\nc\n', p: '*** Begin Patch\n*** Update File: f\n@@ q\n q\n-x\n+X\n@@ y\n y\n+c\n+C\n*** End of File\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'q\nm\nX\ny\nC\n' });
// --format=search-replace forced over unified-looking text
t2('s-forced', { f: 'a\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+A\n' }, ['p', '--format=search-replace'], null, 2, 'error: parse 1\n', {});
// option with equals twice different values -> usage
t2('c-usage-fmt-twice', { f: 'a\n' }, ['f', '--format=json', '--format=unified'], null, 2, 'error: usage\n', {});
// str_replace old_str empty -> parse fault
t2('j-empty-oldstr', { f: 'a\n', p: '{"command":"str_replace","path":"f","old_str":""}\n' }, ['p'], null, 2, 'error: parse 1\n', {});
// insert into CRLF file uses CRLF breaks
t2('j-insert-crlf', { f: 'a\r\nb\r\n', p: '{"command":"insert","path":"f","insert_line":1,"new_str":"m\\nn"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\r\nm\r\nn\r\nb\r\n' });
// unsafe path in v4a move
t2('v-unsafe-move', { f: 'a\n', p: '*** Begin Patch\n*** Update File: f\n*** Move to: ../up\n*** End Patch\n' }, ['p'], null, 1, 'error: unsafe ../up\nfailed: 1 of 1 edits\n', {});
// ambiguous only at tier 1, unique at tier 0 elsewhere -> tier 0 wins
t2('u-tier-order', { f: 'x\nb  \nx\nb\n', p: '--- f\n+++ f\n@@ -2 +2 @@\n-b\n+B\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'x\nB\nx\nb\n' });
process.stdout.write(`\nround2 done\n`);
