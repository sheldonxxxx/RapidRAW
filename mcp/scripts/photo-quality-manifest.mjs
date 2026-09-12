/** Validate photographic fixture provenance before claiming merge/AI quality evidence. */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { hashFile } from './coverage-evidence.mjs';
export async function validatePhotoManifest(manifest) {
  assert.equal(manifest.version, 1); assert.ok(Array.isArray(manifest.groups) && manifest.groups.length);
  const ids = new Set(), capturePartitions = new Map(), sourcePartitions = new Map();
  for (const group of manifest.groups) {
    assert.ok(typeof group.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(group.id) && !ids.has(group.id), 'Fixture IDs must be unique safe directory names'); ids.add(group.id);
    assert.ok(['hdr', 'focus', 'panorama', 'ai-mask', 'denoise', 'negative'].includes(group.kind));
    assert.ok(['regression', 'fresh-holdout'].includes(group.partition));
    assert.ok(group.capture_group && group.provenance && group.provenance !== 'unknown', 'Capture group and acquisition provenance are required');
    assert.ok(!capturePartitions.has(group.capture_group) || capturePartitions.get(group.capture_group) === group.partition, 'Capture groups cannot leak between regression and fresh holdout partitions'); capturePartitions.set(group.capture_group, group.partition);
    assert.equal(group.derived_from_same_image, false, 'Repeated-source/derived fixtures cannot establish photographic merge quality');
    assert.ok(Array.isArray(group.sources) && group.sources.length >= (['hdr', 'focus', 'panorama'].includes(group.kind) ? 2 : 1));
    const hashes = new Set();
    for (const source of group.sources) {
      assert.ok(isAbsolute(source.path)); assert.match(source.sha256, /^[a-f0-9]{64}$/); assert.equal(await hashFile(source.path), source.sha256); assert.ok(!hashes.has(source.sha256), 'Repeated image hashes cannot establish photographic quality'); hashes.add(source.sha256);
      assert.ok(!sourcePartitions.has(source.sha256) || sourcePartitions.get(source.sha256) === group.partition, 'Source images cannot leak between regression and fresh holdout partitions'); sourcePartitions.set(source.sha256, group.partition);
    }
    if (group.kind === 'hdr') assert.ok(new Set(group.sources.map((source) => source.exposure_ev)).size > 1 && group.sources.every((s) => Number.isFinite(s.exposure_ev)), 'HDR quality requires genuine exposure brackets with distinct EV');
    if (group.kind === 'focus') assert.ok(group.sources.every((s) => s.focus_plane) && new Set(group.sources.map((s) => s.focus_plane)).size > 1, 'Focus quality requires distinct recorded focus planes');
    if (group.kind === 'panorama') assert.ok(group.overlap_description && group.sources.every((s) => s.frame_position), 'Panorama quality requires overlap and frame positions');
    assert.ok(Array.isArray(group.review_criteria) && group.review_criteria.length, 'Explicit photographic acceptance criteria are required');
    if (group.review_region) {
      const { x, y, width, height } = group.review_region;
      assert.ok([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0, 'review_region must be an integer rendered-pixel rectangle');
    }
    if (group.minimum_width_expansion !== undefined) assert.ok(group.kind === 'panorama' && Number.isFinite(group.minimum_width_expansion) && group.minimum_width_expansion > 1, 'Expansion gate requires a panorama and a factor greater than one');
    if (group.background !== undefined) assert.equal(typeof group.background, 'boolean');
  }
  return manifest;
}
