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
import { execFileSync } from 'node:child_process';
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
    raw = execFileSync('grep', ['-E', MAPS_KEYWORDS.join('|'), `/proc/${pid}/maps`], {
      encoding: 'utf8',
    });
  } catch (error) {
    // grep exits 1 on no match; anything else means maps are unavailable.
    if (error?.status !== 1) {
      return { note: `maps unavailable for pid ${pid}: ${String(error).split('\n')[0]}` };
    }
    raw = '';
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
  // argv-form pgrep (no shell): the pattern never appears in an invoking
  // shell command line, so pgrep cannot match its own launcher. pgrep
  // exits 1 on no match, which simply means no engine process.
  try {
    const out = execFileSync('pgrep', ['-f', binaryPath], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
