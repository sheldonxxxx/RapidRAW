import { SubMaskMode, type Mask, type MaskParameters } from './Masks';
import {
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_ADJUSTMENTS,
  pickAdjustments,
  type AdjustmentSetter,
  type Adjustments,
  type MaskAdjustments,
  type MaskContainer,
} from '../../../utils/adjustments';

const MASK_ADJUSTMENT_KEYS = Object.keys(INITIAL_MASK_ADJUSTMENTS) as (keyof Adjustments)[];

export function applyLinearFalloffSelection(
  value: string,
  update: (parameters: Pick<MaskParameters, 'falloff'>) => void,
): void {
  if (value === 'linear' || value === 'smoothstep' || value === 'smootherstep') {
    update({ falloff: value });
  }
}

export function applyMaskAdjustmentUpdate(
  current: MaskAdjustments,
  update: Parameters<AdjustmentSetter>[0],
): MaskAdjustments {
  const next = typeof update === 'function' ? update({ ...INITIAL_ADJUSTMENTS, ...current }) : update;
  return { ...current, ...pickAdjustments(next, MASK_ADJUSTMENT_KEYS) };
}

export function insertCreatedSubMask(
  container: Pick<MaskContainer, 'id' | 'subMasks'>,
  targetId: string | number,
  type: Mask,
  addSubMask: (containerId: string, type: Mask, mode: SubMaskMode, insertIndex: number) => void,
): void {
  const index = container.subMasks.findIndex((mask) => mask.id === targetId);
  addSubMask(container.id, type, SubMaskMode.Additive, index);
}
