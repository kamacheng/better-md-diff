// Reproducible local probe; all content is generated, never read from a vault.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve('.test-vault/large-documents');
await mkdir(directory, { recursive: true });
const bundle = resolve(directory, 'diff.mjs');
await build({ entryPoints: ['src/diff.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
const { computeDiff } = await import(pathToFileURL(bundle).href);
const results = [];
for (const count of [50_000, 100_000, 200_000]) {
  const before = Array.from({ length: count - 1 }, (_, i) => `${String(i).padStart(6, '0')} ${'x'.repeat(96)}\n`).join('');
  const after = before.replace('000100 ', 'changed ');
  const started = performance.now();
  try {
    const diff = computeDiff(before, after, 3, { maxFileMiB: 20, maxLines: 200_000 });
    if (diff.added !== 1 || diff.deleted !== 1) throw new Error('Lost changes');
    results.push({ lines: count, bytes: Buffer.byteLength(before), status: 'passed', elapsedMs: Math.round(performance.now() - started), renderedRows: diff.hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0), heapMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) });
  } catch (error) {
    results.push({ lines: count, bytes: Buffer.byteLength(before), status: 'rejected', elapsedMs: Math.round(performance.now() - started), error: error.message });
  }
}
// Disjoint documents must return a result or an explicit timeout, never a partial diff.
const started = performance.now();
try {
  const diff = computeDiff('old\n'.repeat(30_000), 'new\n'.repeat(30_000), 0, { maxFileMiB: 20, maxLines: 200_000 });
  results.push({ scenario: 'disjoint', status: diff.added === 30_000 && diff.deleted === 30_000 ? 'complete' : 'incorrect', elapsedMs: Math.round(performance.now() - started) });
} catch (error) {
  results.push({ scenario: 'disjoint', status: error.message.includes('超时') ? 'timeout-protected' : 'unexpected-error', elapsedMs: Math.round(performance.now() - started), error: error.message });
}
const report = { node: process.version, platform: process.platform, note: 'Node core probe, not a UI latency guarantee. The diff timeout does not bound tokenization, parsing or DOM work.', results };
await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.some((row) => ['rejected', 'incorrect', 'unexpected-error'].includes(row.status))) process.exitCode = 1;
