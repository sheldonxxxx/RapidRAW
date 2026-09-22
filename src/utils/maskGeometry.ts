import type { Adjustments, AiPatch, Coord, MaskContainer } from './adjustments';
import type { MaskLine, MaskParameters, SubMask } from '../components/panel/right/Masks';

type SpatialState = Pick<Adjustments, 'rotation' | 'orientationSteps' | 'flipHorizontal' | 'flipVertical'>;

const SOURCE_SPACE_MASK_TYPES = new Set([
  'ai-albedo',
  'ai-depth',
  'ai-foreground',
  'ai-normals',
  'ai-sky',
  'ai-subject',
  'color',
  'luminance',
  'quick-eraser',
]);

const normalizeSteps = (steps: number) => ((steps % 4) + 4) % 4;

function orientedDimensions(width: number, height: number, steps: number): Coord {
  return normalizeSteps(steps) % 2 === 1 ? { x: height, y: width } : { x: width, y: height };
}

function orientPoint(point: Coord, width: number, height: number, steps: number): Coord {
  switch (normalizeSteps(steps)) {
    case 1:
      return { x: height - point.y, y: point.x };
    case 2:
      return { x: width - point.x, y: height - point.y };
    case 3:
      return { x: point.y, y: width - point.x };
    default:
      return point;
  }
}

function unorientPoint(point: Coord, width: number, height: number, steps: number): Coord {
  return orientPoint(point, width, height, (4 - normalizeSteps(steps)) % 4);
}

