import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

const files = ['index.html', 'styles.css', 'app.mjs'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist/src', { recursive: true });
for (const file of files) {
  await cp(`web/${file}`, `dist/${file}`);
  console.log(`web/${file} ${Number((await stat(`web/${file}`)).size).toLocaleString()} B`);
}
for (const file of ['core.mjs', 'scenarios.mjs']) {
  await cp(`src/${file}`, `dist/src/${file}`);
  console.log(`src/${file} ${Number((await stat(`src/${file}`)).size).toLocaleString()} B`);
}
// dist/ is served flat, so web/app.mjs imports of ../src/ must become ./src/
const appPath = 'dist/app.mjs';
const appSource = await readFile(appPath, 'utf8');
const occurrences = appSource.split("'../src/").length - 1;
if (occurrences !== 2) {
  throw new Error(`expected 2 '../src/' imports in web/app.mjs, found ${occurrences}`);
}
await writeFile(appPath, appSource.replaceAll("'../src/", "'./src/"));
console.log('Built dist/');
