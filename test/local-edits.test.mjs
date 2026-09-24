import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'rapidraw-local-edits-'));
after(() => rm(directory, { recursive: true, force: true }));
const outfile = join(directory, 'local-edits.mjs');
await build({
  entryPoints: [resolve('src/utils/localEdits.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'mask-types',
      setup(builder) {
        builder.onResolve({ filter: /components\/panel\/right\/Masks$/ }, () => ({
          path: 'mask-types',
          namespace: 'fixture',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents:
            'export const Mask = {Clone:"clone",Heal:"heal",Liquify:"liquify",Retouch:"retouch",QuickEraser:"quick-eraser",AiSubject:"ai-subject"}; export const SubMaskMode = {Additive:"additive"};',
          loader: 'js',
        }));
      },
    },
  ],
});
const {
  cloneLocalAdjustment,
  cloneLocalRepair,
  cloneSelectionComponent,
  copyMaskSelectionToRepair,
  copyRepairSelectionToMask,
  isDirectToolPatch,
  selectionFingerprint,
} = await import(pathToFileURL(outfile));

test('duplicated selections get independent IDs and preserve the source', () => {
  const mask = {
    id: 'original',
    name: 'Subject',
    invert: false,
    adjustments: { exposure: 2 },
    subMasks: [{ id: 'brush', name: 'Brush', invert: false, parameters: { lines: [{ points: [{ x: 4 }] }] } }],
  };
  const duplicate = cloneLocalAdjustment(mask, true, true);
  assert.notEqual(duplicate.id, mask.id);
  assert.notEqual(duplicate.subMasks[0].id, mask.subMasks[0].id);
  assert.equal(duplicate.invert, true);
  assert.equal(duplicate.adjustments.exposure, 0);
  assert.equal(mask.adjustments.exposure, 2);
  duplicate.subMasks[0].parameters.lines[0].points[0].x = 20;
  assert.equal(mask.subMasks[0].parameters.lines[0].points[0].x, 4);

  const component = cloneSelectionComponent(mask.subMasks[0], true);
  assert.notEqual(component.id, mask.subMasks[0].id);
  assert.equal(component.invert, true);
});

test('copied repairs discard generated pixels and candidate state', () => {
  const repair = {
    id: 'repair',
    name: 'Remove branch',
    invert: false,
    isLoading: true,
    patchData: { color: 'generated-pixels' },
    appliedCandidateId: 'candidate',
    subMasks: [{ id: 'brush', invert: false, parameters: { lines: [] } }],
  };
  const duplicate = cloneLocalRepair(repair, true);
  assert.notEqual(duplicate.id, repair.id);
  assert.notEqual(duplicate.subMasks[0].id, repair.subMasks[0].id);
  assert.equal(duplicate.invert, true);
  assert.equal(duplicate.patchData, null);
  assert.equal(duplicate.appliedCandidateId, undefined);
  assert.equal(duplicate.isLoading, false);
  assert.equal(repair.patchData.color, 'generated-pixels');
});

test('copying an adjustment selection creates independent repair geometry and IDs', () => {
  const mask = {
    id: 'adjustment',
    name: 'Subject',
    invert: true,
    subMasks: [{ id: 'brush', type: 'brush', parameters: { lines: [{ points: [{ x: 12, y: 8 }] }] } }],
  };
  const repair = copyMaskSelectionToRepair(mask, 'Subject repair');
  assert.notEqual(repair.id, mask.id);
  assert.notEqual(repair.subMasks[0].id, mask.subMasks[0].id);
  assert.equal(repair.invert, true);
  assert.equal(repair.name, 'Subject repair');
  assert.equal(repair.patchData, null);
  assert.equal(repair.prompt, '');
  repair.subMasks[0].parameters.lines[0].points[0].x = 99;
  assert.equal(mask.subMasks[0].parameters.lines[0].points[0].x, 12);
});

test('copying a repair selection creates a neutral adjustment with independent geometry and IDs', () => {
  const repair = {
    id: 'repair',
    name: 'Subject repair',
    invert: true,
    prompt: 'remove background bird',
    patchData: { color: 'generated-pixels' },
    subMasks: [{ id: 'brush', type: 'brush', parameters: { lines: [{ points: [{ x: 12, y: 8 }] }] } }],
  };
  const adjustment = copyRepairSelectionToMask(repair, 'Subject adjustment');
  assert.notEqual(adjustment.id, repair.id);
  assert.notEqual(adjustment.subMasks[0].id, repair.subMasks[0].id);
  assert.equal(adjustment.name, 'Subject adjustment');
  assert.equal(adjustment.invert, true);
  assert.equal(adjustment.visible, true);
  assert.equal(adjustment.opacity, 100);
  assert.equal(adjustment.adjustments.exposure, 0);
  assert.equal('patchData' in adjustment, false);
  assert.equal('prompt' in adjustment, false);
  adjustment.subMasks[0].parameters.lines[0].points[0].x = 99;
  assert.equal(repair.subMasks[0].parameters.lines[0].points[0].x, 12);
  const second = copyRepairSelectionToMask(repair, 'Second adjustment');
  assert.notEqual(adjustment.id, second.id);
  assert.notEqual(adjustment.subMasks[0].id, second.subMasks[0].id);
  adjustment.adjustments.curves.luma[0].x = 10;
  assert.notEqual(adjustment.adjustments.curves.luma[0].x, second.adjustments.curves.luma[0].x);
});

test('copying a Quick Erase selection makes it an adjustment Subject selection', () => {
  const repair = {
    id: 'quick-erase',
    invert: false,
    subMasks: [{ id: 'erase', type: 'quick-eraser', parameters: { maskDataBase64: 'saved-mask' } }],
  };
  const adjustment = copyRepairSelectionToMask(repair, 'Adjustment');
  assert.equal(adjustment.subMasks[0].type, 'ai-subject');
  assert.equal(adjustment.subMasks[0].parameters.maskDataBase64, 'saved-mask');
  assert.equal(repair.subMasks[0].type, 'quick-eraser');
});

test('selection fingerprints report changed repair selections without changing generated pixels', () => {
  const repair = { invert: false, subMasks: [{ id: 'one', type: 'brush', parameters: { lines: [] } }] };
  const generated = structuredClone(repair);
  assert.equal(selectionFingerprint(repair), selectionFingerprint(generated));
  repair.subMasks[0].name = 'A clearer label';
  assert.equal(selectionFingerprint(repair), selectionFingerprint(generated));
  repair.subMasks[0].parameters.lines.push({ points: [{ x: 1, y: 2 }] });
  assert.notEqual(selectionFingerprint(repair), selectionFingerprint(generated));
});

test('existing direct tools stay separate from selection based repairs', () => {
  assert.equal(isDirectToolPatch({ subMasks: [{ type: 'heal' }] }), true);
  assert.equal(isDirectToolPatch({ subMasks: [{ type: 'retouch' }] }), true);
  assert.equal(isDirectToolPatch({ subMasks: [{ type: 'brush' }] }), false);
  assert.equal(isDirectToolPatch({ subMasks: [{ type: 'quick-eraser' }] }), false);
});
