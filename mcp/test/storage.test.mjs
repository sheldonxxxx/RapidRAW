import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyIndependent, requireFreeSpace } from '../dist/storage.js';

test('captured copies remain independent and never overwrite existing paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rapidraw-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    target = join(root, 'target');
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 71));
  await copyIndependent(source, target);
  assert.deepEqual(await readFile(target), await readFile(source));
  assert.notEqual((await stat(source)).ino, (await stat(target)).ino);
  await assert.rejects(copyIndependent(source, target), { code: 'EEXIST' });
  await writeFile(target, 'changed captured copy');
  assert.equal((await readFile(source))[0], 71);
  await writeFile(source, 'changed original');
  assert.equal(await readFile(target, 'utf8'), 'changed captured copy');
  if (process.platform !== 'win32') {
    const link = join(root, 'link');
    await symlink(source, link);
    await assert.rejects(copyIndependent(link, join(root, 'rejected')), /regular source/);
    await assert.rejects(copyIndependent(source, link), { code: 'EEXIST' });
  }
});

test('free-space guard fails before work and validates its configured minimum', async () => {
  await requireFreeSpace(tmpdir(), 0.001);
  await assert.rejects(requireFreeSpace(tmpdir(), 1e9), /STORAGE_LOW/);
  for (const value of [0, -1, NaN, Infinity]) await assert.rejects(requireFreeSpace(tmpdir(), value), /positive/);
});
