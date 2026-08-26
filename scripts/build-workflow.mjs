#!/usr/bin/env node
// Inlines src/encore.js into the reusable workflow.
//   node scripts/build-workflow.mjs          write the file
//   node scripts/build-workflow.mjs --check  fail if it is stale
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(root, 'src', 'encore.js');
const TEMPLATE = join(root, 'templates', 'retry.yml.tmpl');
const OUTPUT = join(root, '.github', 'workflows', 'retry.yml');
const PLACEHOLDER = '{{ENCORE_SCRIPT}}';

const [source, template] = await Promise.all([
  readFile(SOURCE, 'utf8'),
  readFile(TEMPLATE, 'utf8'),
]);

const anchor = template.split('\n').find((line) => line.includes(PLACEHOLDER));
if (!anchor) throw new Error(`${PLACEHOLDER} not found in ${relative(root, TEMPLATE)}`);
const indent = anchor.slice(0, anchor.indexOf(PLACEHOLDER));
if (indent.trim() !== '') throw new Error(`${PLACEHOLDER} must be alone on its line`);

const inlined = source
  .trimEnd()
  .split('\n')
  .map((line) => (line === '' ? '' : indent + line))
  .join('\n')
  .slice(indent.length); // the anchor line already carries the first indent

const rendered = template.replace(anchor, anchor.replace(PLACEHOLDER, inlined));

if (process.argv.includes('--check')) {
  const current = await readFile(OUTPUT, 'utf8').catch(() => null);
  if (current !== rendered) {
    console.error(
      `${relative(root, OUTPUT)} is out of date with ${relative(root, SOURCE)}. ` +
        'Run `npm run build` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`${relative(root, OUTPUT)} is up to date`);
} else {
  await writeFile(OUTPUT, rendered);
  console.log(`wrote ${relative(root, OUTPUT)}`);
}
