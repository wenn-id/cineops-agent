import { access, readFile } from 'node:fs/promises';

const required = ['index.html', 'styles.css', 'app.mjs', 'src/core.mjs', 'src/scenarios.mjs'];
const errors = [];

for (const file of required) {
  try { await access(file); } catch { errors.push(`missing ${file}`); }
}

const html = await readFile('index.html', 'utf8');
const css = await readFile('styles.css', 'utf8');
for (const id of ['pipeline-stages', 'investigation-form', 'agent-result', 'evidence-list']) {
  if (!html.includes(`id="${id}"`)) errors.push(`missing #${id}`);
}
const cssStructural = css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(["'])((?:\\.|(?!\1)[\s\S])*)\1/g, '');
if ((cssStructural.match(/{/g) ?? []).length !== (cssStructural.match(/}/g) ?? []).length) {
  errors.push('unbalanced CSS braces');
}
for (const asset of ['styles.css', 'app.mjs']) {
  if (!html.includes(asset)) errors.push(`unreferenced ${asset}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Validated ${required.length} files, 4 UI anchors, CSS balance, and local assets.`);
