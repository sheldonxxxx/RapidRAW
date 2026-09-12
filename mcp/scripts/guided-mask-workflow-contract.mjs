/** Manifest contract for AI-assisted and manual brush editing regressions. */
import assert from 'node:assert/strict';
import { validatePhotoManifest } from './photo-quality-manifest.mjs';

const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const texts = (values) => Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string' && v.trim());
function keys(value, allowed, context) {
  assert.ok(object(value) && Object.keys(value).every((key) => allowed.includes(key)), `${context} contains unknown fields`);
}
function rectangle(value, maximum = 512) {
  keys(value, ['x', 'y', 'width', 'height'], 'Region');
  assert.ok(['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(value[key])), 'Regions require integer native pixels');
  assert.ok(value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 && value.width <= maximum && value.height <= maximum, `Native review regions must be positive and at most ${maximum} pixels per side`);
}
function point(value) {
  keys(value, ['x', 'y'], 'Point');
  assert.ok([value.x, value.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 100000), 'Points require bounded native coordinates');
}
function brush(parameters, correction = false) {
  keys(parameters, ['lines'], 'Brush parameters');
  assert.ok(Array.isArray(parameters.lines) && parameters.lines.length > 0 && parameters.lines.length <= 100, 'Brush parameters require 1..100 lines');
  assert.ok(parameters.lines.some((line) => line.tool === 'brush'), 'A brush layer needs painted coverage; an eraser alone cannot subtract an AI sibling');
  for (const line of parameters.lines) {
    keys(line, ['tool', 'brushSize', 'feather', 'points'], 'Brush line');
    assert.ok((correction ? ['brush'] : ['brush', 'eraser']).includes(line.tool), 'Use painted brush lines with submask mode for AI corrections');
    assert.ok(Number.isFinite(line.brushSize) && line.brushSize > 0 && line.brushSize <= 100000);
    assert.ok(Number.isFinite(line.feather) && line.feather >= 0 && line.feather <= 1, 'Set feather explicitly in 0..1');
    assert.ok(Array.isArray(line.points) && line.points.length > 0 && line.points.length <= 4096);
    line.points.forEach(point);
  }
}
function effectProbes(probes) {
  keys(probes, ['selected', 'protected'], 'Effect probes');
  for (const [name, gate] of [['selected', 'minimum_mean_absolute_difference'], ['protected', 'maximum_mean_absolute_difference']]) {
    keys(probes[name], ['region', gate], `${name} effect probe`); rectangle(probes[name].region);
    assert.ok(Number.isFinite(probes[name][gate]) && probes[name][gate] >= 0 && probes[name][gate] <= 1);
  }
  assert.ok(probes.selected.minimum_mean_absolute_difference > 0, 'Selected pixels need a nonzero effect gate');
}
export async function validateGuidedMaskManifest(manifest) {
  await validatePhotoManifest(manifest);
  for (const group of manifest.groups) {
    assert.equal(group.kind, 'ai-mask'); assert.equal(group.partition, 'regression', 'Guided corrections reuse inspected inputs and must be labelled regressions');
    assert.equal(group.sources.length, 1); assert.ok(texts(group.review_criteria));
    keys(group.ai, ['kind', 'region', 'parameters', 'refinement'], 'AI selection');
    assert.ok(['subject', 'sky', 'foreground'].includes(group.ai.kind));
    if (group.ai.kind === 'subject') rectangle(group.ai.region, 100000);
    else assert.equal(group.ai.region, undefined, 'Only a subject mask uses a region guide');
    if (group.ai.parameters !== undefined) assert.ok(object(group.ai.parameters));
    if (group.ai.refinement !== undefined) {
      assert.equal(group.ai.kind, 'subject', 'Point refinement only targets subject masks');
      keys(group.ai.refinement, ['include_points', 'exclude_points'], 'Point refinement');
      const seen = new Map(); let count = 0;
      for (const key of ['include_points', 'exclude_points']) if (group.ai.refinement[key] !== undefined) {
        assert.ok(Array.isArray(group.ai.refinement[key]));
        for (const p of group.ai.refinement[key]) { point(p); const token = `${p.x},${p.y}`; assert.ok(!seen.has(token) || seen.get(token) === key, 'A point cannot be both included and excluded'); seen.set(token, key); count++; }
      }
      assert.ok(count > 0 && count <= 64);
    }
    keys(group.local_adjustments, ['exposure', 'shadows'], 'Local grade');
    assert.ok(Number.isFinite(group.local_adjustments.exposure) && group.local_adjustments.exposure !== 0 && Math.abs(group.local_adjustments.exposure) <= 5, 'This workflow requires a nonzero exposure grade within -5..5');
    if (group.local_adjustments.shadows !== undefined) assert.ok(Number.isFinite(group.local_adjustments.shadows) && Math.abs(group.local_adjustments.shadows) <= 100);
    effectProbes(group.effect_probes);
    assert.ok(Array.isArray(group.corrections) && group.corrections.length >= 2 && group.corrections.length <= 16);
    const ids = new Set(), modes = new Set();
    for (const item of group.corrections) {
      keys(item, ['id', 'mode', 'parameters', 'probe', 'review_criteria'], 'Brush correction');
      assert.ok(typeof item.id === 'string' && safeId.test(item.id) && !ids.has(item.id)); ids.add(item.id);
      assert.ok(['additive', 'subtractive'].includes(item.mode)); modes.add(item.mode); brush(item.parameters, true);
      keys(item.probe, ['region', 'minimum_opacity_delta'], 'Correction probe'); rectangle(item.probe.region);
      assert.ok(Number.isFinite(item.probe.minimum_opacity_delta) && item.probe.minimum_opacity_delta > 0 && item.probe.minimum_opacity_delta <= 1, 'Correction probes require a positive opacity delta in 0..1');
      assert.ok(texts(item.review_criteria));
    }
    assert.equal(modes.size, 2, 'Exercise both additive and subtractive corrections');
    keys(group.manual, ['intent', 'parameters', 'effect_probes'], 'Manual mask');
    assert.ok(typeof group.manual.intent === 'string' && group.manual.intent.trim().length > 0 && group.manual.intent.length <= 200, 'Name the manual selection intent separately from the AI selection');
    brush(group.manual.parameters); effectProbes(group.manual.effect_probes);
    assert.ok(Array.isArray(group.review_regions) && group.review_regions.length > 0 && group.review_regions.length <= 8);
    ids.clear();
    for (const view of group.review_regions) {
      keys(view, ['id', 'region', 'criteria'], 'Review region');
      assert.ok(typeof view.id === 'string' && safeId.test(view.id) && !ids.has(view.id)); ids.add(view.id); rectangle(view.region); assert.ok(texts(view.criteria));
    }
  }
  return manifest;
}
export function validateGuidedNativeBounds(group, { width, height }) {
  const regions = [group.ai.region, ...group.corrections.map((c) => c.probe.region), ...group.review_regions.map((r) => r.region), ...[group.effect_probes, group.manual.effect_probes].flatMap((p) => [p.selected.region, p.protected.region])].filter(Boolean);
  assert.ok(regions.every((r) => r.x + r.width <= width && r.y + r.height <= height), 'A workflow region exceeds the opened native canvas');
  const points = [...group.corrections.flatMap((c) => c.parameters.lines.flatMap((l) => l.points)), ...group.manual.parameters.lines.flatMap((l) => l.points), ...group.ai.refinement?.include_points ?? [], ...group.ai.refinement?.exclude_points ?? []];
  assert.ok(points.every((p) => p.x <= width - 1 && p.y <= height - 1), 'A brush or prompt point exceeds the opened native canvas');
}
export function correctionCoverageDelta(mode, before, after) {
  assert.ok(['additive', 'subtractive'].includes(mode) && [before, after].every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  return mode === 'additive' ? after - before : before - after;
}
