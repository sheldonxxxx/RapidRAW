import type { Adjustments, Coord } from './adjustments';
import { mapDisplayPoint } from './maskGeometry';

type Orientation = Pick<Adjustments, 'rotation' | 'orientationSteps' | 'flipHorizontal' | 'flipVertical'>;
const sourceOrientation: Orientation = { rotation: 0, orientationSteps: 0, flipHorizontal: false, flipVertical: false };

// Surface analysis already includes lens/perspective corrections. Only undo
// display orientation here; the caller removes the crop offset and zoom.
export function photoPointToSurface(
  point: Coord,
  width: number,
  height: number,
  orientation: Orientation,
): Coord | null {
  if (!(width > 0 && height > 0)) return null;
  const source = mapDisplayPoint(point, width, height, orientation, sourceOrientation);
  const x = source.x / width;
  const y = source.y / height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -1e-9 || x > 1 + 1e-9 || y < -1e-9 || y > 1 + 1e-9) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

export function surfacePointToPhoto(point: Coord, width: number, height: number, orientation: Orientation): Coord {
  return mapDisplayPoint({ x: point.x * width, y: point.y * height }, width, height, sourceOrientation, orientation);
}

export function displayedLightDirection(angle: number, amount: number): number {
  return ((angle + (amount < 0 ? 180 : 0) + 540) % 360) - 180;
}

export const DEPTH_SELECTIONS = {
  near: { minDepth: 65, maxDepth: 100, minFade: 15, maxFade: 0 },
  middle: { minDepth: 30, maxDepth: 70, minFade: 15, maxFade: 15 },
  far: { minDepth: 0, maxDepth: 35, minFade: 0, maxFade: 15 },
} as const;
