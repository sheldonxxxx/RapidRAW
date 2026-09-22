import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuth } from '@clerk/react';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { Invokes } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { debouncedSave } from './useEditorActions';
import type { AiPatchData, GenerationOptions, InpaintCandidate } from '../utils/adjustments';
import { inpaintSpatialKey, MAX_INPAINT_BATCH, variationOptions } from '../utils/inpaintHistory';
import { globalImageCache } from '../utils/ImageLRUCache';

export function useInpaintCandidates() {
  const { getToken } = useAuth();
  const cancelled = useRef(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const generate = async (
    patchId: string,
    prompt: string,
    basic: boolean,
    options: GenerationOptions | undefined,
    count: number,
  ) => {
    const start = useEditorStore.getState();
    const path = start.selectedImage?.path;
    const patch = start.adjustments.aiPatches.find((entry) => entry.id === patchId);
    if (!path || !patch || start.isGeneratingAi || !Number.isInteger(count) || count < 1 || count > MAX_INPAINT_BATCH)
      return;
    cancelled.current = false;
    const total = basic ? 1 : count;
    const batchId = uuidv4();
    let completed = 0;
    const spatialKey = inpaintSpatialKey(start.adjustments);
    // Never feed earlier variations back into this batch's source image.
    const sourceAdjustments = { ...start.adjustments, inpaintHistory: undefined };
    start.setEditor({ isGeneratingAi: true, previewOverride: null });
    setProgress({ completed, total });
    let latestAdjustments = start.adjustments;
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (state.selectedImage?.path !== path) cancelled.current = true;
      else latestAdjustments = state.adjustments;
    });
    try {
      const token = await getToken();
      for (let index = 0; index < total && !cancelled.current; index++) {
        const generationOptions = basic ? undefined : variationOptions(options, index);
        const definition = { ...patch, prompt, generationOptions };
        const response = await invoke<string>(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          path,
          currentAdjustments: sourceAdjustments,
          patchDefinition: definition,
          useFastInpaint: basic,
          token: token || null,
        });
        const patchData: AiPatchData = JSON.parse(response);
        const candidate: InpaintCandidate = {
          id: uuidv4(),
          batchId,
          createdAt: new Date().toISOString(),
          spatialKey,
          method: basic ? 'basic' : 'generative',
          patch: {
            ...definition,
            generationOptions: patchData.generation
              ? { ...generationOptions, seed: patchData.generation.seed, profile: patchData.generation.profile }
              : generationOptions,
            patchData,
            isLoading: false,
            name: basic ? 'Inpaint' : prompt.trim() || patch.name,
          },
        };
        latestAdjustments = {
          ...latestAdjustments,
          inpaintHistory: [...(latestAdjustments.inpaintHistory ?? []), candidate],
        };
        const current = useEditorStore.getState();
        if (current.selectedImage?.path === path) {
          current.setEditor({ adjustments: latestAdjustments });
        }
        // Flush pending photo edits before saving this completed candidate.
        await debouncedSave.flush();
        await invoke(Invokes.SaveMetadataAndUpdateThumbnail, {
          path,
          adjustments: latestAdjustments,
        });
        const cached = globalImageCache.get(path);
        if (cached) globalImageCache.set(path, { ...cached, adjustments: latestAdjustments });
        completed++;
        setProgress({ completed, total });
      }
    } catch (error) {
      toast.error(`Generation stopped after ${completed}/${total} results: ${String(error)}`);
    } finally {
      unsubscribe();
      useEditorStore.getState().setEditor({ isGeneratingAi: false });
      setProgress(null);
    }
  };
  return {
    generate,
    progress,
    stop: () => {
      cancelled.current = true;
    },
  };
}
