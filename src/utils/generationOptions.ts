import type { GenerationOptions } from './adjustments';

export interface GenerationProfile {
  id: string;
  label: string;
  defaultMegapixels: number;
  megapixels: number[];
  requiresPrompt?: boolean;
}

export interface GenerationCapabilities {
  seed: boolean;
  defaultProfile: string;
  profiles: GenerationProfile[];
}

export interface CapabilityState {
  scope: string;
  status: 'inactive' | 'loading' | 'ready' | 'legacy' | 'error';
  data?: GenerationCapabilities;
  message?: string;
}

export interface GenerationDraft {
  profile?: string;
  megapixels?: number;
  seedText: string;
  useDefault?: boolean;
}

export function generationDraft(options?: GenerationOptions): GenerationDraft {
  return { profile: options?.profile, megapixels: options?.megapixels, seedText: options?.seed?.toString() ?? '' };
}

export function scopedCapabilities(state: CapabilityState, scope: string, enabled: boolean): CapabilityState {
  if (!enabled) return { scope, status: 'inactive' };
  return state.scope === scope ? state : { scope, status: 'loading' };
}

export function resolveGenerationOptions(
  state: CapabilityState,
  draft: GenerationDraft,
): {
  options?: GenerationOptions;
  error?: 'loading' | 'unavailable' | 'profile' | 'detail' | 'seed' | 'seedUnsupported';
} {
  if (draft.useDefault || state.status === 'inactive') return {};
  const hasSavedOptions = !!draft.profile || draft.megapixels !== undefined || !!draft.seedText.trim();
  if (state.status === 'legacy') return hasSavedOptions ? { error: 'unavailable' } : {};
  if (state.status === 'loading') return { error: 'loading' };
  if (state.status !== 'ready' || !state.data) return { error: 'unavailable' };
  const capabilities = state.data;
  const profile = capabilities.profiles.find((entry) => entry.id === (draft.profile ?? capabilities.defaultProfile));
  if (!profile) return { error: 'profile' };
  const megapixels = draft.megapixels ?? profile.defaultMegapixels;
  if (!Number.isFinite(megapixels) || !profile.megapixels.some((mp) => Math.abs(mp - megapixels) <= 1e-9)) {
    return { error: 'detail' };
  }
  const seedText = draft.seedText.trim();
  const seed = seedText ? Number(seedText) : undefined;
  if (seed !== undefined && (!/^[1-9]\d*$/.test(seedText) || !Number.isSafeInteger(seed) || seed < 1)) {
    return { error: 'seed' };
  }
  if (seed !== undefined && !capabilities.seed) return { error: 'seedUnsupported' };
  return { options: { profile: profile.id, megapixels, ...(seed !== undefined ? { seed } : {}) } };
}
