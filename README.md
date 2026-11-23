# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format,
and text-editor tool calls as JSON — and `mend` reads all four to one written contract (`SPEC.md`),
all or nothing.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is a patch file path relative to the working directory; when absent or `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch as `unified`, `search-replace`, `v4a` or `json`; `auto` (the
  default) detects the format.
- `--check` reports what would change and writes nothing.
- `--strict` matches lines exactly (no whitespace-tolerant fallback tiers).

Exit codes: `0` when every change was applied, `1` when at least one edit failed (nothing is
written), `2` on usage, unreadable patch, undetected format or parse errors. Each run prints one
line per changed path (`A` added, `D` deleted, `M` modified, `R old -> new` moved) and
`ok: <n> files` on success, or `error: <code> <path>` lines and `failed: <k> of <n> edits` on
failure.

Matching is three-tier: exact lines, then ignoring trailing whitespace, then ignoring leading and
trailing whitespace — so drifted model output still lands in the right place.

## Files

- `main.ts` — the CLI. Node 22, standard library alone, no dependencies.
- `runner.ts` — the kit's trial runner (kept as handed out).
- `check.ts` — runs the public practice checks against `main.ts`.
- `selftest.mjs` — extra edge-case tests derived sentence by sentence from `SPEC.md`
  (`node selftest.mjs`).
- `SPEC.md` — the whole specification.
- `LICENSE` — MIT.
