import type { Adjustments } from './adjustments';

type DepthGeometry = Pick<Adjustments, 'masks' | 'rotation' | 'orientationSteps' | 'flipHorizontal' | 'flipVertical'>;

export function syncMarigoldOrientation<T extends DepthGeometry>(adjustments: T): T {
  let changed = false;
  const keys = ['rotation', 'orientationSteps', 'flipHorizontal', 'flipVertical'] as const;
  const masks = adjustments.masks.map((mask) => {
    let maskChanged = false;
    const subMasks = mask.subMasks.map((part) => {
      if (
        !(
          (part.type === 'ai-depth' && part.parameters.depthProvider === 'marigold') ||
          part.type === 'ai-normals' ||
          part.type === 'ai-albedo'
        ) ||
        keys.every((key) => part.parameters[key] === adjustments[key])
      )
        return part;
      changed = maskChanged = true;
      return {
        ...part,
        parameters: {
          ...part.parameters,
          rotation: adjustments.rotation,
          orientationSteps: adjustments.orientationSteps,
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
        },
      };
    });
    return maskChanged ? { ...mask, subMasks } : mask;
  });
  return changed ? { ...adjustments, masks } : adjustments;
}
