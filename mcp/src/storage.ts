import { constants } from 'node:fs';
import { copyFile, lstat, open, statfs } from 'node:fs/promises';

/** Keep captured inputs independent while requesting filesystem copy-on-write. */
export async function copyIndependent(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular source file');
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const file = await open(target, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

export async function requireFreeSpace(path: string, minimumGiB = 20): Promise<void> {
  if (!Number.isFinite(minimumGiB) || minimumGiB <= 0) throw new Error('Minimum free GiB must be positive');
  const stats = await statfs(path, { bigint: true });
  const available = stats.bavail * stats.bsize;
  if (available < BigInt(Math.ceil(minimumGiB * 1024 ** 3))) {
    throw new Error(`STORAGE_LOW: ${(Number(available) / 1024 ** 3).toFixed(1)} GiB free; ${minimumGiB} GiB required. Free rebuildable caches or archive completed work before starting another run.`);
  }
}
