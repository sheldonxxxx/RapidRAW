/** Shared CUDA library-identity capture for native benchmark runners.
 *
 * Proves which CUDA libraries a live native engine process actually mapped
 * (from /proc/<pid>/maps with realpaths resolved), rather than what the
 * launcher environment intended. Covers cuDNN core/sub-libraries, cuBLAS /
 * cuBLASLt, cudart, plus other CUDA-runtime families when present
 * (curand, nvrtc, nvJitLink). Never throws for missing /proc entries:
 * absence is reported as a note so a failed capture cannot pass as a
 * successful one.
 */
import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export const MAPS_KEYWORDS = [
  'libcudnn',
  'libcublas',
  'libcublasLt',
  'libcudart',
  'libcurand',
  'libnvrtc',
  'libnvJitLink',
];

export function snapshotCudaMaps(pid) {
  const kept = {};
  let raw;
  try {
    raw = execSync(`grep -E 'libcudnn|libcublas|libcudart|libcurand|libnvrtc|libnvJitLink' /proc/${pid}/maps || true`, {
      encoding: 'utf8',
    });
  } catch (error) {
    return { note: `maps unavailable for pid ${pid}: ${String(error).split('\n')[0]}` };
  }
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const path = parts[parts.length - 1];
    if (!path || !path.startsWith('/')) continue;
    const base = path.split('/').pop();
    if (!MAPS_KEYWORDS.some((keyword) => base.startsWith(keyword))) continue;
    if (!(base in kept)) {
      try {
        kept[base] = realpathSync(path);
      } catch {
        kept[base] = path;
      }
    }
  }
  return { libraries: kept };
}

export function findEnginePids(binaryPath) {
  try {
    const out = execSync(`pgrep -f '${binaryPath}' || true`, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
