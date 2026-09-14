/** Photographic point refinement: preserve first attempts and measure annotated native regions. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { validatePhotoManifest } from './photo-quality-manifest.mjs';
import { decodePng, mean } from './png-fixtures.mjs';
import { nativeReviewTiles, recoverCompletedResponse } from './photo-review-policy.mjs';

assert.ok(
  process.env.RAPIDRAW_PHOTO_MANIFEST,
  'Set RAPIDRAW_PHOTO_MANIFEST to a private photographic refinement manifest',
);
const manifest = await validatePhotoManifest(
  JSON.parse(await readFile(resolve(process.env.RAPIDRAW_PHOTO_MANIFEST), 'utf8')),
);
for (const group of manifest.groups) {
  assert.equal(group.kind, 'ai-mask');
  assert.equal(group.sources.length, 1);
  assert.ok(
    group.region && group.refinement,
    'Each case needs an unchanged region baseline and explicit refinement prompts',
  );
  assert.ok(group.refinement.include_points?.length || group.refinement.exclude_points?.length);
  assert.ok(
    group.probes?.length,
    'Annotate native image regions before inference; nonempty mask coverage is not a quality assertion',
  );
  for (const probe of group.probes) {
    assert.match(probe.id, /^[A-Za-z0-9_-]+$/);
    assert.ok(['include', 'exclude', 'preserve'].includes(probe.intent));
    assert.ok(['minimum_after', 'maximum_after', 'minimum_change'].some((key) => Number.isFinite(probe[key])));
    assert.ok(Object.values(probe.region).every(Number.isInteger));
    assert.ok(
      probe.region.x >= 0 &&
        probe.region.y >= 0 &&
        probe.region.width > 0 &&
        probe.region.height > 0 &&
        probe.region.width <= 512 &&
        probe.region.height <= 512,
    );
  }
}
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/refinement-quality-${Date.now()}`);
const h = await createNativeHarness({ suite: 'photographic-mask-refinement', workspace, timeout: 1800000 });
const failures = [];
async function mutate(method, args, required = ['session_id', 'mask_id']) {
  const response = await h.call(method, args, { allowError: /RESPONSE_TOO_LARGE/ });
  if (response.data?.error?.code === 'RESPONSE_TOO_LARGE')
    response.data = recoverCompletedResponse(response.data, required);
  return response;
}
try {
  for (const group of manifest.groups) {
    const directory = join(workspace, 'first-attempts', group.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'fixture-manifest.json'), JSON.stringify(group, null, 2), { flag: 'wx' });
    await h.fixture(group.sources[0].path, group.id, {
      partition: group.partition,
      provenance: group.provenance,
      capture_group: group.capture_group,
    });
    try {
      const opened = (await h.call('open_photo', { path: group.sources[0].path, inherit_sidecar: false })).data;
      const session_id = opened.session_id;
      for (const probe of group.probes)
        assert.ok(
          probe.region.x + probe.region.width <= opened.dimensions.width &&
            probe.region.y + probe.region.height <= opened.dimensions.height,
        );
      const baseline = await mutate('mask_generate', {
        session_id,
        kind: 'subject',
        region: group.region,
        ...(group.parameters ? { parameters: group.parameters } : {}),
      });
      const mask_id = baseline.data.mask_id;
      const artifacts = [];
      async function snapshot(stage) {
        const values = {};
        async function render(label, geometry) {
          const response = await h.call('render', {
            session_id,
            mask_id,
            mask_mode: 'overlay',
            format: 'png',
            ...geometry,
          });
          assert.equal(response.images.length, 3);
          for (const [i, block] of response.images.entries()) {
            const path = join(directory, `${stage}-${label}-${['overlay', 'photo', 'mask'][i]}.png`);
            await writeFile(path, Buffer.from(block.data, 'base64'), { flag: 'wx' });
            const decoded = decodePng(Buffer.from(block.data, 'base64'));
            if (geometry.region)
              assert.deepEqual([decoded.width, decoded.height], [geometry.region.width, geometry.region.height]);
            artifacts.push({
              path,
              sha256: await hashFile(path),
              stage,
              role: ['overlay', 'photo', 'mask'][i],
              ...geometry,
            });
            if (i === 2) values[label] = mean(decoded);
          }
        }
        await render('overview', { long_edge: 1024 });
        for (const [i, region] of nativeReviewTiles(group.review_region ?? group.region).entries())
          await render(`detail-${i + 1}`, { region });
        for (const probe of group.probes) await render(`probe-${probe.id}`, { region: probe.region });
        return values;
      }
      const before = await snapshot('baseline');
      const state = (await h.call('get_session', { session_id })).data;
      const refined = await mutate('mask_generate', {
        session_id,
        kind: 'subject',
        expected_revision: state.revision,
        refine: { mask_id },
        ...group.refinement,
      });
      assert.equal(refined.data.mask_id, mask_id);
      const after = await snapshot('refined');
      const metrics = group.probes.map((probe) => ({
        ...probe,
        before: before[`probe-${probe.id}`],
        after: after[`probe-${probe.id}`],
        change: after[`probe-${probe.id}`] - before[`probe-${probe.id}`],
      }));
      await writeFile(
        join(directory, 'review-required.json'),
        JSON.stringify(
          {
            status: 'not_reviewed',
            first_attempt: true,
            criteria: group.review_criteria,
            baseline: baseline.data,
            refined: refined.data,
            metrics,
            artifacts,
            note: 'Selected probe assertions do not establish complete subject boundaries, fine hair, or feather quality. Review context and native detail separately.',
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
      await mutate('save_session', { session_id }, ['session_id']);
      // Save all outputs before asserting quality so failures remain reviewable.
      await h.check(
        `annotated_refinement_${group.id}`,
        [
          'tool:mask_generate',
          'parameter:mask_generate.refine',
          ...(group.refinement.include_points?.length ? ['parameter:mask_generate.include_points'] : []),
          ...(group.refinement.exclude_points?.length ? ['parameter:mask_generate.exclude_points'] : []),
        ],
        async () => {
          for (const metric of metrics) {
            if (Number.isFinite(metric.minimum_after))
              assert.ok(
                metric.after >= metric.minimum_after,
                `${metric.id}: ${metric.after} below ${metric.minimum_after}`,
              );
            if (Number.isFinite(metric.maximum_after))
              assert.ok(
                metric.after <= metric.maximum_after,
                `${metric.id}: ${metric.after} above ${metric.maximum_after}`,
              );
            if (Number.isFinite(metric.minimum_change))
              assert.ok(
                (metric.intent === 'exclude' ? -metric.change : metric.change) >= metric.minimum_change,
                `${metric.id}: insufficient ${metric.intent} improvement (${metric.change})`,
              );
          }
          return { metrics, artifacts, photographic_quality: 'requires_separate_visual_review' };
        },
        'pixel_assertion',
      );
    } catch (error) {
      failures.push({ fixture: group.id, error: String(error) });
      await writeFile(join(directory, 'failure.json'), JSON.stringify(failures.at(-1), null, 2), { flag: 'wx' });
    }
  }
} finally {
  await h.close(failures.length ? JSON.stringify(failures) : undefined);
}
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
