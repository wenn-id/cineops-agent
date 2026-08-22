import { access, readFile } from 'node:fs/promises';

const required = [
  'web/index.html', 'web/styles.css', 'web/app.mjs',
  'src/core.mjs', 'src/scenarios.mjs',
  'server/index.mjs', 'server/agent.mjs', 'server/static.mjs',
  'server/gemini.mjs', 'server/gemini-agent.mjs',
  'server/grafana-mcp.mjs', 'server/grafana-live.mjs',
  'simulator/index.mjs', 'simulator/engine.mjs',
];
const errors = [];

for (const file of required) {
  try { await access(file); } catch { errors.push(`missing ${file}`); }
}

const html = await readFile('web/index.html', 'utf8');
const css = await readFile('web/styles.css', 'utf8');
for (const id of ['pipeline-stages', 'investigation-form', 'agent-result', 'evidence-list', 'result-status']) {
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
const appSource = await readFile('web/app.mjs', 'utf8');
for (const module of ['../src/core.mjs', '../src/scenarios.mjs']) {
  if (!appSource.includes(`'${module}'`)) errors.push(`web/app.mjs must import '${module}'`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Validated ${required.length} files, 5 UI anchors, CSS balance, and local assets.`);
