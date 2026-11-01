import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
export const clearLibrarySelection = () => {
  useLibraryStore.getState().setLibrary({
    multiSelectedPaths: [],
    libraryActivePath: null,
    selectionAnchorPath: null,
  });

  useEditorStore.getState().setEditor({
    selectedImage: null,
    finalPreviewUrl: null,
    uncroppedAdjustedPreviewUrl: null,
    histogram: null,
    waveform: null,
    activeMaskId: null,
    activeMaskContainerId: null,
    activeAiPatchContainerId: null,
    activeAiSubMaskId: null,
    isWbPickerActive: false,
    isRelightPickerActive: false,
    activeRelightLightId: null,
    activeCenterMarker: null,
  });
};
