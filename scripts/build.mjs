import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.mjs'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist/src', { recursive: true });
for (const file of files) {
  await cp(`web/${file}`, `dist/${file}`);
  console.log(`web/${file} ${Number((await stat(`web/${file}`)).size).toLocaleString()} B`);
}
const srcModules = ['core.mjs', 'scenarios.mjs', 'report.mjs'];
for (const file of srcModules) {
  await cp(`src/${file}`, `dist/src/${file}`);
  console.log(`src/${file} ${Number((await stat(`src/${file}`)).size).toLocaleString()} B`);
}
// dist/ is served flat, so web/app.mjs imports of ../src/ must become ./src/
const appPath = 'dist/app.mjs';
const appSource = await readFile(appPath, 'utf8');
const occurrences = appSource.split("'../src/").length - 1;
if (occurrences !== srcModules.length) {
  throw new Error(`expected ${srcModules.length} '../src/' imports in web/app.mjs, found ${occurrences}`);
}
await writeFile(appPath, appSource.replaceAll("'../src/", "'./src/"));
// Every ./src/ import the browser will resolve must exist in the bundle.
const bundled = new Set(srcModules);
for (const match of appSource.replaceAll("'../src/", "'./src/").matchAll(/'\.\/src\/([a-z-]+\.mjs)'/g)) {
  if (!bundled.has(match[1])) throw new Error(`dist/app.mjs imports ./src/${match[1]} but it was not bundled`);
}
console.log('Built dist/');
