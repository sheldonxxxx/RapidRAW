import { create } from 'zustand';
import { ChannelConfig } from '../components/adjustments/Curves';
import { OverlayMode } from '../components/panel/right/CropPanel';
import { ToolType } from '../components/panel/right/Masks';
import { BrushSettings, CompareView, SelectedImage, WaveformData } from '../components/ui/AppProperties';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import {
  Adjustments,
  AdjustmentSection,
  CropGeometry,
  INITIAL_ADJUSTMENTS,
  MaskContainer,
  pickCropGeometry,
} from '../utils/adjustments';
import { describeHistoryChange } from '../utils/editHistory';
import { resetPreviewAssetRevisions } from '../utils/previewPipeline';

export type CenterMarker = 'vignette' | 'centre';

interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

interface EditorState {
  selectedImage: SelectedImage | null;
  imageSession: number;
  backendGeneration: number | null;
  adjustments: Adjustments;
  previewOverride: Adjustments | null;
  history: Adjustments[];
  historyIndex: number;
  finalPreviewUrl: string | null;
  comparisonPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  showClipping: boolean;
  splitCompare: boolean;
  splitComparePosition: number;
  splitComparisonUrl: string | null;
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;
  isSliderDragging: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isWbPickerActive: boolean;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  brushSettings: BrushSettings | null;
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  activeLocalEditKind: 'adjustment' | 'repair' | null;
  isMaskControlHovered: boolean;
  showPatchMarkers: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  patchesSentToBackend: Set<string>;
  copiedSectionAdjustments: { section: AdjustmentSection; values: Partial<Adjustments> } | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Partial<Adjustments> | null;
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments, label?: string) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments) => void;
  goToHistoryIndex: (index: number) => void;
  historyLabels: string[];
  compareView: CompareView;
  splitPosition: number;
  originalPreview: { path: string; url: string | null } | null;
  isAutoStraightening: boolean;
  isRelightPickerActive: boolean;
  activeRelightLightId: string | null;
  activeCenterMarker: CenterMarker | null;
  cropSessionSnapshot: { path: string | null; geometry: CropGeometry } | null;
  aiDenoiseProgress: Record<string, number>;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  history: [INITIAL_ADJUSTMENTS],
  historyLabels: [''],
  historyIndex: 0,
  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  compareView: 'off',
  splitPosition: 0.5,
  originalPreview: null,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,
  isSliderDragging: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,
  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },
  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isAutoStraightening: false,
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeRelightLightId: null,
  activeCenterMarker: null,
  isGuidedPerspectiveActive: false,
  liveRotation: null,
  cropSessionSnapshot: null,
  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 50, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,
  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  isMaskControlHovered: false,
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),
  setEditor: (updater) =>
    set((state) => {
      let next = typeof updater === 'function' ? updater(state) : updater;
      const switchingImage = 'selectedImage' in next && next.selectedImage?.path !== state.selectedImage?.path;
      const leavingComparison = state.showOriginal && next.showOriginal === false;
      const replacingComparison =
        'comparisonPreviewUrl' in next && next.comparisonPreviewUrl !== state.comparisonPreviewUrl;
      if (state.comparisonPreviewUrl && (switchingImage || leavingComparison || replacingComparison)) {
        const oldUrl = state.comparisonPreviewUrl;
        if (oldUrl.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(oldUrl), 500);
      }
      const leavingSplit = state.splitCompare && next.splitCompare === false;
      const replacingSplit = 'splitComparisonUrl' in next && next.splitComparisonUrl !== state.splitComparisonUrl;
      if (state.splitComparisonUrl && (switchingImage || leavingSplit || replacingSplit)) {
        const oldUrl = state.splitComparisonUrl;
        setTimeout(() => URL.revokeObjectURL(oldUrl), 500);
        if (leavingSplit && !replacingSplit) next = { ...next, splitComparisonUrl: null };
      }
      if (switchingImage) {
        resetPreviewAssetRevisions();
        if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
        return {
          finalPreviewUrl: null,
          comparisonPreviewUrl: null,
          splitComparisonUrl: null,
          uncroppedAdjustedPreviewUrl: null,
          histogram: null,
          waveform: null,
          ...next,
          imageSession: state.imageSession + 1,
          backendGeneration: null,
          hasRenderedFirstFrame: false,
          interactivePatch: null,
          isSliderDragging: false,
          patchesSentToBackend: new Set<string>(),
        };
      }
      if (leavingComparison) return { comparisonPreviewUrl: null, ...next };
      return next;
    }),
  pushHistory: (newAdj, label) =>
    set((state) => {
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      const newLabels = state.historyLabels.slice(0, state.historyIndex + 1);
      newLabels.push(label || describeHistoryChange(state.history[state.historyIndex], newAdj));
      newHistory.push(newAdj);
      if (newHistory.length > 50) {
        newHistory.shift();
        newLabels.shift();
      }
      return { history: newHistory, historyLabels: newLabels, historyIndex: newHistory.length - 1 };
    }),
  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return {
          historyIndex: newIndex,
          adjustments: { ...state.history[newIndex], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),
  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return {
          historyIndex: newIndex,
          adjustments: { ...state.history[newIndex], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),
  resetHistory: (initialState) =>
    set((state) => ({
      history: [initialState],
      historyLabels: [''],
      historyIndex: 0,
      adjustments: initialState,
      ...(state.cropSessionSnapshot
        ? {
            cropSessionSnapshot: {
              path: state.selectedImage?.path ?? null,
              geometry: pickCropGeometry(initialState),
            },
          }
        : {}),
    })),
  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        return {
          historyIndex: index,
          adjustments: { ...state.history[index], inpaintHistory: state.adjustments.inpaintHistory },
        };
      }
      return state;
    }),
  imageSession: 0,
  backendGeneration: null,
  comparisonPreviewUrl: null,
  showClipping: false,
  splitCompare: false,
  splitComparePosition: 0.5,
  splitComparisonUrl: null,
  activeLocalEditKind: null,
  showPatchMarkers: true,
}));
