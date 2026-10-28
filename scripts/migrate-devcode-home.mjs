#!/usr/bin/env node
/**
 * Create the DevCode settings home without losing existing credentials,
 * project memory, or historical sessions.
 *
 * When an older settings directory exists, create ~/.devcode as a link to
 * the SAME directory. Nothing is moved, copied, overwritten or deleted.
 * Future installs can migrate contents after user review.
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = homedir();
const current = join(home, '.devcode');
const legacy = join(home, '.qwen');

if (existsSync(current)) {
  console.log('DevCode settings ready: ' + current);
} else if (existsSync(legacy)) {
  const stat = lstatSync(legacy);
  if (!stat.isDirectory() && !stat.isSymbolicLink())
    throw new Error('Older settings location is not a folder: ' + legacy);
  symlinkSync(realpathSync(legacy), current, 'dir');
  console.log('DevCode settings connected to your existing settings and history.');
  console.log('Nothing was deleted. New path: ' + current);
} else {
  mkdirSync(current, { recursive: false, mode: 0o700 });
  console.log('Created a fresh DevCode settings folder: ' + current);
}
console.log('For DevCode sessions use: DEVCODE_HOME=' + current);
