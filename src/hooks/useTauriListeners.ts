import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { CullingSuggestions, ImageFile, Invokes, Progress, WaveformData } from '../components/ui/AppProperties';
import { Status } from '../components/ui/ExportImportProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { AiJobsStatus, ExternalEditSession, JobKind, JobStatus, useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import { MaskContainer } from '../utils/adjustments';
import { tracePreview } from '../utils/previewDiagnostics';
import { acceptMainPreviewAttempt } from '../utils/previewIntent';

const parseAnalyticsPacket = async (buffer: ArrayBuffer) => {
  const view = new DataView(buffer);
  let offset = 0;
  const readU32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  let identity: { generation: number; inputRevision?: number; renderAttempt?: number } | null = null;
  if (view.getUint32(0, true) === 0x32415252) {
    offset = 4;
    const length = readU32();
    identity = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, offset, length)));
    offset += length;
  }
  const pathLength = readU32();
  const path = new TextDecoder().decode(new Uint8Array(buffer, offset, pathLength));
  offset += pathLength;

  const bins = readU32();
  let histogram: { red: number[]; green: number[]; blue: number[]; luma: number[] } | null = null;
  if (bins > 0) {
    const readChannel = () => {
      const channel = new Array<number>(bins);
      for (let i = 0; i < bins; i++) {
        channel[i] = view.getFloat32(offset, true);
        offset += 4;
      }
      return channel;
    };
    histogram = { red: readChannel(), green: readChannel(), blue: readChannel(), luma: readChannel() };
  }

  const width = readU32();
  const height = readU32();
  let waveform: WaveformData | null = null;
  if (width > 0 && height > 0) {
    const readPlane = () => {
      const length = readU32();
      const plane = new Uint8ClampedArray(buffer, offset, length);
      offset += length;
      return length === width * height * 4 ? createImageBitmap(new ImageData(plane, width, height)) : null;
    };
    const [rgb, luma, parade, vectorscope] = await Promise.all([readPlane(), readPlane(), readPlane(), readPlane()]);
    waveform = { width, height, rgb, luma, parade, vectorscope };
  }

  return { path, histogram, waveform, identity };
};

interface TauriListenerProps {
  refreshAllFolderTrees: () => void;
  handleSelectSubfolder: (
    path: string,
    isNewRoot?: boolean,
    preloadedImages?: ImageFile[],
    expandParents?: boolean,
  ) => void;
  refreshImageList: () => void;
  markGenerated: (path: string) => void;
  shouldAcceptGenerated: (path: string, sourceRevision?: string | null) => boolean;
  retryStaleGenerated: (path: string) => void;
}

