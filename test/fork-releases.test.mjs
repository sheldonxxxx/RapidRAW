import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/utils/forkReleases.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { compareVersions, findForkUpdate } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const release = (tag, prerelease = false) => ({ tag_name: tag, draft: false, prerelease });

test('orders beta identifiers numerically and stable versions above their betas', () => {
  assert.equal(compareVersions('0.1.0-beta.2', '0.1.0-beta.10'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.10'), 1);
  assert.equal(compareVersions('0.1.0-beta', '0.1.0-beta.1'), -1);
  assert.equal(compareVersions('0.1.0+abc', '0.1.0+def'), 0);
  assert.equal(compareVersions('0.1.0-01', '0.1.0'), null);
});

test('beta installations see newer fork betas without treating upstream tags as updates', () => {
  const found = findForkUpdate('0.1.0-beta.1', [
    release('v1.6.3'),
    release('mcp-v9.0.0'),
    release('fork-v0.1.0-beta.10', true),
    release('fork-v0.1.0-beta.2', true),
  ]);
  assert.equal(found.version, '0.1.0-beta.10');
  assert.equal(found.url, 'https://github.com/sheldonxxxx/RapidRAW/releases/tag/fork-v0.1.0-beta.10');
});

test('stable installations do not switch to prereleases and beta can upgrade to stable', () => {
  assert.equal(findForkUpdate('0.1.0', [release('fork-v0.2.0-beta.1', true)]), null);
  assert.equal(findForkUpdate('0.1.0-beta.1', [release('fork-v0.1.0')]).version, '0.1.0');
});

test('drafts, malformed responses and older versions cannot trigger update prompts', () => {
  assert.equal(findForkUpdate('0.1.0', { message: 'API rate limit exceeded' }), null);
  assert.equal(
    findForkUpdate('0.1.0', [
      null,
      {},
      { ...release('fork-v2.0.0'), draft: true },
      release('fork-vbad'),
      release('fork-v0.1.0'),
    ]),
    null,
  );
});
