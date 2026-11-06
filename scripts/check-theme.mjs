// Fails if a colour is written outside src/styles/theme.css, so every screen
// (including new ones) uses the theme tokens. Runs as part of `npm run lint`.
// A line may opt out with a `theme-ok` comment saying why (e.g. model input).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = join('src', 'styles', 'theme.css');
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/i;

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(css|tsx?)$/.test(e.name)) yield p;
  }
}

const problems = [];
for (const file of files(join(root, 'src'))) {
  const rel = relative(root, file);
  if (rel === THEME) continue;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (COLOUR.test(line) && !line.includes('theme-ok')) problems.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
}

if (problems.length) {
  console.error(`Colours must come from ${THEME} (use a var(--…) token, or token() in canvas code):\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('Theme check: no stray colours');
