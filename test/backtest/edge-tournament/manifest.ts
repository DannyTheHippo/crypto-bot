import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CACHE_DIR = join(__dirname, 'cache');
export const MANIFEST_PATH = join(CACHE_DIR, 'manifest.json');

export interface ManifestDatasetEntry {
  readonly id: string;
  readonly url: string;
  readonly requestParams: Record<string, string | number | boolean>;
  readonly rangeStartMs: number | null;
  readonly rangeEndMs: number | null;
  readonly rowCount: number;
  readonly sha256: string;
  readonly cachePath: string;
}

export interface EdgeTournamentManifest {
  readonly version: 1;
  readonly frozenAt: string;
  readonly preregReport: 'research/studies/edge-tournament-preregistration-2026-07-24.md';
  readonly datasets: readonly ManifestDatasetEntry[];
}

function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = sortedKeys(src[k]);
  return out;
}

export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Hex(readFileSync(path));
}

export function manifestHash(manifest: EdgeTournamentManifest): string {
  return sha256Hex(JSON.stringify(sortedKeys(manifest)));
}

export function writeManifest(manifest: EdgeTournamentManifest): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

export function readManifest(): EdgeTournamentManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as EdgeTournamentManifest;
}

export function buildDatasetEntry(params: {
  id: string;
  url: string;
  requestParams: Record<string, string | number | boolean>;
  rangeStartMs: number | null;
  rangeEndMs: number | null;
  rowCount: number;
  cachePath: string;
  contentSha256?: string;
}): ManifestDatasetEntry {
  const sha =
    params.contentSha256 ??
    (existsSync(params.cachePath) ? sha256File(params.cachePath) : '0'.repeat(64));
  return {
    id: params.id,
    url: params.url,
    requestParams: params.requestParams,
    rangeStartMs: params.rangeStartMs,
    rangeEndMs: params.rangeEndMs,
    rowCount: params.rowCount,
    sha256: sha,
    cachePath: params.cachePath,
  };
}

export function verifyManifestIntegrity(manifest: EdgeTournamentManifest): string[] {
  const errors: string[] = [];
  for (const ds of manifest.datasets) {
    if (!existsSync(ds.cachePath)) {
      errors.push(`missing cache: ${ds.id} -> ${ds.cachePath}`);
      continue;
    }
    const hash = sha256File(ds.cachePath);
    if (hash !== ds.sha256) {
      errors.push(`hash mismatch: ${ds.id} expected ${ds.sha256} got ${hash}`);
    }
  }
  return errors;
}