export function useTauriListeners({
  refreshAllFolderTrees,
  handleSelectSubfolder,
  refreshImageList,
  markGenerated,
  shouldAcceptGenerated,
  retryStaleGenerated,
}: TauriListenerProps) {
  const refs = useRef({
    refreshAllFolderTrees,
    handleSelectSubfolder,
    refreshImageList,
    markGenerated,
    shouldAcceptGenerated,
    retryStaleGenerated,
  });

  useEffect(() => {
    refs.current = {
      refreshAllFolderTrees,
      handleSelectSubfolder,
      refreshImageList,
      markGenerated,
      shouldAcceptGenerated,
      retryStaleGenerated,
    };
  });

  const thumbnailBuffer = useRef<Record<string, string>>({});
  const mediumThumbnailBuffer = useRef<Record<string, string>>({});
  const thumbnailRevisionBuffer = useRef<Record<string, string | null>>({});
  const ratingBuffer = useRef<Record<string, number>>({});
  const editStatusBuffer = useRef<Record<string, boolean>>({});
  const metadataBuffer = useRef<
    Record<
      string,
      { flag: import('../components/ui/AppProperties').ImageFlag; tags: string[] | null; needs_ai: boolean }
    >
  >({});
  const progressBuffer = useRef<{ current: number; total: number } | null>(null);
  const flushHandle = useRef<number | null>(null);

  useEffect(() => {
    let isEffectActive = true;
    let aiTaggingJobId: string | null = null;
    const modelDownloadJobIds: Record<string, string> = {};

    const flushThumbnailBatch = () => {
      flushHandle.current = null;
      if (!isEffectActive) return;

      const pendingThumbs = thumbnailBuffer.current;
      const pendingMediumThumbs = mediumThumbnailBuffer.current;
      const pendingRevisions = thumbnailRevisionBuffer.current;
      const pendingRatings = ratingBuffer.current;
      const pendingEdits = editStatusBuffer.current;
      const pendingMetadata = metadataBuffer.current;

      thumbnailBuffer.current = {};
      mediumThumbnailBuffer.current = {};
      thumbnailRevisionBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};
      metadataBuffer.current = {};
      progressBuffer.current = null;

      for (const path of Object.keys(pendingThumbs)) {
        if (!refs.current.shouldAcceptGenerated(path, pendingRevisions[path])) {
          delete pendingThumbs[path];
          delete pendingMediumThumbs[path];
          delete pendingRevisions[path];
          delete pendingRatings[path];
          delete pendingEdits[path];
          refs.current.retryStaleGenerated(path);
        }
      }

      if (Object.keys(pendingThumbs).length > 0) {
        useProcessStore.getState().setProcess((state) => ({
          thumbnails: { ...state.thumbnails, ...pendingThumbs },
          mediumThumbnails: { ...state.mediumThumbnails, ...pendingMediumThumbs },
          thumbnailSourceRevisions: { ...state.thumbnailSourceRevisions, ...pendingRevisions },
        }));
      }

      const ratingPaths = Object.keys(pendingRatings);
      const editPaths = Object.keys(pendingEdits);
      const metadataPaths = Object.keys(pendingMetadata);
      if (ratingPaths.length === 0 && editPaths.length === 0 && metadataPaths.length === 0) return;

      const libraryState = useLibraryStore.getState();

      let nextRatings: Record<string, number> | null = null;
      for (const path of ratingPaths) {
        const rating = pendingRatings[path];
        if (libraryState.imageRatings[path] !== rating || !(path in libraryState.imageRatings)) {
          if (!nextRatings) nextRatings = { ...libraryState.imageRatings };
          nextRatings[path] = rating;
        }
      }

      let nextImageList: typeof libraryState.imageList | null = null;
      if (editPaths.length > 0 || metadataPaths.length > 0) {
        const list = libraryState.imageList;
        for (let i = 0; i < list.length; i++) {
          const img = list[i];
          const hasEdit = img.path in pendingEdits;
          const meta = pendingMetadata[img.path];
          if (!hasEdit && !meta) continue;
          const isEdited = hasEdit ? pendingEdits[img.path] : img.is_edited;
          const flag = meta ? meta.flag : img.flag;
          const tags = meta ? (meta.tags ?? img.tags) : img.tags;
          const needsAi = meta ? meta.needs_ai : img.needs_ai;
          if (isEdited === img.is_edited && flag === img.flag && tags === img.tags && needsAi === img.needs_ai)
            continue;
          if (!nextImageList) nextImageList = list.slice();
          nextImageList[i] = meta
            ? { ...img, flag, is_edited: isEdited, tags, needs_ai: needsAi }
            : { ...img, is_edited: isEdited };
        }
      }

      if (nextRatings || nextImageList) {
        const update: Partial<typeof libraryState> = {};
        if (nextRatings) update.imageRatings = nextRatings;
        if (nextImageList) update.imageList = nextImageList;
        libraryState.setLibrary(update);
      }
    };

    const scheduleFlush = () => {
      if (flushHandle.current !== null) return;
      flushHandle.current = requestAnimationFrame(flushThumbnailBatch);
    };

    const listeners = [
      listen<string>('preview-update-uncropped', (event) => {
        if (isEffectActive) useEditorStore.getState().setEditor({ uncroppedAdjustedPreviewUrl: event.payload });
      }),
      listen<{ name: string; current: number; total: number }>('ai-model-download-progress', (event) => {
        const { name, current, total } = event.payload;
        const jobId = modelDownloadJobIds[name];
        if (isEffectActive && jobId) useProcessStore.getState().updateJob(jobId, { progress: { current, total } });
      }),
      listen('indexing-cancelled', () => {
        if (isEffectActive && aiTaggingJobId) useProcessStore.getState().removeJob(aiTaggingJobId);
        aiTaggingJobId = null;
      }),
      listen<{ path: string; progress: number }>('ai-denoise-progress', (event) => {
        if (!isEffectActive) return;
        const { path, progress } = event.payload;
        useEditorStore
          .getState()
          .setEditor((state) => ({ aiDenoiseProgress: { ...state.aiDenoiseProgress, [path]: progress } }));
      }),
      listen<string>('ai-denoise-ready', (event) => {
        if (!isEffectActive) return;
        useEditorStore.getState().setEditor((state) => {
          const { [event.payload]: _, ...aiDenoiseProgress } = state.aiDenoiseProgress;
          return {
            aiDenoiseProgress,
            ...(state.selectedImage?.path === event.payload ? { adjustments: { ...state.adjustments } } : {}),
          };
        });
      }),
      listen<{ path: string; error: string }>('ai-denoise-error', (event) => {
        if (!isEffectActive) return;
        const { path, error } = event.payload;
        toast.error(`AI denoise failed: ${error}`);
        useEditorStore.getState().setEditor((state) => {
          const { [path]: _, ...aiDenoiseProgress } = state.aiDenoiseProgress;
          return {
            aiDenoiseProgress,
            ...(state.selectedImage?.path === path
              ? { adjustments: { ...state.adjustments, aiDenoiseEnabled: false } }
              : {}),
          };
        });
      }),
      listen<AiJobsStatus>('ai-jobs-status', (event) => {
        if (!isEffectActive) return;
        const { aiJobs, setProcess } = useProcessStore.getState();
        const selectedPath = useEditorStore.getState().selectedImage?.path;
        event.payload.failed
          .filter((job) => job.path === selectedPath && !aiJobs.failed.some((prev) => prev.path === job.path))
          .forEach((job) => toast.error(`AI Processing Failed: ${job.error}`));
        setProcess({ aiJobs: event.payload });
      }),
      listen<{ added: string[]; removed: string[]; resolved: boolean }>('ai-jobs-pending', (event) => {
        if (!isEffectActive) return;
        const { added, removed, resolved } = event.payload;
        useProcessStore.getState().setProcess((state) => {
          const aiPendingPaths = { ...state.aiPendingPaths };
          added.forEach((path) => (aiPendingPaths[path] = true));
          removed.forEach((path) => delete aiPendingPaths[path]);
          return { aiPendingPaths };
        });

        const removedPaths = new Set(removed);
        const { imageList, setLibrary } = useLibraryStore.getState();
        if (imageList.some((img) => removedPaths.has(img.path) && img.needs_ai === resolved)) {
          setLibrary({
            imageList: imageList.map((img) => (removedPaths.has(img.path) ? { ...img, needs_ai: !resolved } : img)),
          });
        }
      }),
      listen<{
        path: string;
        subMasks: Record<string, Partial<import('../components/panel/right/Masks').MaskParameters>>;
        maps: Record<string, string>;
        noResults: string[];
      }>('ai-job-result', (event) => {
        const { path, subMasks, maps, noResults } = event.payload;
        const { selectedImage, patchesSentToBackend, setEditor } = useEditorStore.getState();
        if (!isEffectActive || selectedImage?.path !== path) return;

        noResults.forEach((noResult) => toast.error(`AI Mask: ${noResult}`));
        Object.keys(subMasks).forEach((id) => patchesSentToBackend.delete(id));
        setEditor((state) => ({
          adjustments: {
            ...state.adjustments,
            ...maps,
            masks: state.adjustments.masks?.map((container: MaskContainer) => ({
              ...container,
              subMasks: container.subMasks.map((subMask) =>
                subMasks[subMask.id]
                  ? { ...subMask, parameters: { ...subMask.parameters, ...subMasks[subMask.id] } }
                  : subMask,
              ),
            })),
          },
        }));
      }),

      listen<
        {
          path: string;
          generation: number;
          inputRevision: number | null;
          renderAttempt: number | null;
          qualityTier: string | null;
        } & Pick<Partial<ReturnType<typeof useEditorStore.getState>>, 'histogram' | 'waveform'>
      >('analytics-update', (event) => {
        if (
          isEffectActive &&
          event.payload.path === useEditorStore.getState().selectedImage?.path &&
          event.payload.generation === useEditorStore.getState().backendGeneration &&
          acceptMainPreviewAttempt(event.payload.inputRevision, event.payload.renderAttempt)
        ) {
          tracePreview({
            stage: 'analytics-accepted',
            session: useEditorStore.getState().imageSession,
            generation: event.payload.generation,
            revision: event.payload.inputRevision!,
            attempt: event.payload.renderAttempt!,
            tier:
              event.payload.qualityTier === 'quick' ||
              event.payload.qualityTier === 'detail' ||
              event.payload.qualityTier === 'full'
                ? event.payload.qualityTier
                : 'unknown',
          });
          const update: Pick<Partial<ReturnType<typeof useEditorStore.getState>>, 'histogram' | 'waveform'> = {};
          if (event.payload.histogram != null) update.histogram = event.payload.histogram;
          if (event.payload.waveform != null) update.waveform = event.payload.waveform;
          useEditorStore.getState().setEditor(update);
        }
      }),
      listen<string>('open-with-file', (event) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ initialFileToOpen: event.payload as string });
      }),
      listen<ExternalEditSession>('external-edit-session', (event) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ externalEditSession: event.payload });
      }),
      listen<Progress>('thumbnail-progress', (event) => {
        if (isEffectActive)
          useProcessStore
            .getState()
            .setProcess({ thumbnailProgress: { current: event.payload.current, total: event.payload.total } });
      }),
      listen('thumbnail-generation-complete', () => {
        if (!isEffectActive) return;
        progressBuffer.current = null;
        useProcessStore.getState().setProcess({ thumbnailProgress: { current: 0, total: 0 } });
      }),
      listen<{
        path: string;
        thumbnailPath?: string;
        previewPath?: string;
        rating?: number;
        is_edited?: boolean;
        data?: string;
        sourceRevision?: string;
      }>('thumbnail-generated', (event) => {
        if (!isEffectActive) return;
        const { path, thumbnailPath, previewPath, rating, is_edited, data, sourceRevision } = event.payload;
        if (!refs.current.shouldAcceptGenerated(path, sourceRevision)) {
          if (thumbnailPath || data) refs.current.retryStaleGenerated(path);
          return;
        }

        if (thumbnailPath && previewPath) {
          thumbnailBuffer.current[path] = convertFileSrc(thumbnailPath.replace(/\\/g, '/'));
          mediumThumbnailBuffer.current[path] = convertFileSrc(previewPath.replace(/\\/g, '/'));
          thumbnailRevisionBuffer.current[path] = sourceRevision ?? null;
          refs.current.markGenerated(path);
        } else if (data) {
          thumbnailBuffer.current[path] = data;
          mediumThumbnailBuffer.current[path] = data;
          thumbnailRevisionBuffer.current[path] = sourceRevision ?? null;
          refs.current.markGenerated(path);
        }
        if (rating !== undefined) {
          ratingBuffer.current[path] = rating;
        }
        if (is_edited !== undefined) {
          editStatusBuffer.current[path] = is_edited;
        }
        if (thumbnailPath || data || rating !== undefined || is_edited !== undefined) {
          scheduleFlush();
        }
      }),
      listen<{ path: string; rating: number; is_edited: boolean; tags: string[] | null }>(
        'image-metadata-loaded',
        (event) => {
          if (!isEffectActive) return;
          const { path, rating, is_edited, tags } = event.payload;

          useLibraryStore.getState().setLibrary((state) => ({
            imageRatings: { ...state.imageRatings, [path]: rating },
            imageList: state.imageList.map((img) =>
              img.path === path ? { ...img, is_edited, tags: tags ?? img.tags } : img,
            ),
          }));
        },
      ),
      listen<string>('ai-model-download-start', (event) => {
        if (isEffectActive)
          modelDownloadJobIds[event.payload] = useProcessStore
            .getState()
            .startJob(JobKind.ModelDownload, { detail: event.payload });
      }),
      listen<{ name: string; error: string | null }>('ai-model-download-finish', (event) => {
        if (!isEffectActive) return;
        const { name, error } = event.payload;
        const jobId = modelDownloadJobIds[name];
        delete modelDownloadJobIds[name];
        if (jobId)
          useProcessStore
            .getState()
            .updateJob(jobId, error ? { status: JobStatus.Error, error } : { status: JobStatus.Success });
      }),
      listen<Progress>('indexing-started', (event) => {
        if (!isEffectActive) return;
        const { removeJob, startJob } = useProcessStore.getState();
        if (aiTaggingJobId) removeJob(aiTaggingJobId);
        aiTaggingJobId = startJob(JobKind.AiTagging, { progress: event.payload });
      }),
      listen<Progress>('indexing-progress', (event) => {
        if (isEffectActive && aiTaggingJobId)
          useProcessStore.getState().updateJob(aiTaggingJobId, { progress: event.payload });
      }),
      listen('indexing-finished', () => {
        if (isEffectActive) {
          if (aiTaggingJobId) useProcessStore.getState().updateJob(aiTaggingJobId, { status: JobStatus.Success });
          aiTaggingJobId = null;
          const currentPath = useLibraryStore.getState().currentFolderPath;
          if (currentPath) {
            refs.current.refreshImageList();
          }
        }
      }),
      listen<Progress>('batch-export-progress', (event) => {
        if (isEffectActive) useProcessStore.getState().setExportState({ progress: event.payload });
      }),
      listen('export-complete', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Success });
      }),
      listen<unknown>('export-error', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setExportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen('export-cancelling', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelling });
      }),
      listen('export-cancelled', () => {
        if (isEffectActive) useProcessStore.getState().setExportState({ status: Status.Cancelled });
      }),
      listen<{ total: number }>('import-start', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            errorMessage: '',
            path: '',
            progress: { current: 0, total: event.payload.total },
            status: Status.Importing,
          });
      }),
      listen<Progress & { path: string }>('import-progress', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            path: event.payload.path,
            progress: { current: event.payload.current, total: event.payload.total },
          });
      }),
      listen('import-complete', () => {
        if (isEffectActive) {
          useProcessStore.getState().setImportState({ status: Status.Success });
          refs.current.refreshAllFolderTrees();
          const currentPath = useLibraryStore.getState().currentFolderPath;
          if (currentPath) {
            refs.current.handleSelectSubfolder(currentPath, false);
          }
        }
      }),
      listen<unknown>('import-error', (event) => {
        if (isEffectActive)
          useProcessStore.getState().setImportState({
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'Unknown error',
          });
      }),
      listen<string>('denoise-progress', (event) => {
        if (isEffectActive)
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: { ...state.denoiseModalState, progressMessage: event.payload as string },
          }));
      }),
      listen<string | { denoised: string; original: string }>('denoise-complete', (event) => {
        if (isEffectActive) {
          const payload = event.payload;
          const isObject = typeof payload === 'object' && payload !== null;
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: {
              ...state.denoiseModalState,
              isProcessing: false,
              previewBase64: isObject ? payload.denoised : payload,
              originalBase64: isObject ? payload.original : null,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<unknown>('denoise-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            denoiseModalState: {
              ...state.denoiseModalState,
              isProcessing: false,
              error: String(event.payload),
              progressMessage: null,
            },
          }));
        }
      }),
      listen('viewer-closed', () => {
        if (isEffectActive) {
          useUIStore.getState().setUI({ isViewerOpen: false });
        }
      }),
      listen<{
        path: string;
        generation: number;
        inputRevision: number | null;
        renderAttempt: number | null;
        qualityTier: string | null;
      }>('wgpu-frame-ready', (event) => {
        if (
          isEffectActive &&
          event.payload?.path === useEditorStore.getState().selectedImage?.path &&
          event.payload.generation === useEditorStore.getState().backendGeneration &&
          acceptMainPreviewAttempt(event.payload.inputRevision, event.payload.renderAttempt)
        ) {
          tracePreview({
            stage: 'wgpu-frame-ready',
            session: useEditorStore.getState().imageSession,
            generation: event.payload.generation,
            revision: event.payload.inputRevision!,
            attempt: event.payload.renderAttempt!,
            tier:
              event.payload.qualityTier === 'quick' ||
              event.payload.qualityTier === 'detail' ||
              event.payload.qualityTier === 'full'
                ? event.payload.qualityTier
                : 'unknown',
          });
          useEditorStore.getState().setEditor({ hasRenderedFirstFrame: true });
        }
      }),
      listen<string>('panorama-progress', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.panoramaModalState.finalImageBase64 || state.panoramaModalState.error) return state;
            return { panoramaModalState: { ...state.panoramaModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen<{ base64: string }>('panorama-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            panoramaModalState: {
              ...state.panoramaModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<unknown>('panorama-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            panoramaModalState: {
              ...state.panoramaModalState,
              error: String(event.payload),
              finalImageBase64: null,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<string>('hdr-progress', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: null,
              finalImageBase64: null,
              isOpen: true,
              progressMessage: event.payload,
            },
          }));
        }
      }),
      listen<{ base64: string }>('hdr-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              isProcessing: false,
              progressMessage: 'Hdr Ready',
            },
          }));
        }
      }),
      listen<unknown>('hdr-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            hdrModalState: {
              ...state.hdrModalState,
              error: String(event.payload),
              finalImageBase64: null,
              isProcessing: false,
              progressMessage: 'An error occurred.',
            },
          }));
        }
      }),
      listen<string>('focus-stack-progress', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => {
            if (state.focusStackModalState.finalImageBase64 || state.focusStackModalState.error) return state;
            return { focusStackModalState: { ...state.focusStackModalState, progressMessage: event.payload } };
          });
        }
      }),
      listen<{ base64: string; depthMap: string }>('focus-stack-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            focusStackModalState: {
              ...state.focusStackModalState,
              error: null,
              finalImageBase64: event.payload.base64,
              depthMapBase64: event.payload.depthMap,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<unknown>('focus-stack-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            focusStackModalState: {
              ...state.focusStackModalState,
              error: String(event.payload),
              finalImageBase64: null,
              depthMapBase64: null,
              isProcessing: false,
              progressMessage: null,
            },
          }));
        }
      }),
      listen<number>('culling-start', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: {
              ...state.cullingModalState,
              isOpen: true,
              progress: { current: 0, total: event.payload, stage: 'Initializing...' },
              suggestions: null,
              error: null,
            },
          }));
        }
      }),
      listen<NonNullable<ReturnType<typeof useUIStore.getState>['cullingModalState']['progress']>>(
        'culling-progress',
        (event) => {
          if (isEffectActive) {
            useUIStore
              .getState()
              .setUI((state) => ({ cullingModalState: { ...state.cullingModalState, progress: event.payload } }));
          }
        },
      ),
      listen<CullingSuggestions>('culling-complete', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: { ...state.cullingModalState, progress: null, suggestions: event.payload },
          }));
        }
      }),
      listen<unknown>('culling-error', (event) => {
        if (isEffectActive) {
          useUIStore.getState().setUI((state) => ({
            cullingModalState: { ...state.cullingModalState, progress: null, error: String(event.payload) },
          }));
        }
      }),
    ];

    invoke<AiJobsStatus>(Invokes.GetAiJobsStatus)
      .then((aiJobs) => {
        if (isEffectActive) useProcessStore.getState().setProcess({ aiJobs });
      })
      .catch((err) => console.error('Failed to load AI job status:', err));
    let analyticsSequence = 0;
    let latestAppliedAnalytics = 0;
    const analyticsChannel = new Channel<ArrayBuffer>();
    analyticsChannel.onmessage = async (buffer) => {
      const sequence = ++analyticsSequence;
      const { path, histogram, waveform, identity } = await parseAnalyticsPacket(buffer);
      const current = useEditorStore.getState();
      if (
        !isEffectActive ||
        sequence < latestAppliedAnalytics ||
        path !== current.selectedImage?.path ||
        !identity ||
        identity.generation !== current.backendGeneration ||
        !acceptMainPreviewAttempt(identity.inputRevision ?? null, identity.renderAttempt ?? null)
      ) {
        if (waveform)
          [waveform.rgb, waveform.luma, waveform.parade, waveform.vectorscope].forEach((plane) => plane?.close());
        return;
      }
      latestAppliedAnalytics = sequence;
      const update: { histogram?: import('../components/adjustments/Curves').ChannelConfig; waveform?: WaveformData } =
        {};
      if (histogram) update.histogram = histogram;
      if (waveform) update.waveform = waveform;
      useEditorStore.getState().setEditor(update);
    };
    invoke(Invokes.SubscribeAnalytics, { channel: analyticsChannel }).catch((err) =>
      console.error('Failed to subscribe to analytics:', err),
    );

    invoke<string[]>(Invokes.GetPendingAiPaths)
      .then((paths) => {
        if (isEffectActive) {
          useProcessStore
            .getState()
            .setProcess({ aiPendingPaths: Object.fromEntries(paths.map((path) => [path, true as const])) });
        }
      })
      .catch((err) => console.error('Failed to load pending AI jobs:', err));

    return () => {
      isEffectActive = false;
      if (flushHandle.current !== null) {
        cancelAnimationFrame(flushHandle.current);
        flushHandle.current = null;
      }
      thumbnailBuffer.current = {};
      mediumThumbnailBuffer.current = {};
      thumbnailRevisionBuffer.current = {};
      ratingBuffer.current = {};
      editStatusBuffer.current = {};
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);
}
