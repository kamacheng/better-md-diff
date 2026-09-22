import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const manifest = await json('manifest.json');
const pkg = await json('package.json');
const lock = await json('package-lock.json');
const versions = await json('versions.json');
const versionPattern = /^\d+\.\d+\.\d+$/;

for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
  assert(typeof manifest[key] === 'string' && manifest[key].trim(), `Missing manifest.${key}`);
}
assert(/^[a-z]+(?:-[a-z]+)*$/.test(manifest.id), 'Use a lowercase, hyphenated plugin ID');
assert(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'), 'Invalid plugin ID');
assert(!/obsidian|plugin/i.test(manifest.name), 'Plugin name must not contain Obsidian or Plugin');
assert(versionPattern.test(manifest.version) && versionPattern.test(manifest.minAppVersion), 'Use x.y.z versions');
assert(manifest.isDesktopOnly === true, 'Local Git requires desktop-only mode');
assert(manifest.description.length <= 250 && manifest.description.endsWith('.'), 'Use a short description ending in a period');
assert.equal(pkg.version, manifest.version, 'Package and manifest versions differ');
assert.equal(lock.version, manifest.version, 'Lockfile version differs');
assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root package version differs');
if (process.env.RELEASE_TAG !== undefined) assert.equal(process.env.RELEASE_TAG, manifest.version, 'Release tag must exactly match manifest.version (no v prefix)');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'Missing compatibility entry');
assert.equal(pkg.license, 'MIT');

for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  const source = await readFile(name);
  const asset = await readFile(`dist/${manifest.id}/${name}`);
  assert(source.length > 0 && source.equals(asset), `Release asset differs: ${name}`);
}
const bundle = await readFile('main.js', 'utf8');
for (const license of ['LICENSE', 'node_modules/diff/LICENSE']) {
  assert(bundle.includes((await readFile(license, 'utf8')).trim()), `Missing bundled license: ${license}`);
}
const readme = await readFile('README.md', 'utf8');
assert(readme.includes('(README.zh-CN.md)'), 'Missing Chinese README link');
assert(readme.includes('## Installation') && readme.includes('## Usage'), 'Keep English quick-start sections discoverable by community scans');
assert((await readFile('README.zh-CN.md', 'utf8')).includes('(README.md)'), 'Missing English README link');
console.log(`Release ${manifest.version} validated. Use tag ${manifest.version} (without a v prefix).`);
