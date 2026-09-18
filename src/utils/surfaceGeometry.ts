import type { Adjustments } from './adjustments';

// Match the native geometry signature. Display rotation and crop transform the
// stored maps; lens, perspective and retouch changes require new analysis.
const keys = [
  'transformDistortion',
  'transformVertical',
  'transformHorizontal',
  'transformRotate',
  'transformAspect',
  'transformScale',
  'transformXOffset',
  'transformYOffset',
  'lensDistortionAmount',
  'lensVignetteAmount',
  'lensTcaAmount',
  'lensDistortionParams',
  'lensMaker',
  'lensModel',
  'lensDistortionEnabled',
  'lensTcaEnabled',
  'lensVignetteEnabled',
  'guidedPerspective',
  'aiPatches',
] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value ?? null;
}

export function surfaceGeometrySnapshot(a: Adjustments): string {
  return JSON.stringify(canonical(Object.fromEntries(keys.map((key) => [key, a[key]]))));
}

export function surfaceRequestSnapshot(a: Adjustments): string {
  return JSON.stringify({
    ...JSON.parse(surfaceGeometrySnapshot(a)),
    rotation: a.rotation,
    orientationSteps: a.orientationSteps,
    flipHorizontal: a.flipHorizontal,
    flipVertical: a.flipVertical,
    crop: a.crop,
  });
}

export async function surfaceGeometryHash(snapshot: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const isSurfaceMask = (type: string) => type === 'ai-normals' || type === 'ai-albedo';

export function surfaceLayoutError(a: Pick<Adjustments, 'masks' | 'aiPatches'>): 'multiple' | 'slots' | null {
  const surfaces = a.masks.filter((m) => m.subMasks.some((p) => isSurfaceMask(p.type)));
  if (
    surfaces.some((m) => m.subMasks.filter((p) => isSurfaceMask(p.type)).length > 1) ||
    a.aiPatches?.some((m) => m.subMasks.some((p) => isSurfaceMask(p.type)))
  )
    return 'multiple';
  if (
    surfaces.length &&
    a.masks.reduce((n, m) => n + 1 + Number(m.subMasks.some((p) => p.type === 'ai-normals')), 0) > 32
  )
    return 'slots';
  return null;
}
