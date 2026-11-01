import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect } from 'react';
import { toast } from 'react-toastify';
import { MaskParameters, SubMask } from '../components/panel/right/Masks';
import { Invokes } from '../components/ui/AppProperties';
import { useCloudStore } from '../store/useCloudStore';
import { useEditorStore } from '../store/useEditorStore';
import { useProcessStore } from '../store/useProcessStore';
import { Adjustments, AiPatch, Coord, GenerationOptions, MaskContainer } from '../utils/adjustments';
import { surfaceRequestSnapshot } from '../utils/surfaceGeometry';
import { useEditorActions } from './useEditorActions';

const pendingMarigold = new Map<string, { cancelled: boolean }>();
export const isMarigoldPending = (id: string) => pendingMarigold.has(id);
export const discardMarigoldResult = (id: string) => {
  const request = pendingMarigold.get(id);
  if (request) request.cancelled = true;
};

export const getTransformAdjustments = (adj: Adjustments) => ({
  transformDistortion: adj.transformDistortion,
  transformVertical: adj.transformVertical,
  transformHorizontal: adj.transformHorizontal,
  transformRotate: adj.transformRotate,
  transformAspect: adj.transformAspect,
  transformScale: adj.transformScale,
  transformXOffset: adj.transformXOffset,
  transformYOffset: adj.transformYOffset,
  lensDistortionAmount: adj.lensDistortionAmount,
  lensVignetteAmount: adj.lensVignetteAmount,
  lensTcaAmount: adj.lensTcaAmount,
  lensDistortionParams: adj.lensDistortionParams,
  lensMaker: adj.lensMaker,
  lensModel: adj.lensModel,
  lensDistortionEnabled: adj.lensDistortionEnabled,
  lensTcaEnabled: adj.lensTcaEnabled,
  lensVignetteEnabled: adj.lensVignetteEnabled,
});

export const getSubjectInferenceAdjustments = (adj: Adjustments) => ({
  ...getTransformAdjustments(adj),
  aiPatches: adj.aiPatches,
});

