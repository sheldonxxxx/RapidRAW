import { v4 as uuidv4 } from 'uuid';
import { INITIAL_MASK_CONTAINER, type AiPatch, type MaskContainer } from './adjustments';
import { Mask } from '../components/panel/right/Masks';

const DIRECT_TYPES = new Set<Mask>([Mask.Clone, Mask.Heal, Mask.Liquify, Mask.Retouch]);

export function isDirectToolPatch(patch: AiPatch): boolean {
  return patch.subMasks.some((part) => DIRECT_TYPES.has(part.type));
}

export function copyMaskSelectionToRepair(mask: MaskContainer, name: string): AiPatch {
  return {
    id: uuidv4(),
    name,
    invert: mask.invert,
    visible: true,
    isLoading: false,
    prompt: '',
    patchData: null,
    subMasks: mask.subMasks.map((part) => ({
      ...structuredClone(part),
      id: uuidv4(),
    })),
  };
}

export function copyRepairSelectionToMask(patch: AiPatch, name: string): MaskContainer {
  return {
    ...structuredClone(INITIAL_MASK_CONTAINER),
    id: uuidv4(),
    name,
    invert: patch.invert,
    subMasks: patch.subMasks.map((part) => ({
      ...structuredClone(part),
      id: uuidv4(),
      // Quick Erase uses the same saved bitmap as Subject, but its canvas gesture starts a repair.
      type: part.type === Mask.QuickEraser ? Mask.AiSubject : part.type,
    })),
  };
}

export function selectionFingerprint(selection: Pick<AiPatch, 'invert' | 'subMasks'>): string {
  return JSON.stringify([
    selection.invert,
    selection.subMasks.map((part) => [part.type, part.mode, part.visible, part.invert, part.opacity, part.parameters]),
  ]);
}
