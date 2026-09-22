import type { Adjustments, GenerationOptions, InpaintCandidate } from './adjustments';

export const MAX_INPAINT_BATCH = 4;

/** A saved repair must not be silently placed into a different spatial frame. */
export function inpaintSpatialKey(adjustments: Adjustments): string {
  return JSON.stringify([
    adjustments.orientationSteps,
    adjustments.rotation,
    adjustments.flipHorizontal,
    adjustments.flipVertical,
    adjustments.crop,
    adjustments.transformDistortion,
    adjustments.transformVertical,
    adjustments.transformHorizontal,
    adjustments.transformRotate,
    adjustments.transformAspect,
    adjustments.transformScale,
    adjustments.transformXOffset,
    adjustments.transformYOffset,
    adjustments.lensDistortionAmount,
    adjustments.lensDistortionParams,
    adjustments.lensDistortionEnabled,
    adjustments.lensMaker,
    adjustments.lensModel,
  ]);
}

export function variationOptions(options: GenerationOptions | undefined, index: number): GenerationOptions | undefined {
  if (!options) return undefined;
  if (options.seed === undefined) return { ...options };
  return {
    ...options,
    seed: Number(((BigInt(options.seed) - 1n + BigInt(index)) % BigInt(Number.MAX_SAFE_INTEGER)) + 1n),
  };
}

export function applyInpaintCandidate(adjustments: Adjustments, candidate: InpaintCandidate): Adjustments {
  if (candidate.spatialKey !== inpaintSpatialKey(adjustments)) {
    throw new Error('Restore the original crop, orientation and geometry before applying this result.');
  }
  const patch = { ...candidate.patch, appliedCandidateId: candidate.id, isLoading: false, visible: true };
  const exists = adjustments.aiPatches.some((entry) => entry.id === patch.id);
  return {
    ...adjustments,
    aiPatches: exists
      ? adjustments.aiPatches.map((entry) => (entry.id === patch.id ? patch : entry))
      : [...adjustments.aiPatches, patch],
  };
}

export function toggleInpaintCandidate(adjustments: Adjustments, candidate: InpaintCandidate): Adjustments {
  const applied = adjustments.aiPatches.some((patch) => patch.appliedCandidateId === candidate.id && patch.visible);
  if (!applied) return applyInpaintCandidate(adjustments, candidate);
  return {
    ...adjustments,
    aiPatches: adjustments.aiPatches.map((patch) =>
      patch.appliedCandidateId === candidate.id ? { ...patch, visible: false } : patch,
    ),
  };
}