export function useAiMasking() {
  const { setAdjustments } = useEditorActions();
  const setEditor = useEditorStore((state) => state.setEditor);
  const getToken = useCloudStore((s) => s.getToken);
  const registerAiTask = useProcessStore((state) => state.registerAiTask);
  const unregisterAiTask = useProcessStore((state) => state.unregisterAiTask);

  const updateSubMask = useCallback(
    (subMaskId: string, updatedData: Partial<SubMask>) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: prev.masks.map((c: MaskContainer) => ({
          ...c,
          subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
          ...p,
          subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
      }));
    },
    [setAdjustments],
  );

  const handleCancelAiTask = useCallback(
    async (taskId: string) => {
      try {
        await invoke(Invokes.CancelAiTask, { taskId });
      } catch (e) {
        console.error('Failed to cancel AI task:', e);
      } finally {
        unregisterAiTask(taskId);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: (prev.aiPatches || []).map((p: AiPatch) =>
            p.id === taskId || p.subMasks.some((sm) => sm.id === taskId) ? { ...p, isLoading: false } : p,
          ),
        }));
      }
    },
    [unregisterAiTask, setAdjustments],
  );

  const handleDirectPatch = useCallback(
    async (subMaskId: string, sourceX: number, sourceY: number) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;

      const patchId = adjustments.aiPatches?.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const patchDefinitionForBackend = adjustments.aiPatches?.find((p: AiPatch) => p.id === patchId);
        const isLiquify = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'liquify');
        const isRetouch = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'retouch');
        const command = isLiquify
          ? 'generate_liquify_patch'
          : isRetouch
            ? 'generate_retouch_patch'
            : 'generate_manual_cleanup_patch';

        const newPatchDataJson: string = await invoke(command, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinitionForBackend,
          sourcePoint: [sourceX, sourceY],
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId ? { ...p, patchData: newPatchData, isLoading: false } : p,
          ),
        }));
      } catch (err) {
        toast.error(`Patch Generation Failed: ${err instanceof Error ? err.message : String(err)}`);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      }
    },
    [setAdjustments],
  );

  const handleGenerativeReplace = useCallback(
    async (patchId: string, prompt: string, useFastInpaint: boolean, generationOptions?: GenerationOptions) => {
      const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || isGeneratingAi) return;

      const patch: AiPatch | undefined = adjustments.aiPatches?.find((p: AiPatch) => p.id === patchId);
      if (!patch) return;

      const options = useFastInpaint ? undefined : generationOptions && { ...generationOptions };
      const patchDefinition = { ...patch, prompt, generationOptions: options };

      setEditor({ isGeneratingAi: true });
      registerAiTask(patchId, 'inpaint');
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) =>
          p.id === patchId ? { ...p, isLoading: true, prompt, generationOptions: options } : p,
        ),
      }));

      try {
        const token = await getToken();
        const newPatchDataJson: string = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinition,
          path: selectedImage.path,
          useFastInpaint: useFastInpaint,
          token: token || null,
          taskId: patchId,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
        if (!useFastInpaint) {
          useCloudStore.getState().fetchUsage();
        }
      } catch (err: unknown) {
        if (!String(err).includes('cancelled')) {
          toast.error(`AI Replace Failed: ${err}`);
        }
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setEditor({ isGeneratingAi: false });
        unregisterAiTask(patchId);
      }
    },
    [setAdjustments, getToken, registerAiTask, unregisterAiTask, setEditor],
  );

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;
      const token = await getToken();

      const patchId = adjustments.aiPatches?.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setEditor({ isGeneratingAi: true });
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const transformAdjustments = getSubjectInferenceAdjustments(adjustments);
        const newMaskParams: MaskParameters = await invoke(Invokes.GenerateAiSubjectMask, {
          jsAdjustments: transformAdjustments,
          endPoint: [endPoint.x, endPoint.y],
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
          orientationSteps: adjustments.orientationSteps,
          path: selectedImage.path,
          rotation: adjustments.rotation,
          startPoint: [startPoint.x, startPoint.y],
          skipRefinement: true,
          taskId: patchId,
        });

        const subMaskToUpdate = adjustments.aiPatches
          ?.find((p: AiPatch) => p.id === patchId)
          ?.subMasks.find((sm: SubMask) => sm.id === subMaskId);
        const finalSubMaskParams: MaskParameters = { ...subMaskToUpdate?.parameters, ...newMaskParams };
        const updatedAdjustmentsForBackend = {
          ...adjustments,
          aiPatches: adjustments.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        };

        const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
        const newPatchDataJson: string = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: updatedAdjustmentsForBackend,
          patchDefinition: { ...patchDefinitionForBackend, prompt: '', generationOptions: undefined },
          path: selectedImage.path,
          useFastInpaint: true,
          token: token || null,
          taskId: patchId,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err) {
        toast.error(`Quick Erase Failed: ${err instanceof Error ? err.message : String(err)}`);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        unregisterAiTask(patchId);
      }
    },
    [setAdjustments, getToken, registerAiTask, unregisterAiTask, setEditor],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      const { activeMaskContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setEditor({ activeMaskContainerId: null, activeMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      const { activeAiPatchContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  const handleGenerateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    registerAiTask(subMaskId, 'subject');

    try {
      const transformAdjustments = getSubjectInferenceAdjustments(adjustments);
      const newParameters = await invoke<MaskParameters>(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
        skipRefinement: false,
        taskId: subMaskId,
      });

      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      delete mergedParameters.sam21Selection;
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  const handleGenerateSurfaceMask = async (subMaskId: string, kind: 'normals' | 'albedo') => {
    const before = useEditorStore.getState();
    if (!before.selectedImage?.path || before.isGeneratingAiMask) return;
    const identity = before.selectedImage;
    const geometry = surfaceRequestSnapshot(before.adjustments);
    const request = { cancelled: false };
    pendingMarigold.set(subMaskId, request);
    setEditor({ isGeneratingAiMask: true });
    try {
      const generated = await invoke<MaskParameters>('generate_marigold_surface_mask', {
        kind,
        path: identity.path,
        jsAdjustments: JSON.parse(geometry),
      });
      const current = useEditorStore.getState();
      if (
        request.cancelled ||
        current.selectedImage !== identity ||
        surfaceRequestSnapshot(current.adjustments) !== geometry
      ) {
        toast.info('Surface result discarded because the photo changed or the request was cancelled.');
        return;
      }
      const part = current.adjustments.masks.flatMap((m) => m.subMasks).find((s) => s.id === subMaskId);
      if (!part || part.type !== `ai-${kind}`) return;
      current.patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: { ...part.parameters, ...generated } });
    } catch (error) {
      toast.error(`${kind === 'normals' ? 'Shape Light' : 'Surface Colour'} analysis failed: ${error}`);
    } finally {
      pendingMarigold.delete(subMaskId);
      setEditor({ isGeneratingAiMask: false });
    }
  };

  const handleGenerateAiDepthMask = async (
    subMaskId: string,
    parameters: MaskParameters,
    shouldApply: () => boolean = () => true,
  ) => {
    if (parameters.depthProvider === 'marigold') {
      const before = useEditorStore.getState();
      if (!before.selectedImage?.path || before.isGeneratingAiMask) return;
      const snapshot = (a: Adjustments) =>
        JSON.stringify({
          ...getTransformAdjustments(a),
          rotation: a.rotation,
          flipHorizontal: a.flipHorizontal,
          flipVertical: a.flipVertical,
          orientationSteps: a.orientationSteps,
        });
      const imageIdentity = before.selectedImage;
      const geometry = snapshot(before.adjustments);
      const request = { cancelled: false };
      pendingMarigold.set(subMaskId, request);
      setEditor({ isGeneratingAiMask: true });
      try {
        const generated = await invoke<MaskParameters>('generate_marigold_depth_mask', {
          jsAdjustments: JSON.parse(geometry),
          path: before.selectedImage.path,
        });
        const current = useEditorStore.getState();
        if (
          request.cancelled ||
          !shouldApply() ||
          current.selectedImage !== imageIdentity ||
          snapshot(current.adjustments) !== geometry
        ) {
          toast.info('Depth result discarded because the photo changed or the request was cancelled.');
          return;
        }
        const subMask = [...current.adjustments.masks, ...(current.adjustments.aiPatches || [])]
          .flatMap((m) => m.subMasks)
          .find((sm) => sm.id === subMaskId);
        if (!subMask || subMask.parameters.depthProvider !== 'marigold') return;
        current.patchesSentToBackend.delete(subMaskId);
        updateSubMask(subMaskId, { parameters: { ...subMask.parameters, ...generated } });
      } catch (error) {
        toast.error(`Depth analysis failed: ${error}`);
      } finally {
        pendingMarigold.delete(subMaskId);
        setEditor({ isGeneratingAiMask: false });
      }
      return;
    }

    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    const geometry = JSON.stringify(getTransformAdjustments(adjustments));
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke<MaskParameters>('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      const current = useEditorStore.getState();
      if (
        !shouldApply() ||
        current.selectedImage !== selectedImage ||
        JSON.stringify(getTransformAdjustments(current.adjustments)) !== geometry
      )
        return;
      const subMask = [...(current.adjustments.masks || []), ...(current.adjustments.aiPatches || [])]
        .flatMap((p: AiPatch | MaskContainer) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      if (!subMask || subMask.parameters.depthProvider === 'marigold') return;
      const mergedParameters = { ...subMask.parameters, ...newParameters, depthProvider: 'builtin' as const };
      delete mergedParameters.depthArtifact;
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Depth Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    registerAiTask(subMaskId, 'foreground');

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke<MaskParameters>(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (newParameters.noResult) toast.error(`AI Foreground Mask Failed: ${newParameters.noResult}`);
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Foreground Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    registerAiTask(subMaskId, 'sky');

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke<MaskParameters>(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (newParameters.noResult) toast.error(`AI Sky Mask Failed: ${newParameters.noResult}`);
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Sky Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  const handleGenerateAiTextMask = async (subMaskId: string, prompt: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || !prompt.trim()) return;
    registerAiTask(subMaskId, 'text');

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiTextMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        prompt: prompt.trim(),
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      const subMask =
        adjustments.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        adjustments.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Text Mask Failed: ${noResult}`);
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Text Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  const handleGenerateAiFaceMask = async (subMaskId: string, parts: Array<string>) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path || parts.length === 0) return;
    registerAiTask(subMaskId, 'face');

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const { noResult, ...newParameters } = await invoke<Record<string, unknown>>(Invokes.GenerateAiFaceMask, {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        parts,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
        taskId: subMaskId,
      });

      const latest = useEditorStore.getState().adjustments;
      const subMask =
        latest.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === subMaskId) ||
        latest.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === subMaskId);
      if (subMask?.parameters?.parts?.join() !== parts.join()) return;

      const mergedParameters = { ...subMask.parameters, ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
      if (noResult) toast.error(`AI Face Mask Failed: ${noResult}`);
    } catch (error) {
      if (!String(error).includes('cancelled')) {
        toast.error(`AI Face Mask Failed: ${error}`);
      }
    } finally {
      unregisterAiTask(subMaskId);
    }
  };

  useEffect(() => {
    const { activeMaskId, activeAiSubMaskId, adjustments, selectedImage } = useEditorStore.getState();
    const activeSubMask =
      adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === activeMaskId) ||
      adjustments?.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === activeAiSubMaskId);

    if (activeSubMask?.type === 'ai-subject' && selectedImage?.path) {
      const transformAdjustments = getSubjectInferenceAdjustments(adjustments);
      invoke('precompute_ai_subject_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
      }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
    }
  }, [
    useEditorStore.getState().activeMaskId,
    useEditorStore.getState().activeAiSubMaskId,
    useEditorStore.getState().selectedImage?.path,
  ]);

  return {
    updateSubMask,
    handleGenerativeReplace,
    handleDirectPatch,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiDepthMask,
    handleGenerateSurfaceMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleGenerateAiTextMask,
    handleGenerateAiFaceMask,
    handleCancelAiTask,
  };
}
