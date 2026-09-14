export const FORK_RELEASES_URL = 'https://github.com/sheldonxxxx/RapidRAW/releases';
export const FORK_RELEASES_API = 'https://api.github.com/repos/sheldonxxxx/RapidRAW/releases?per_page=30';

function parseVersion(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function findForkUpdate(current: string, releases: unknown) {
  const installed = parseVersion(current);
  if (!installed || !Array.isArray(releases)) return null;
  let update: { version: string; url: string } | null = null;
  for (const value of releases) {
    if (!value || typeof value !== 'object') continue;
    const release = value as Record<string, unknown>;
    if (release.draft !== false || typeof release.tag_name !== 'string') continue;
    if (!release.tag_name.startsWith('fork-v')) continue;
    const version = release.tag_name.slice('fork-v'.length);
    const candidate = parseVersion(version);
    if (!candidate) continue;
    if (!installed.pre.length && (candidate.pre.length || release.prerelease === true)) continue;
    if (compareVersions(version, update?.version ?? current) !== 1) continue;
    update = { version, url: `${FORK_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` };
  }
  return update;
}
