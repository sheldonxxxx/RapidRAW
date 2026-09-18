/** Real photographic runs preserve first attempts; visual quality requires a separate review record. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createNativeHarness, hashFile } from './coverage-evidence.mjs';
import { decodePng } from './png-fixtures.mjs';
import { validatePhotoManifest } from './photo-quality-manifest.mjs';
import { nativeReviewTiles, isDisconnected, recoverCompletedResponse } from './photo-review-policy.mjs';
const manifestPath = process.env.RAPIDRAW_PHOTO_MANIFEST;
assert.ok(manifestPath, 'Set RAPIDRAW_PHOTO_MANIFEST to a local fixture manifest; see docs/mcp/testing.md');
const manifest = await validatePhotoManifest(JSON.parse(await readFile(resolve(manifestPath), 'utf8')));
const workspace = resolve(process.env.RAPIDRAW_WORKSPACE ?? `test-output/photo-quality-${Date.now()}`);
const h = await createNativeHarness({ suite: 'photographic-fixtures', workspace, timeout: 1800000 });
const failures = [],
  skippedFixtures = [];
let unavailable;
async function mutation(method, args, requiredFields = ['session_id']) {
  const result = await h.call(method, args, { allowError: /RESPONSE_TOO_LARGE/ });
  if (result.data?.error?.code !== 'RESPONSE_TOO_LARGE') return result;
  const recovered = recoverCompletedResponse(result.data, requiredFields);
  await h.check(`completed_${method}_response_recovery`, [`tool:${method}`], async () => ({
    method,
    recovery: result.data.recovery,
    mutation_replayed: false,
  }));
  return { ...result, data: recovered };
}
async function waitDenoise(jobId) {
  const deadline = Date.now() + 1800000;
  let previous = -1;
  while (Date.now() < deadline) {
    const job = (await h.call('get_job', { job_id: jobId })).data;
    assert.ok(job.progress_percent >= previous, 'Denoise progress must not move backwards within an attempt');
    previous = job.progress_percent;
    if (!['running', 'cancelling'].includes(job.status)) {
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      assert.ok(job.result_session_id);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`Background denoise ${jobId} exceeded 30 minutes`);
}
function detailRegion(group, dimensions) {
  if (group.review_region) return group.review_region;
  const width = Math.min(dimensions.width, 512),
    height = Math.min(dimensions.height, 512);
  return {
    x: Math.floor((dimensions.width - width) / 2),
    y: Math.floor((dimensions.height - height) / 2),
    width,
    height,
  };
}
try {
  for (const group of manifest.groups) {
    const operation = ['hdr', 'focus', 'panorama'].includes(group.kind)
      ? 'merge'
      : group.kind === 'ai-mask'
        ? 'mask_generate'
        : group.kind === 'negative'
          ? 'negative_convert'
          : group.background
            ? 'start_denoise'
            : 'denoise';
    if (unavailable) {
      const skipped = {
        fixture: group.id,
        status: 'not_attempted',
        reason: `Transport/engine is unavailable after an earlier fixture: ${unavailable}`,
      };
      skippedFixtures.push(skipped);
      await h.skip(`photographic_operation_${group.id}`, [`tool:${operation}`], skipped.reason);
      continue;
    }
    for (const source of group.sources)
      await h.fixture(source.path, `${group.kind}:${group.id}`, {
        capture_group: group.capture_group,
        partition: group.partition,
        provenance: group.provenance,
      });
    const directory = join(workspace, 'first-attempts', group.id);
    await mkdir(directory, { recursive: true });
    // Exclusive creation prevents a repaired run from silently replacing first-attempt evidence.
    await writeFile(join(directory, 'fixture-manifest.json'), JSON.stringify(group, null, 2), { flag: 'wx' });
    try {
      await h.check(`photographic_operation_${group.id}`, [`tool:${operation}`], async () => {
        let result;
        const artifacts = [],
          originals = [];
        async function saveImages(response, role, geometry = {}) {
          assert.ok(response.images.length, `${role} needs actual native image blocks`);
          for (const [index, block] of response.images.entries()) {
            const path = join(directory, `${role}-${index + 1}.png`);
            const bytes = Buffer.from(block.data, 'base64');
            const decoded = decodePng(bytes);
            await writeFile(path, bytes, { flag: 'wx' });
            artifacts.push({
              role,
              block_index: index,
              path,
              sha256: await hashFile(path),
              width: decoded.width,
              height: decoded.height,
              ...geometry,
            });
          }
          await writeFile(join(directory, `${role}-metadata.json`), JSON.stringify(response.data, null, 2), {
            flag: 'wx',
          });
        }
        async function overview(args, role) {
          for (const edge of [1024, 768, 512, 256]) {
            const response = await h.call(
              'render',
              { ...args, format: 'png', long_edge: edge },
              { allowError: /RESPONSE_TOO_LARGE/ },
            );
            if (response.data?.error?.code === 'RESPONSE_TOO_LARGE') continue;
            if (args.mask_mode === 'overlay')
              assert.equal(
                response.images.length,
                3,
                'Mask review needs overlay, photograph and selection with matched geometry',
              );
            await saveImages(response, role, { requested_long_edge: edge, review_scale: 'bounded overview' });
            return;
          }
          assert.fail(`${role}: even the explicitly bounded overview exceeds the transport budget`);
        }
        async function nativeDetail(args, requested, role) {
          const initial = nativeReviewTiles(requested);
          async function tile(region, label) {
            const response = await h.call(
              'render',
              { ...args, format: 'png', region },
              { allowError: /RESPONSE_TOO_LARGE/ },
            );
            if (response.data?.error?.code === 'RESPONSE_TOO_LARGE') {
              const edge = Math.floor(Math.max(region.width, region.height) / 2);
              assert.ok(edge >= 64, `${label}: native detail exceeds budget at the minimum review tile size`);
              for (const [index, piece] of nativeReviewTiles(region, edge).entries())
                await tile(piece, `${label}-split-${index + 1}`);
              return;
            }
            if (args.mask_mode === 'overlay') assert.equal(response.images.length, 3);
            for (const image of response.images) {
              const decoded = decodePng(Buffer.from(image.data, 'base64'));
              assert.deepEqual(
                [decoded.width, decoded.height],
                [region.width, region.height],
                'Native detail must not be resized to fit transport',
              );
            }
            await saveImages(response, label, {
              native_region: region,
              review_scale: 'one image pixel per native source/output pixel',
            });
          }
          for (const [index, region] of initial.entries())
            await tile(region, initial.length === 1 ? role : `${role}-tile-${index + 1}`);
        }
        // Open every actual source and save both context and 1:1 detail before any operation.
        for (const [index, source] of group.sources.entries()) {
          const opened = (await h.call('open_photo', { path: source.path, inherit_sidecar: false })).data;
          originals.push(opened);
          await overview({ session_id: opened.session_id, original: true }, `original-${index + 1}-overview`);
          await nativeDetail(
            { session_id: opened.session_id, original: true },
            detailRegion(group, opened.dimensions),
            `original-${index + 1}-native-detail`,
          );
        }
        if (['hdr', 'focus', 'panorama'].includes(group.kind))
          result = await mutation('merge', { kind: group.kind, paths: group.sources.map((s) => s.path) });
        else {
          const session_id = originals[0].session_id;
          if (group.kind === 'ai-mask')
            result = await mutation(
              'mask_generate',
              {
                session_id,
                kind: group.mask_kind ?? 'subject',
                ...(group.parameters ? { parameters: group.parameters } : {}),
                ...(group.region ? { region: group.region } : {}),
              },
              ['session_id', 'mask_id'],
            );
          else if (group.kind === 'negative')
            result = await mutation('negative_convert', { session_id, parameters: group.parameters ?? {} });
          else if (group.background) {
            const started = (
              await mutation(
                'start_denoise',
                { session_id, method: group.method ?? 'bm3d', intensity: group.intensity ?? 35 },
                ['job_id'],
              )
            ).data;
            const done = await waitDenoise(started.job_id);
            result = { data: { session_id: done.result_session_id, job: done } };
          } else
            result = await mutation('denoise', {
              session_id,
              method: group.method ?? 'bm3d',
              intensity: group.intensity ?? 35,
            });
          result.data.session_id ??= session_id;
        }
        assert.ok(result.data.session_id);
        const finalState = (await h.call('get_session', { session_id: result.data.session_id })).data;
        const region = detailRegion(group, finalState.dimensions);
        await overview({ session_id: result.data.session_id }, 'result-overview');
        await nativeDetail({ session_id: result.data.session_id }, region, 'result-native-detail');
        if (group.kind === 'panorama') {
          // Distributed native tiles expose seams outside the central default crop.
          const { width, height } = finalState.dimensions;
          for (const [index, fraction] of [0.25, 0.5, 0.75].entries()) {
            const tileWidth = Math.min(width, 512),
              tileHeight = Math.min(height, 512);
            const tile = {
              x: Math.max(0, Math.min(width - tileWidth, Math.round(width * fraction - tileWidth / 2))),
              y: Math.floor((height - tileHeight) / 2),
              width: tileWidth,
              height: tileHeight,
            };
            await nativeDetail(
              { session_id: result.data.session_id },
              tile,
              `panorama-distributed-detail-${index + 1}`,
            );
          }
          await h.check(
            `panorama_capture_provenance_${group.id}`,
            ['tool:merge', 'parameter:merge.kind="panorama"'],
            async () => {
              assert.equal(finalState.metadata.derivedFrom.operation, 'panorama');
              assert.equal(new Set(finalState.metadata.derivedFrom.session_ids).size, group.sources.length);
              const expansion = width / Math.max(...originals.map((source) => source.dimensions.width));
              if (group.minimum_width_expansion)
                assert.ok(
                  expansion >= group.minimum_width_expansion,
                  `Panorama width expands only ${expansion} times; expected ${group.minimum_width_expansion}`,
                );
              return {
                dimensions: finalState.dimensions,
                width_expansion: expansion,
                source_count: group.sources.length,
                photographic_quality: 'requires_separate_visual_review',
              };
            },
          );
          await mutation('save_session', { session_id: result.data.session_id });
          const beforeReload = await h.call('render', {
            session_id: result.data.session_id,
            format: 'png',
            long_edge: 512,
          });
          const reloadRegion = nativeReviewTiles(region)[0];
          const beforeReloadDetail = await h.call('render', {
            session_id: result.data.session_id,
            format: 'png',
            region: reloadRegion,
          });
          await h.reconnect();
          const afterReload = await h.call('render', {
            session_id: result.data.session_id,
            format: 'png',
            long_edge: 512,
          });
          const afterReloadDetail = await h.call('render', {
            session_id: result.data.session_id,
            format: 'png',
            region: reloadRegion,
          });
          await h.check(
            `panorama_reload_pixels_${group.id}`,
            ['tool:save_session', 'tool:render'],
            async () => {
              assert.deepEqual(
                afterReload.images,
                beforeReload.images,
                'Saved panorama must retain RAW interpretation and identical rendered pixels after restart',
              );
              assert.deepEqual(
                afterReloadDetail.images,
                beforeReloadDetail.images,
                'Saved panorama must retain identical native detail after restart',
              );
              return {
                dimensions: finalState.dimensions,
                preview_long_edge: 512,
                native_region: reloadRegion,
                persisted_pixels_equal: true,
              };
            },
            'pixel_assertion',
          );
        }
        if (result.data.mask_id) {
          const args = { session_id: result.data.session_id, mask_id: result.data.mask_id, mask_mode: 'overlay' };
          await overview(args, 'mask-overlay-overview');
          await nativeDetail(args, region, 'mask-overlay-native-detail');
        }
        await mutation('save_session', { session_id: result.data.session_id });
        await writeFile(
          join(directory, 'review-required.json'),
          JSON.stringify(
            {
              fixture: group.id,
              capture_group: group.capture_group,
              partition: group.partition,
              criteria: group.review_criteria,
              status: 'not_reviewed',
              first_attempt: true,
              session_id: result.data.session_id,
              original_sessions: originals.map((opened) => opened.session_id),
              native_detail_region: region,
              native_detail_tiles: nativeReviewTiles(region),
              source_processing:
                'Full original resolution; only review overviews are resized. Larger native review rectangles are tiled without resizing.',
              operation_result: result.data,
              artifacts,
              note: 'Successful execution and nonempty mask coverage are not photographic quality approval.',
            },
            null,
            2,
          ),
          { flag: 'wx' },
        );
        return {
          session_id: result.data.session_id,
          first_attempt_directory: directory,
          photographic_quality: 'not_reviewed',
          artifacts,
          background: !!group.background,
        };
      });
    } catch (error) {
      failures.push({ group: group.id, error: String(error) });
      if (isDisconnected(error)) unavailable = String(error);
      await writeFile(
        join(directory, 'failure.json'),
        JSON.stringify({ error: String(error), first_attempt: true, transport_unavailable: !!unavailable }, null, 2),
        { flag: 'wx' },
      );
    }
  }
  await writeFile(join(workspace, 'skipped-fixtures.json'), JSON.stringify(skippedFixtures, null, 2), { flag: 'wx' });
} finally {
  await h.close(failures.length ? JSON.stringify(failures) : undefined);
}
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
