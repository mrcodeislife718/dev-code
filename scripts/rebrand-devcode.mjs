#!/usr/bin/env node
/**
 * DevCode name migration.
 *
 * Changes PRODUCT BRANDING in tracked text, not internal library IDs,
 * provider/model names, license notices, or historical compatibility paths.
 *
 * PREVIEW (no edits): node scripts/rebrand-devcode.mjs
 * APPLY:             node scripts/rebrand-devcode.mjs --apply
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { extname, resolve, join } from 'node:path';

const apply = process.argv.includes('--apply');
const root = resolve(process.env.DEVCODE_REPO_DIR || process.cwd());
const allowed = new Set([
  '.md', '.mdx', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yml', '.yaml', '.html', '.css', '.scss',
  '.sh', '.xml', '.toml', '.properties', '.vue', '.svelte', '.py',
]);
const skip = /^(?:docs\/archive\/|packages\/cli\/src\/i18n\/locales\/|node_modules\/|vendor\/|dist\/|build\/|coverage\/|\.git\/)/;
const skipFile = /(?:^|\/)(?:LICENSE|NOTICE|COPYING|pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i;

function cmd(args) {
  const r = spawnSync('git', args, { cwd: root, maxBuffer: 25 * 1024 * 1024 });
  if (r.error || r.status !== 0)
    throw Error(r.error?.message || r.stderr?.toString('utf8') || 'Git command failed');
  return r.stdout;
}
function transform(text) {
  // Brand phrases only. Never rewrite Qwen3 model IDs, @qwen-code package
  // imports, author credits, or old setting paths: they are real identifiers.
  return text
    .replace(/Qwen Code/g, 'DevCode')
    .replace(/QWEN CODE/g, 'DEVCODE')
    .replace(/Qwen CLI/g, 'DevCode CLI')
    .replace(/Qwen-code CLI/g, 'DevCode CLI');
}
function run() {
  const files = cmd(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  const dirty = new Set(cmd(['diff', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean));
  const staged = new Set(cmd(['diff', '--cached', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean));
  let changed = 0, skipped = 0, instances = 0;
  const modified = [];
  for (const relative of files) {
    if (skip.test(relative) || skipFile.test(relative)) continue;
    if (!allowed.has(extname(relative).toLowerCase())) continue;
    const path = join(root, relative);
    let info;
    try { info = lstatSync(path); } catch { continue; }
    if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
    const oldBuffer = readFileSync(path);
    if (oldBuffer.includes(0)) continue;
    const old = oldBuffer.toString('utf8');
    if (Buffer.from(old, 'utf8').compare(oldBuffer) !== 0) continue;
    const next = transform(old);
    if (next === old) continue;
    // Never rewrite copyright/license attribution or original authorship.
    if (/Copyright (?:20\\d\\d )?(?:Qwen|Alibaba)/i.test(old) &&
        !/Qwen Code/.test(old.replace(/Copyright[^\\n]*/g, ''))) continue;
    const count = (old.match(/Qwen Code|QWEN CODE|Qwen CLI|Qwen-code CLI/g) || []).length;
    instances += count;
    if (dirty.has(relative) || staged.has(relative)) {
      skipped++;
      console.log('SKIPPED (has your edits): ' + relative);
      continue;
    }
    modified.push(relative);
    if (apply) {
      // Atomic replacement, retain existing permissions. A previous Git
      // commit can restore the old text; do not touch unrelated files.
      const temp = path + '.devcode-brand-' + process.pid;
      try {
        writeFileSync(temp, next, { mode: info.mode });
        renameSync(temp, path);
      } finally {
        try { unlinkSync(temp); } catch { /* already moved */ }
      }
    }
    changed++;
  }
  console.log('DevCode brand ' + (apply ? 'applied' : 'preview') + ': ' + changed +
    ' files, ' + instances + ' matching names, ' + skipped + ' edited files left untouched.');
  for (const path of modified.slice(0, 70)) console.log('  ' + path);
  if (modified.length > 70) console.log('  ... and ' + (modified.length - 70) + ' more');
  console.log(apply
    ? 'Review with: git diff --stat && git diff --check'
    : 'No files changed. To rename these visible names: node scripts/rebrand-devcode.mjs --apply');
}
run();
