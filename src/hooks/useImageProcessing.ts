import React, { useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import throttle from 'lodash.throttle';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { Adjustments, COPYABLE_ADJUSTMENT_KEYS, copyAdjustmentKeys } from '../utils/adjustments';
import { Invokes, Panel } from '../components/ui/AppProperties';
import { debouncedSave } from './useEditorActions';
import { globalImageCache } from '../utils/ImageLRUCache';

import type { AppNavigationProps } from './useAppNavigation';
import { PreviewPipeline, preparePreviewAdjustments, interactivePreviewResolution } from '../utils/previewPipeline';

export function useImageProcessing(
  transformWrapperRef: AppNavigationProps['refs']['transformWrapperRef'],
  prevAdjustmentsRef: AppNavigationProps['refs']['prevAdjustmentsRef'],
  renderRefs: {
    previewJobIdRef: React.RefObject<number>;
    latestRenderedJobIdRef: React.RefObject<number>;
    currentResRef: React.RefObject<number>;
  },
) {
  const { previewJobIdRef, latestRenderedJobIdRef, currentResRef } = renderRefs;

  const selectedImage = useEditorStore((state) => state.selectedImage);
  const adjustments = useEditorStore((state) => state.adjustments);
  const previewOverride = useEditorStore((state) => state.previewOverride);
  const isWaveformVisible = useEditorStore((state) => state.isWaveformVisible);
  const activeWaveformChannel = useEditorStore((state) => state.activeWaveformChannel);
  const displaySize = useEditorStore((state) => state.displaySize);
  const baseRenderSize = useEditorStore((state) => state.baseRenderSize);
  const originalSize = useEditorStore((state) => state.originalSize);
  const isSliderDragging = useEditorStore((state) => state.isSliderDragging);
  const setEditor = useEditorStore((state) => state.setEditor);

  const activeView = useUIStore((state) => state.activeView);
  const activePanel = useUIStore((state) => state.activePanel);
  const appSettings = useSettingsStore((state) => state.appSettings);
  const multiSelectedPaths = useLibraryStore((state) => state.multiSelectedPaths);

  const uncroppedJobIdRef = useRef(0);
  const latestUncroppedJobIdRef = useRef(0);

  const lastAnalyticsTimeRef = useRef<number>(0);
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWaveformChannelRef = useRef(activeWaveformChannel);
  activeWaveformChannelRef.current = activeWaveformChannel;

  const selectedImagePathRef = useRef<string | null>(null);
  const imageGenerationRef = useRef(0);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
    imageGenerationRef.current += 1;
    pipelineRef.current?.clear();
  }, [selectedImage?.path]);

  const calculateROI = useCallback(() => {
    if (!transformWrapperRef.current) return null;
    const state = transformWrapperRef.current.instance.transformState;
    if (!state) return null;

    if (!baseRenderSize) return null;

    const { scale, positionX, positionY } = state;
    const { width: baseW, height: baseH, offsetX, offsetY, containerWidth, containerHeight } = baseRenderSize;

    if (!baseW || !baseH || !containerWidth || !containerHeight) return null;
    if (scale <= 1.01) return null;

    const paddingPixels = 2.0;
    const paddingX = paddingPixels / baseW;
    const paddingY = paddingPixels / baseH;

    const visibleLeft = -positionX / scale;
    const visibleTop = -positionY / scale;
    const visibleRight = visibleLeft + containerWidth / scale;
    const visibleBottom = visibleTop + containerHeight / scale;

    const imgLeft = offsetX;
    const imgTop = offsetY;
    const imgRight = offsetX + baseW;
    const imgBottom = offsetY + baseH;

    const intersectLeft = Math.max(visibleLeft, imgLeft);
    const intersectTop = Math.max(visibleTop, imgTop);
    const intersectRight = Math.min(visibleRight, imgRight);
    const intersectBottom = Math.min(visibleBottom, imgBottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      return null;
    }

    const roiX = (intersectLeft - imgLeft) / baseW;
    const roiY = (intersectTop - imgTop) / baseH;
    const roiW = (intersectRight - intersectLeft) / baseW;
    const roiH = (intersectBottom - intersectTop) / baseH;

    const newRoiX = roiX - paddingX;
    const newRoiY = roiY - paddingY;
    const newRoiW = roiW + paddingX * 2;
    const newRoiH = roiH + paddingY * 2;

    const clampedX = Math.max(0, newRoiX);
    const clampedY = Math.max(0, newRoiY);
    const clampedW = Math.min(1 - clampedX, newRoiW);
    const clampedH = Math.min(1 - clampedY, newRoiH);

    if (clampedW > 0.999 && clampedH > 0.999) return null;

    return [clampedX, clampedY, clampedW, clampedH] as [number, number, number, number];
  }, [baseRenderSize, transformWrapperRef]);

  const executeApplyAdjustments = useCallback(
    async (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      const currentPath = selectedImage?.path;
      if (!currentPath) return;
      const generation = imageGenerationRef.current;

      let shouldRequestAnalytics = false;
      if (dragging) {
        const now = performance.now();
        if (now - lastAnalyticsTimeRef.current > 100) {
          shouldRequestAnalytics = true;
          lastAnalyticsTimeRef.current = now;
        }
      } else {
        shouldRequestAnalytics = true;
        lastAnalyticsTimeRef.current = 0;
      }

      const { patchesSentToBackend } = useEditorStore.getState();
      const { payload, sentAssets } = preparePreviewAdjustments(currentAdjustments, patchesSentToBackend);

      const jobId = ++previewJobIdRef.current;
      const roi = calculateROI();

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: dragging,
          targetResolution: targetRes || null,
          roi: roi || null,
          requestAnalytics: shouldRequestAnalytics,
          computeWaveform: !!isWaveformVisible,
          activeWaveformChannel: activeWaveformChannelRef.current || null,
        });

        if (currentPath !== selectedImagePathRef.current || generation !== imageGenerationRef.current) return;
        sentAssets.forEach((id) => patchesSentToBackend.add(id));

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          latestRenderedJobIdRef.current = jobId;

          const textDecoder = new TextDecoder();
          const prefix = textDecoder.decode(buffer.slice(0, 11));
          if (prefix === 'WGPU_RENDER') {
            setEditor((state) => {
              if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
              return { interactivePatch: null };
            });
            return;
          }

          if (dragging) {
            const view = new DataView(buffer);
            const patchX = view.getUint32(0, true);
            const patchY = view.getUint32(4, true);
            const patchW = view.getUint32(8, true);
            const patchH = view.getUint32(12, true);
            const fullW = view.getUint32(16, true);
            const fullH = view.getUint32(20, true);

            const imageBuffer = buffer.slice(24);
            const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            setEditor((state) => {
              const previousPatchUrl = state.interactivePatch?.url;
              if (previousPatchUrl) setTimeout(() => URL.revokeObjectURL(previousPatchUrl), 100);
              return {
                interactivePatch: {
                  url,
                  normX: patchX / fullW,
                  normY: patchY / fullH,
                  normW: patchW / fullW,
                  normH: patchH / fullH,
                },
              };
            });
          } else {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            if (currentPath !== selectedImagePathRef.current || jobId < latestRenderedJobIdRef.current) {
              URL.revokeObjectURL(url);
              return;
            }

            setEditor((state) => {
              const prevUrl = state.finalPreviewUrl;
              if (prevUrl && prevUrl.startsWith('blob:') && !globalImageCache.isProtected(prevUrl)) {
                setTimeout(() => {
                  if (!globalImageCache.isProtected(prevUrl)) {
                    URL.revokeObjectURL(prevUrl);
                  }
                }, 250);
              }
              return { finalPreviewUrl: url };
            });

            setEditor((state) => {
              const previousPatchUrl = state.interactivePatch?.url;
              if (previousPatchUrl) setTimeout(() => URL.revokeObjectURL(previousPatchUrl), 500);
              return { interactivePatch: null };
            });
          }
        }
      } catch (err) {
        if (currentPath !== selectedImagePathRef.current || generation !== imageGenerationRef.current) return;
        if (err !== 'Superseded or worker failed') {
          console.error('Failed to apply adjustments:', err);
        }
        if (!dragging) {
          setEditor((state) => {
            if (state.interactivePatch && state.interactivePatch.url) URL.revokeObjectURL(state.interactivePatch.url);
            return { interactivePatch: null };
          });
        }
      }
    },
    [selectedImage?.path, calculateROI, isWaveformVisible, setEditor, previewJobIdRef, latestRenderedJobIdRef],
  );

  const executeRef = useRef(executeApplyAdjustments);
  executeRef.current = executeApplyAdjustments;
  const pipelineRef = useRef<PreviewPipeline<{
    adjustments: Adjustments;
    dragging: boolean;
    targetRes?: number;
    path: string;
  }> | null>(null);
  if (!pipelineRef.current) {
    pipelineRef.current = new PreviewPipeline(async (request) => {
      const image = useEditorStore.getState().selectedImage;
      if (!image?.isReady || request.path !== image.path) return;
      await executeRef.current(request.adjustments, request.dragging, request.targetRes);
    });
  }

  useEffect(
    () => () => {
      pipelineRef.current?.clear();
      selectedImagePathRef.current = null;
      imageGenerationRef.current += 1;
    },
    [],
  );

  const applyAdjustments = useCallback(
    (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      const image = useEditorStore.getState().selectedImage;
      if (!image?.isReady) return;
      const quality = useSettingsStore.getState().appSettings?.livePreviewQuality;
      pipelineRef.current!.enqueue({
        adjustments: currentAdjustments,
        dragging,
        targetRes: dragging && targetRes ? interactivePreviewResolution(targetRes, quality) : targetRes,
        path: image.path,
      });
    },
    [],
  );

  const throttledUncroppedPreview = useMemo(
    () =>
      throttle(
        (adj: Adjustments) => {
          if (!useEditorStore.getState().selectedImage?.isReady) return;
          const jobId = ++uncroppedJobIdRef.current;
          invoke<string>(Invokes.GenerateUncroppedPreview, { jsAdjustments: adj })
            .then((dataUrl) => {
              if (jobId >= latestUncroppedJobIdRef.current) {
                latestUncroppedJobIdRef.current = jobId;
                useEditorStore.getState().setEditor({ uncroppedAdjustedPreviewUrl: dataUrl });
              }
            })
            .catch(console.error);
        },
        30,
        { leading: true, trailing: true },
      ),
    [],
  );

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      throttledUncroppedPreview(currentAdjustments);
    },
    [throttledUncroppedPreview],
  );

  useEffect(() => {
    if (activeView === 'editor' && activePanel === Panel.Crop && selectedImage?.isReady) {
      generateUncroppedPreview(adjustments);
    }
  }, [activeView, adjustments, activePanel, selectedImage?.isReady, generateUncroppedPreview]);

  const calculateTargetRes = useCallback(() => {
    const baseTargetRes = appSettings?.editorPreviewResolution || 1920;
    if (!(appSettings?.enableZoomHifi ?? true) || displaySize.width === 0) {
      return baseTargetRes;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const sharpnessFactor = 1.25;
    const zoomMultiplier = appSettings?.highResZoomMultiplier || 1.0;
    const effectiveDpr = appSettings?.useFullDpiRendering ? dpr : 1;

    let targetRes = Math.max(displaySize.width, displaySize.height) * effectiveDpr * sharpnessFactor * zoomMultiplier;
    targetRes = Math.max(targetRes, 512);

    if (originalSize && originalSize.width > 0 && originalSize.height > 0) {
      const origMax = Math.max(originalSize.width, originalSize.height);
      targetRes = Math.min(targetRes, origMax);
      if (targetRes >= origMax * 0.8) {
        targetRes = origMax;
      }
    }

    if (originalSize && targetRes !== Math.max(originalSize.width, originalSize.height)) {
      targetRes = Math.ceil(targetRes / 256) * 256;
    }

    return Math.round(targetRes);
  }, [
    appSettings?.enableZoomHifi,
    appSettings?.editorPreviewResolution,
    appSettings?.highResZoomMultiplier,
    appSettings?.useFullDpiRendering,
    displaySize.width,
    displaySize.height,
    originalSize,
  ]);

  const requestHiFiZoom = useMemo(
    () =>
      debounce((targetRes: number) => {
        if (targetRes > currentResRef.current) {
          currentResRef.current = targetRes;
          const { adjustments, previewOverride } = useEditorStore.getState();
          const renderAdjustments = previewOverride ?? adjustments;
          applyAdjustments(renderAdjustments, false, targetRes);
        }
      }, 250),
    [applyAdjustments, currentResRef],
  );

  useEffect(() => {
    if (activeView === 'editor' && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let baseRes = calculateTargetRes();
      if (originalSize.width > 0 && originalSize.height > 0) {
        const maxRes = Math.max(originalSize.width, originalSize.height);
        if (baseRes > maxRes) baseRes = maxRes;
      }
      const finalRes = Math.round(baseRes);

      if (finalRes > currentResRef.current) {
        requestHiFiZoom(finalRes);
      }
    }
    return () => {
      requestHiFiZoom.cancel();
    };
  }, [
    activeView,
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    requestHiFiZoom,
    originalSize,
  ]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);

    const targetRes = calculateTargetRes();
    const renderAdjustments = previewOverride ?? adjustments;

    if (activeView !== 'editor') {
      if (isSliderDragging) return;
    }

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(renderAdjustments, true, targetRes);
      }
    } else {
      currentResRef.current = targetRes;
      applyAdjustments(renderAdjustments, false, targetRes);
      dragIdleTimer.current = setTimeout(() => {
        if (previewOverride) return;

        const prev = prevAdjustmentsRef.current;

        if (!prev || prev.path !== selectedImage.path) {
          prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
          return;
        }

        const hasAdjustmentsChanged = prev.adjustments !== adjustments;

        if (hasAdjustmentsChanged) {
          debouncedSave(selectedImage.path, adjustments);

          const otherPaths = multiSelectedPaths.filter((p) => p !== selectedImage.path);
          if (appSettings?.copyPasteSettings?.autoSync && otherPaths.length > 0) {
            const delta: Partial<Adjustments> = {};
            const includedKeys = appSettings?.copyPasteSettings?.includedAdjustments || COPYABLE_ADJUSTMENT_KEYS;
            for (const key of Object.keys(adjustments) as Array<keyof Adjustments>) {
              if (includedKeys.includes(key as string)) {
                if (JSON.stringify(adjustments[key]) !== JSON.stringify(prev.adjustments[key])) {
                  copyAdjustmentKeys(delta, adjustments, [key]);
                }
              }
            }
            if (Object.keys(delta).length > 0) {
              otherPaths.forEach((p) => globalImageCache.delete(p));
              invoke(Invokes.ApplyAdjustmentsToPaths, { paths: otherPaths, adjustments: delta }).catch((err) => {
                console.error('Failed to apply adjustments to multi-selection:', err);
              });
            }
          }

          prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
        }
      }, 50);
    }

    return () => {
      if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);
    };
  }, [
    activeView,
    adjustments,
    previewOverride,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    multiSelectedPaths,
    appSettings?.enableLivePreviews,
    appSettings?.copyPasteSettings?.includedAdjustments,
    appSettings?.copyPasteSettings?.autoSync,
    isWaveformVisible,
  ]);

  return {
    applyAdjustments,
    executeApplyAdjustments,
  };
}
