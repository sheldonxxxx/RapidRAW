type AdjustmentObject = Record<string, unknown>;
type CurvePoint = { x: number; y: number };

function isObject(value: unknown): value is AdjustmentObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCurve(value: unknown): value is CurvePoint[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((point) => isObject(point) && typeof point.x === 'number' && typeof point.y === 'number')
  );
}

function evaluateCurveY(curve: CurvePoint[], x: number): number {
  if (x <= curve[0].x) return curve[0].y;
  if (x >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  for (let i = 1; i < curve.length; i++) {
    const left = curve[i - 1],
      right = curve[i];
    if (x <= right.x) {
      return right.x === left.x ? left.y : left.y + ((x - left.x) / (right.x - left.x)) * (right.y - left.y);
    }
  }
  return x;
}

function mixSelected(preset: AdjustmentObject, base: AdjustmentObject, fraction: number): AdjustmentObject {
  if (fraction === 1) return { ...preset };
  const result: AdjustmentObject = {};
  for (const [key, value] of Object.entries(preset)) {
    const from = base[key];
    if (typeof value === 'number' && typeof from === 'number') {
      result[key] = from + (value - from) * fraction;
    } else if (isCurve(value) && isCurve(from)) {
      const xs = [...new Set([...from, ...value].map((point) => point.x))].sort((a, b) => a - b);
      result[key] = xs.map((x) => {
        const y = evaluateCurveY(from, x) + (evaluateCurveY(value, x) - evaluateCurveY(from, x)) * fraction;
        return { x, y: Math.max(0, Math.min(255, y)) };
      });
    } else if (isObject(value)) {
      result[key] = mixSelected(value, isObject(from) ? from : {}, fraction);
    } else {
      // Masks, other array topology, strings and flags select the preset value.
      result[key] = value;
    }
  }
  return result;
}

/** Blend only preset controls from a stable pre-preset snapshot. */
export function applyPresetIntensity<T extends object>(
  preset: object,
  intensity: number,
  capturedBase: T,
  current: T = capturedBase,
): T {
  const fraction = Math.max(0, Math.min(1, intensity / 100));
  if (fraction === 0) return { ...capturedBase };
  const target = preset as AdjustmentObject;
  const base = { ...capturedBase } as AdjustmentObject;
  // With no earlier LUT, a new look fades in from zero effective LUT strength.
  if (typeof target.lutPath === 'string' && target.lutPath && !base.lutPath) base.lutIntensity = 0;
  return { ...current, ...mixSelected(target, base, fraction) };
}
