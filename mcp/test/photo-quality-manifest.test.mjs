import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../scripts/coverage-evidence.mjs';
import { validatePhotoManifest } from '../scripts/photo-quality-manifest.mjs';
test('quality manifest rejects repeated-source fixtures and missing capture conditions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapidraw-quality-'));
  const sources = []; for (const [i, name] of ['one', 'two'].entries()) { const path = join(directory, name); await writeFile(path, name); sources.push({ path, sha256: await hashFile(path), exposure_ev: i }); }
  const group = { id: 'bracket', kind: 'hdr', partition: 'fresh-holdout', capture_group: 'new-capture', provenance: 'local user original', derived_from_same_image: false, sources, review_criteria: ['No deghosting artifact'] };
  assert.equal((await validatePhotoManifest({ version: 1, groups: [group] })).groups.length, 1);
  await assert.rejects(validatePhotoManifest({ version: 1, groups: [{ ...group, derived_from_same_image: true }] }), /Repeated-source/);
  await assert.rejects(validatePhotoManifest({ version: 1, groups: [{ ...group, sources: [sources[0], sources[0]] }] }), /Repeated image hashes/);
  await assert.rejects(validatePhotoManifest({ version: 1, groups: [{ ...group, sources: sources.map((source) => ({ ...source, exposure_ev: 0 })) }] }), /distinct EV/);
  await assert.rejects(validatePhotoManifest({ version: 1, groups: [{ ...group, id: '../escape' }] }), /safe directory/);
  await assert.rejects(validatePhotoManifest({ version: 1, groups: [group, { ...group, id: 'regression', partition: 'regression' }] }), /cannot leak/);
});
