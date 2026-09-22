import type { SubMask } from '../components/panel/right/Masks';
import type { Adjustments } from './adjustments';

export function preparePreviewSubMasks(
  subMasks: SubMask[],
  cachedAssets: ReadonlySet<string>,
  sentAssets = new Set<string>(),
) {
  if (!Array.isArray(subMasks)) return subMasks;
  return subMasks.map((mask) => {
    const parameters = { ...mask.parameters };
    for (const key of ['mask_data_base64', 'maskDataBase64'] as const) {
      if (mask.id && parameters[key] != null) {
        if (cachedAssets.has(mask.id)) parameters[key] = null;
        else sentAssets.add(mask.id);
      }
    }
    return { ...mask, parameters };
  });
}

// Keep immutable editor/history data shared until IPC serializes the payload.
// Cloning entire recipes here also copies multi-megabyte repair and mask assets.
export function preparePreviewAdjustments(adjustments: Adjustments, cachedAssets: ReadonlySet<string>) {
  const sentAssets = new Set<string>();
  const stripSubMasks = (subMasks: SubMask[]) => preparePreviewSubMasks(subMasks, cachedAssets, sentAssets);

  return {
    payload: {
      ...adjustments,
      inpaintHistory: undefined,
      masks: adjustments.masks?.map((mask) => ({ ...mask, subMasks: stripSubMasks(mask.subMasks) })),
      aiPatches: adjustments.aiPatches?.map((patch) => {
        let patchData = patch.patchData;
        if (patch.id && patchData && !patch.isLoading) {
          if (cachedAssets.has(patch.id)) patchData = null;
          else sentAssets.add(patch.id);
        }
        return {
          ...patch,
          patchData,
          generationOptions: patch.generationOptions && {
            ...patch.generationOptions,
            referenceImagesBase64: undefined,
          },
          subMasks: stripSubMasks(patch.subMasks),
        };
      }),
    },
    sentAssets,
  };
}

export function interactivePreviewResolution(target: number, quality?: string) {
  // Zoom detail is restored on release. Full quality remains an explicit opt-in.
  return quality === 'full' ? target : Math.min(target, 1920);
}

/** One running render and one replaceable pending request, including final renders. */
export class PreviewPipeline<T> {
  private pending: T | null = null;
  private running = false;
  private generation = 0;

  constructor(private readonly render: (request: T) => Promise<void>) {}

  enqueue(request: T) {
    this.pending = request;
    this.flush();
  }

  clear() {
    this.pending = null;
    this.generation += 1;
  }

  private flush() {
    if (this.running || this.pending === null) return;
    const request = this.pending;
    const generation = this.generation;
    this.pending = null;
    this.running = true;
    // Errors must release the slot too; the renderer owns user-facing reporting.
    void Promise.resolve()
      .then(() => (generation === this.generation ? this.render(request) : undefined))
      .catch(() => {})
      .finally(() => {
        this.running = false;
        this.flush();
      });
  }
}