function rotateAroundCenter(point: Coord, width: number, height: number, degrees: number): Coord {
  if (Math.abs(degrees) < 1e-8) return point;

  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;

  return {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
}

export function mapDisplayPoint(
  point: Coord,
  imageWidth: number,
  imageHeight: number,
  from: SpatialState,
  to: SpatialState,
): Coord {
  const fromSteps = normalizeSteps(from.orientationSteps);
  const toSteps = normalizeSteps(to.orientationSteps);
  const fromSize = orientedDimensions(imageWidth, imageHeight, fromSteps);

  // Mask coordinates are stored after the current spatial transform but before
  // crop. Undo the old transform, then apply the new one to the same source
  // point. This keeps a mask attached to the photographed subject.
  let sourcePoint = rotateAroundCenter(point, fromSize.x, fromSize.y, -(from.rotation || 0));

  if (from.flipHorizontal) sourcePoint.x = fromSize.x - sourcePoint.x;
  if (from.flipVertical) sourcePoint.y = fromSize.y - sourcePoint.y;

  sourcePoint = unorientPoint(sourcePoint, fromSize.x, fromSize.y, fromSteps);

  const mapped = orientPoint(sourcePoint, imageWidth, imageHeight, toSteps);
  const toSize = orientedDimensions(imageWidth, imageHeight, toSteps);

  if (to.flipHorizontal) mapped.x = toSize.x - mapped.x;
  if (to.flipVertical) mapped.y = toSize.y - mapped.y;

  return rotateAroundCenter(mapped, toSize.x, toSize.y, to.rotation || 0);
}

function mapPair(
  parameters: Record<string, unknown>,
  xKey: string,
  yKey: string,
  mapPoint: (point: Coord) => Coord,
): void {
  const x = parameters[xKey];
  const y = parameters[yKey];
  if (typeof x !== 'number' || typeof y !== 'number') return;

  const mapped = mapPoint({ x, y });
  parameters[xKey] = mapped.x;
  parameters[yKey] = mapped.y;
}

function transformLines(parameters: Record<string, unknown>, mapPoint: (point: Coord) => Coord): void {
  const lines = parameters.lines;
  if (!Array.isArray(lines)) return;

  parameters.lines = lines.map((line) => {
    if (!line || typeof line !== 'object' || !Array.isArray((line as MaskLine).points)) return line;

    const typedLine = line as MaskLine;
    return {
      ...typedLine,
      points: typedLine.points.map((point) => mapPoint(point)),
    };
  }) as MaskLine[];
}

function transformRadialParameters(parameters: Record<string, unknown>, mapPoint: (point: Coord) => Coord): void {
  const centerX = parameters.centerX;
  const centerY = parameters.centerY;
  if (typeof centerX !== 'number' || typeof centerY !== 'number') return;

  const center = mapPoint({ x: centerX, y: centerY });
  parameters.centerX = center.x;
  parameters.centerY = center.y;

  const radiusX = parameters.radiusX;
  const radiusY = parameters.radiusY;
  if (typeof radiusX !== 'number' || typeof radiusY !== 'number') return;

  const rotation = typeof parameters.rotation === 'number' ? parameters.rotation : 0;
  const radians = (rotation * Math.PI) / 180;
  const axisX = mapPoint({
    x: centerX + Math.cos(radians) * radiusX,
    y: centerY + Math.sin(radians) * radiusX,
  });
  // The spatial transform is rigid, so keep the stored radii exact and only
  // move the centre and rotate the ellipse's local axes.
  parameters.radiusX = radiusX;
  parameters.radiusY = radiusY;

  if (radiusX > 1e-8) {
    parameters.rotation = (Math.atan2(axisX.y - center.y, axisX.x - center.x) * 180) / Math.PI;
  }
}

function updateSourceSpaceTransform(parameters: Record<string, unknown>, to: SpatialState): void {
  parameters.rotation = to.rotation || 0;
  parameters.orientationSteps = normalizeSteps(to.orientationSteps);
  parameters.flipHorizontal = Boolean(to.flipHorizontal);
  parameters.flipVertical = Boolean(to.flipVertical);
}

function transformSubMask(
  subMask: SubMask,
  imageWidth: number,
  imageHeight: number,
  from: SpatialState,
  to: SpatialState,
): SubMask {
  if (!subMask.parameters) return subMask;

  const parameters = { ...subMask.parameters } as Record<string, unknown>;
  if (SOURCE_SPACE_MASK_TYPES.has(subMask.type)) {
    if (subMask.type === 'ai-subject' || subMask.type === 'quick-eraser') {
      const mapPoint = (point: Coord) => mapDisplayPoint(point, imageWidth, imageHeight, from, to);
      mapPair(parameters, 'startX', 'startY', mapPoint);
      mapPair(parameters, 'endX', 'endY', mapPoint);
    }
    updateSourceSpaceTransform(parameters, to);
    return { ...subMask, parameters: parameters as MaskParameters };
  }

  const mapPoint = (point: Coord) => mapDisplayPoint(point, imageWidth, imageHeight, from, to);

  switch (subMask.type) {
    case 'linear':
      mapPair(parameters, 'startX', 'startY', mapPoint);
      mapPair(parameters, 'endX', 'endY', mapPoint);
      break;
    case 'radial':
      transformRadialParameters(parameters, mapPoint);
      break;
    case 'brush':
    case 'clone':
    case 'flow':
    case 'heal':
    case 'liquify':
    case 'retouch':
      transformLines(parameters, mapPoint);
      mapPair(parameters, 'sourceX', 'sourceY', mapPoint);
      break;
    default:
      break;
  }

  return { ...subMask, parameters: parameters as MaskParameters };
}

function transformContainer<T extends MaskContainer | AiPatch>(
  container: T,
  imageWidth: number,
  imageHeight: number,
  from: SpatialState,
  to: SpatialState,
): T {
  return {
    ...container,
    subMasks: container.subMasks.map((subMask) => transformSubMask(subMask, imageWidth, imageHeight, from, to)),
  };
}

export function transformMaskGeometryForSpatialChange(
  masks: MaskContainer[],
  aiPatches: AiPatch[],
  imageWidth: number,
  imageHeight: number,
  from: SpatialState,
  to: SpatialState,
): { masks: MaskContainer[]; aiPatches: AiPatch[] } {
  if (imageWidth <= 0 || imageHeight <= 0) return { masks, aiPatches };

  const sameSpatialState =
    normalizeSteps(from.orientationSteps) === normalizeSteps(to.orientationSteps) &&
    (from.rotation || 0) === (to.rotation || 0) &&
    Boolean(from.flipHorizontal) === Boolean(to.flipHorizontal) &&
    Boolean(from.flipVertical) === Boolean(to.flipVertical);
  if (sameSpatialState) return { masks, aiPatches };

  return {
    masks: masks.map((container) => transformContainer(container, imageWidth, imageHeight, from, to)),
    aiPatches: aiPatches.map((container) => transformContainer(container, imageWidth, imageHeight, from, to)),
  };
}
