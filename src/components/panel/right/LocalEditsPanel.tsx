import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import { ClipboardPaste, Copy, Eye, EyeOff, FileEdit, Plus, PlusSquare, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { useAuth, useUser } from '@clerk/react';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useAiMasking } from '../../../hooks/useAiMasking';
import { useGenerationCapabilities } from '../../../hooks/useGenerationCapabilities';
import { usePresets } from '../../../hooks/usePresets';
import {
  cloneLocalAdjustment,
  cloneLocalRepair,
  cloneSelectionComponent,
  copyMaskSelectionToRepair,
  copyRepairSelectionToMask,
  isDirectToolPatch,
} from '../../../utils/localEdits';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OPTION_SEPARATOR, type Option } from '../../ui/AppProperties';
import { isSurfaceMask } from '../../../utils/surfaceGeometry';
import {
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  type Adjustments,
  type AiPatch,
  type MaskContainer,
  type SectionVisibility,
} from '../../../utils/adjustments';
import type { AdjustmentSection } from '../../../utils/adjustments';
import type { SubMask } from './Masks';
import {
  Mask,
  MASK_AI_TYPES,
  MASK_BASIC_TYPES,
  MASK_RANGE_TYPES,
  MASK_ICON_MAP,
  SubMaskMode,
  ToolType,
  getSubMaskName,
} from './Masks';
import { createSubMask } from '../../../utils/maskUtils';
import { MaskSettingsPanel } from './MasksPanel';
import { AISettingsPanel, ConnectionStatus } from './AIPanel';

type EditKind = 'adjustment' | 'repair';
const modes: SubMaskMode[] = [SubMaskMode.Additive, SubMaskMode.Subtractive, SubMaskMode.Intersect];

export default function LocalEditsPanel() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const activeLocalEditKind = useEditorStore((s) => s.activeLocalEditKind);
  const activeMaskContainerId = useEditorStore((s) => s.activeMaskContainerId);
  const activeMaskId = useEditorStore((s) => s.activeMaskId);
  const activeAiPatchContainerId = useEditorStore((s) => s.activeAiPatchContainerId);
  const activeAiSubMaskId = useEditorStore((s) => s.activeAiSubMaskId);
  const brushSettings = useEditorStore((s) => s.brushSettings);
  const histogram = useEditorStore((s) => s.histogram);
  const isGeneratingAi = useEditorStore((s) => s.isGeneratingAi);
  const isGeneratingAiMask = useEditorStore((s) => s.isGeneratingAiMask);
  const isAIConnectorConnected = useEditorStore((s) => s.isAIConnectorConnected);
  const showPatchMarkers = useEditorStore((s) => s.showPatchMarkers);
  const setEditor = useEditorStore((s) => s.setEditor);
  const { setAdjustments } = useEditorActions();
  const appSettings = useSettingsStore((s) => s.appSettings);
  const aiModelDownloadStatus = useProcessStore((s) => s.aiModelDownloadStatus);
  const { user, isSignedIn } = useUser();
  const { getToken } = useAuth();
  const isPro = user?.publicMetadata?.plan === 'pro';
  const [cloudUsage, setCloudUsage] = useState<{ requests: number; limit: number; month: string } | null>(null);
  const { presets } = usePresets(adjustments);
  const {
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleGenerateAiDepthMask,
    handleGenerateSurfaceMask,
    handleDirectPatch,
  } = useAiMasking();
  const provider = appSettings?.aiProvider || 'cpu';
  const capabilities = useGenerationCapabilities(
    provider,
    appSettings?.aiConnectorAddress || '',
    isAIConnectorConnected,
  );
  const isGenerativeAvailable =
    (provider === 'cloud' && !!isSignedIn && isPro) || (provider === 'ai-connector' && isAIConnectorConnected);

  useEffect(() => {
    if (provider !== 'cloud' || !isSignedIn || !isPro) return;
    const fetchUsage = async () => {
      try {
        const token = await getToken();
        if (!token) return;
        const response = await fetch('http://127.0.0.1:5000/usage', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) setCloudUsage(await response.json());
      } catch (error) {
        console.error('Failed to fetch cloud usage', error);
      }
    };
    void fetchUsage();
  }, [provider, isSignedIn, isPro, getToken]);

  const [pickerFor, setPickerFor] = useState<EditKind | null>(null);
  const [copiedEdit, setCopiedEdit] = useState<
    { kind: 'adjustment'; entry: MaskContainer } | { kind: 'repair'; entry: AiPatch } | null
  >(null);
  const [copiedComponent, setCopiedComponent] = useState<{ kind: EditKind; part: SubMask } | null>(null);
  const [renaming, setRenaming] = useState<{ kind: EditKind; id: string; component: boolean } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameCancelledRef = useRef(false);
  const [componentMode, setComponentMode] = useState<SubMaskMode>(SubMaskMode.Additive);
  const [showComponentPicker, setShowComponentPicker] = useState(false);
  const [maskSections, setMaskSections] = useState<SectionVisibility>({
    basic: true,
    curves: false,
    color: false,
    details: false,
    effects: false,
  });
  const [aiSections, setAiSections] = useState({ generative: true, properties: true });
  const [copiedSectionAdjustments, setCopiedSectionAdjustments] = useState<{
    section: AdjustmentSection;
    values: Partial<Adjustments>;
  } | null>(null);
  const [isSettingsSectionOpen, setSettingsSectionOpen] = useState(true);

  const repairs = useMemo(
    () => adjustments.aiPatches.filter((patch) => !isDirectToolPatch(patch)),
    [adjustments.aiPatches],
  );
  const selectedMask =
    activeLocalEditKind === 'adjustment'
      ? adjustments.masks.find((mask) => mask.id === activeMaskContainerId)
      : undefined;
  const selectedRepair =
    activeLocalEditKind === 'repair' ? repairs.find((patch) => patch.id === activeAiPatchContainerId) : undefined;
  const selectedSubMask =
    activeLocalEditKind === 'adjustment'
      ? selectedMask?.subMasks.find((part) => part.id === activeMaskId)
      : selectedRepair?.subMasks.find((part) => part.id === activeAiSubMaskId);
  const selectedEdit = selectedMask ?? selectedRepair;
  const repairSelection = selectedRepair
    ? {
        ...INITIAL_MASK_CONTAINER,
        id: selectedRepair.id,
        name: selectedRepair.name,
        invert: selectedRepair.invert,
        visible: selectedRepair.visible,
        subMasks: selectedRepair.subMasks,
        adjustments: INITIAL_MASK_ADJUSTMENTS,
      }
    : null;

  useEffect(() => {
    if (!selectedImage) return;
    if (activeLocalEditKind === 'adjustment' && selectedMask) return;
    if (activeLocalEditKind === 'repair' && selectedRepair) return;
    const first = repairs[0];
    if (first) {
      setEditor({
        activeLocalEditKind: 'repair',
        activeAiPatchContainerId: first.id,
        activeAiSubMaskId: null,
        activeMaskContainerId: null,
        activeMaskId: null,
      });
    } else if (adjustments.masks[0]) {
      setEditor({
        activeLocalEditKind: 'adjustment',
        activeMaskContainerId: adjustments.masks[0].id,
        activeMaskId: null,
        activeAiPatchContainerId: null,
        activeAiSubMaskId: null,
      });
    } else if (activeLocalEditKind) {
      setEditor({
        activeLocalEditKind: null,
        activeMaskContainerId: null,
        activeMaskId: null,
        activeAiPatchContainerId: null,
        activeAiSubMaskId: null,
      });
    }
  }, [selectedImage?.path, activeLocalEditKind, selectedMask, selectedRepair, adjustments.masks, repairs, setEditor]);

  const selectEdit = (kind: EditKind, id: string, subMaskId: string | null = null) => {
    setPickerFor(null);
    setShowComponentPicker(false);
    setEditor(
      kind === 'adjustment'
        ? {
            activeLocalEditKind: kind,
            activeMaskContainerId: id,
            activeMaskId: subMaskId,
            activeAiPatchContainerId: null,
            activeAiSubMaskId: null,
          }
        : {
            activeLocalEditKind: kind,
            activeAiPatchContainerId: id,
            activeAiSubMaskId: subMaskId,
            activeMaskContainerId: null,
            activeMaskId: null,
          },
    );
  };

  const buildSubMask = (type: Mask, mode: SubMaskMode, depthProvider?: 'marigold'): SubMask => {
    const part = createSubMask(type, selectedImage, mode);
    const rotated = (adjustments.orientationSteps ?? 0) % 2 === 1;
    const width = rotated ? (selectedImage?.height ?? 1000) : (selectedImage?.width ?? 1000);
    const height = rotated ? (selectedImage?.width ?? 1000) : (selectedImage?.height ?? 1000);
    if (type === Mask.Linear || type === Mask.Radial) {
      part.parameters = {
        ...part.parameters,
        isInitialDraw: true,
        startX: -10000,
        startY: -10000,
        endX: -10000,
        endY: -10000,
        centerX: -10000,
        centerY: -10000,
        radiusX: 0,
        radiusY: 0,
        range: Math.min(width, height) * 0.1,
      };
    } else if (type === Mask.Color || type === Mask.Luminance) {
      part.parameters = {
        ...part.parameters,
        isInitialDraw: true,
        targetX: -10000,
        targetY: -10000,
        tolerance: 20,
        feather: 35,
      };
    } else if (type === Mask.AiDepth) {
      part.parameters = {
        ...part.parameters,
        depthProvider: depthProvider ?? 'builtin',
        minDepth: 20,
        maxDepth: 80,
        minFade: 15,
        maxFade: 15,
        feather: 10,
      };
      if (depthProvider === 'marigold')
        part.name = t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' });
    } else if (type === Mask.AiNormals) {
      part.parameters = { ...part.parameters, normalAngle: 90, normalAmount: 0.25 };
    }
    return part;
  };

  const startAnalysis = (part: SubMask) => {
    if (part.type === Mask.AiForeground) void handleGenerateAiForegroundMask(part.id);
    else if (part.type === Mask.AiSky) void handleGenerateAiSkyMask(part.id);
    else if (part.type === Mask.AiDepth) void handleGenerateAiDepthMask(part.id, part.parameters);
    else if (part.type === Mask.AiNormals || part.type === Mask.AiAlbedo)
      void handleGenerateSurfaceMask(part.id, part.type === Mask.AiNormals ? 'normals' : 'albedo');
  };

  const addEdit = (kind: EditKind, type: Mask, depthProvider?: 'marigold') => {
    const part = buildSubMask(type, SubMaskMode.Additive, depthProvider);
    if (kind === 'adjustment') {
      const mask: MaskContainer = {
        ...structuredClone(INITIAL_MASK_CONTAINER),
        id: uuidv4(),
        name: t('editor.localEdits.adjustmentName', { count: adjustments.masks.length + 1 }),
        subMasks: [part],
      };
      setAdjustments((previous) => ({ ...previous, masks: [...previous.masks, mask] }));
      selectEdit(kind, mask.id, part.id);
    } else {
      const patch: AiPatch = {
        id: uuidv4(),
        name:
          type === Mask.QuickEraser
            ? t('editor.ai.patches.quickErase', {
                count:
                  repairs.filter((entry) => entry.subMasks.some((part) => part.type === Mask.QuickEraser)).length + 1,
              })
            : t('editor.localEdits.repairName', { count: repairs.length + 1 }),
        invert: false,
        visible: true,
        isLoading: false,
        prompt: '',
        patchData: null,
        subMasks: [part],
      };
      setAdjustments((previous) => ({ ...previous, aiPatches: [...previous.aiPatches, patch] }));
      selectEdit(kind, patch.id, part.id);
    }
    if (type === Mask.Brush || type === Mask.Flow) {
      setEditor((state) => ({
        brushSettings: {
          ...(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }),
          tool: ToolType.Brush,
        },
      }));
    }
    startAnalysis(part);
  };

  const addComponent = (type: Mask, mode = componentMode, depthProvider?: 'marigold') => {
    if (!activeLocalEditKind || !selectedEdit) return;
    if (isSurfaceMask(type) && selectedEdit.subMasks.some((part) => isSurfaceMask(part.type))) return;
    const part = buildSubMask(type, mode, depthProvider);
    if (activeLocalEditKind === 'adjustment') {
      setAdjustments((previous) => ({
        ...previous,
        masks: previous.masks.map((mask) =>
          mask.id === selectedEdit.id ? { ...mask, subMasks: [...mask.subMasks, part] } : mask,
        ),
      }));
    } else {
      setAdjustments((previous) => ({
        ...previous,
        aiPatches: previous.aiPatches.map((patch) =>
          patch.id === selectedEdit.id ? { ...patch, subMasks: [...patch.subMasks, part] } : patch,
        ),
      }));
    }
    selectEdit(activeLocalEditKind, selectedEdit.id, part.id);
    startAnalysis(part);
  };

  const updateSubMask = (id: string, data: Partial<SubMask>) =>
    setAdjustments((previous) => ({
      ...previous,
      masks: previous.masks.map((mask) => ({
        ...mask,
        subMasks: mask.subMasks.map((part) => (part.id === id ? { ...part, ...data } : part)),
      })),
      aiPatches: previous.aiPatches.map((patch) => ({
        ...patch,
        subMasks: patch.subMasks.map((part) => (part.id === id ? { ...part, ...data } : part)),
      })),
    }));
  const updateMask = (id: string, data: Partial<MaskContainer>) =>
    setAdjustments((previous) => ({
      ...previous,
      masks: previous.masks.map((mask) => (mask.id === id ? { ...mask, ...data } : mask)),
    }));
  const updatePatch = (id: string, data: Partial<AiPatch>) =>
    setAdjustments((previous) => ({
      ...previous,
      aiPatches: previous.aiPatches.map((patch) => (patch.id === id ? { ...patch, ...data } : patch)),
    }));

  const copyToRepair = (mask: MaskContainer) => {
    const patch = copyMaskSelectionToRepair(
      mask,
      t('editor.localEdits.repairFromMask', { name: mask.name, defaultValue: `${mask.name} repair` }),
    );
    setAdjustments((previous) => ({ ...previous, aiPatches: [...previous.aiPatches, patch] }));
    selectEdit('repair', patch.id);
  };

  const copyToAdjustment = (patch: AiPatch) => {
    const mask = copyRepairSelectionToMask(
      patch,
      t('editor.localEdits.adjustmentFromRepair', { name: patch.name, defaultValue: `Adjustment from ${patch.name}` }),
    );
    setAdjustments((previous) => ({ ...previous, masks: [...previous.masks, mask] }));
    selectEdit('adjustment', mask.id);
  };

  const deleteEdit = (kind: EditKind, id: string) => {
    setAdjustments((previous) =>
      kind === 'adjustment'
        ? { ...previous, masks: previous.masks.filter((mask) => mask.id !== id) }
        : { ...previous, aiPatches: previous.aiPatches.filter((patch) => patch.id !== id) },
    );
    if (selectedEdit?.id === id) setEditor({ activeLocalEditKind: null });
  };

  const moveEdit = (kind: EditKind, id: string, direction: -1 | 1) => {
    setAdjustments((previous) => {
      const group: Array<MaskContainer | AiPatch> =
        kind === 'adjustment' ? previous.masks : previous.aiPatches.filter((patch) => !isDirectToolPatch(patch));
      const index = group.findIndex((entry) => entry.id === id);
      if (index < 0 || index + direction < 0 || index + direction >= group.length) return previous;
      const reordered = [...group];
      [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
      if (kind === 'adjustment') return { ...previous, masks: reordered as MaskContainer[] };
      let next = 0;
      return {
        ...previous,
        aiPatches: previous.aiPatches.map((patch) =>
          isDirectToolPatch(patch) ? patch : (reordered[next++] as AiPatch),
        ),
      };
    });
  };

  const insertEditAfter = (kind: EditKind, targetId: string, entry: MaskContainer | AiPatch) => {
    setAdjustments((previous) => {
      if (kind === 'adjustment') {
        const masks = [...previous.masks];
        const index = masks.findIndex((mask) => mask.id === targetId);
        masks.splice(index < 0 ? masks.length : index + 1, 0, entry as MaskContainer);
        return { ...previous, masks };
      }
      const aiPatches = [...previous.aiPatches];
      const index = aiPatches.findIndex((patch) => patch.id === targetId);
      aiPatches.splice(index < 0 ? aiPatches.length : index + 1, 0, entry as AiPatch);
      return { ...previous, aiPatches };
    });
    selectEdit(kind, entry.id);
  };

  const duplicateEdit = (kind: EditKind, entry: MaskContainer | AiPatch, invert = false) => {
    if (kind === 'adjustment') {
      const copy = cloneLocalAdjustment(entry as MaskContainer, invert, true);
      copy.name = t(invert ? 'editor.masks.patches.invertedName' : 'editor.masks.patches.copyName', {
        name: entry.name,
      });
      insertEditAfter(kind, entry.id, copy);
    } else {
      const copy = cloneLocalRepair(entry as AiPatch, invert);
      copy.name = t(invert ? 'editor.ai.patches.invertedName' : 'editor.masks.patches.copyName', {
        name: entry.name,
      });
      insertEditAfter(kind, entry.id, copy);
    }
  };

  const duplicateComponent = (part: SubMask, index: number, invert = false) => {
    if (!selectedEdit || !activeLocalEditKind) return;
    if (!invert && isSurfaceMask(part.type)) return;
    const copy = cloneSelectionComponent(part, invert);
    if (invert) {
      const entry =
        activeLocalEditKind === 'adjustment'
          ? cloneLocalAdjustment(selectedEdit as MaskContainer, false, true)
          : cloneLocalRepair(selectedEdit as AiPatch);
      entry.name = t(
        activeLocalEditKind === 'adjustment' ? 'editor.masks.patches.invertedName' : 'editor.ai.patches.invertedName',
        { name: getSubMaskName(part) },
      );
      entry.invert = false;
      entry.subMasks = [copy];
      insertEditAfter(activeLocalEditKind, selectedEdit.id, entry);
      selectEdit(activeLocalEditKind, entry.id, copy.id);
      return;
    }
    copy.name = t('editor.masks.patches.copyName', { name: getSubMaskName(part) });
    const subMasks = [...selectedEdit.subMasks];
    subMasks.splice(index + 1, 0, copy);
    if (activeLocalEditKind === 'adjustment') updateMask(selectedEdit.id, { subMasks });
    else updatePatch(selectedEdit.id, { subMasks });
    selectEdit(activeLocalEditKind, selectedEdit.id, copy.id);
  };

  const deleteComponent = (part: SubMask) => {
    if (!selectedEdit || !activeLocalEditKind) return;
    const subMasks = selectedEdit.subMasks.filter((item) => item.id !== part.id);
    if (activeLocalEditKind === 'adjustment') updateMask(selectedEdit.id, { subMasks });
    else updatePatch(selectedEdit.id, { subMasks });
    if (selectedSubMask?.id === part.id) selectEdit(activeLocalEditKind, selectedEdit.id);
  };

  const startRename = (kind: EditKind, id: string, component: boolean, name: string) => {
    renameCancelledRef.current = false;
    setRenameDraft(name);
    setRenaming({ kind, id, component });
  };

  const finishRename = () => {
    if (!renameCancelledRef.current && renaming && renameDraft.trim()) {
      const name = renameDraft.trim();
      if (renaming.component) updateSubMask(renaming.id, { name });
      else if (renaming.kind === 'adjustment') updateMask(renaming.id, { name });
      else updatePatch(renaming.id, { name });
    }
    setRenaming(null);
  };

  const showEditMenu = (event: MouseEvent, kind: EditKind, entry: MaskContainer | AiPatch) => {
    event.preventDefault();
    event.stopPropagation();
    const isAdjustment = kind === 'adjustment';
    const label = isAdjustment ? 'editor.masks.actions' : 'editor.ai.actions';
    const options: Option[] = [
      { label: t(`${label}.rename`), icon: FileEdit, onClick: () => startRename(kind, entry.id, false, entry.name) },
      {
        label: t(isAdjustment ? 'editor.masks.actions.duplicateMask' : 'editor.ai.actions.duplicateEdit'),
        icon: PlusSquare,
        onClick: () => duplicateEdit(kind, entry),
      },
      {
        label: t(
          isAdjustment ? 'editor.masks.actions.duplicateAndInvertMask' : 'editor.ai.actions.duplicateAndInvertEdit',
        ),
        icon: RotateCcw,
        onClick: () => duplicateEdit(kind, entry, true),
      },
      {
        label: t(isAdjustment ? 'editor.masks.actions.copyMask' : 'editor.ai.actions.copyEdit'),
        icon: Copy,
        onClick: () =>
          setCopiedEdit(
            isAdjustment
              ? { kind: 'adjustment', entry: structuredClone(entry as MaskContainer) }
              : { kind: 'repair', entry: cloneLocalRepair(entry as AiPatch) },
          ),
      },
      {
        label: t(isAdjustment ? 'editor.masks.actions.pasteMask' : 'editor.ai.actions.pasteEdit'),
        icon: ClipboardPaste,
        disabled: copiedEdit?.kind !== kind,
        onClick: () => {
          if (copiedEdit?.kind !== kind) return;
          const copy =
            kind === 'adjustment'
              ? cloneLocalAdjustment(copiedEdit.entry as MaskContainer)
              : cloneLocalRepair(copiedEdit.entry as AiPatch);
          insertEditAfter(kind, entry.id, copy);
        },
      },
      { type: OPTION_SEPARATOR },
    ];
    if (isAdjustment) {
      options.push({
        label: t('editor.masks.actions.resetMaskAdjustments'),
        icon: RotateCcw,
        onClick: () => updateMask(entry.id, { adjustments: structuredClone(INITIAL_MASK_ADJUSTMENTS) }),
      });
    }
    options.push({
      label: t(isAdjustment ? 'editor.masks.actions.deleteMask' : 'editor.ai.actions.deleteEdit'),
      icon: Trash2,
      isDestructive: true,
      onClick: () => deleteEdit(kind, entry.id),
    });
    showContextMenu(event.clientX, event.clientY, options);
  };

  const showComponentMenu = (event: MouseEvent, part: SubMask, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedEdit || !activeLocalEditKind) return;
    const kind = activeLocalEditKind;
    const label = kind === 'adjustment' ? 'editor.masks.actions' : 'editor.ai.actions';
    const surfaceAlreadySelected = selectedEdit.subMasks.some((entry) => isSurfaceMask(entry.type));
    showContextMenu(event.clientX, event.clientY, [
      {
        label: t(`${label}.rename`),
        icon: FileEdit,
        onClick: () => startRename(kind, part.id, true, getSubMaskName(part)),
      },
      {
        label: t(`${label}.duplicateComponent`),
        icon: PlusSquare,
        disabled: isSurfaceMask(part.type),
        onClick: () => duplicateComponent(part, index),
      },
      {
        label: t(`${label}.duplicateAndInvertComponent`),
        icon: RotateCcw,
        onClick: () => duplicateComponent(part, index, true),
      },
      {
        label: t(`${label}.copyComponent`),
        icon: Copy,
        onClick: () => setCopiedComponent({ kind, part: structuredClone(part) }),
      },
      {
        label: t(`${label}.pasteComponent`),
        icon: ClipboardPaste,
        disabled:
          copiedComponent?.kind !== kind || (isSurfaceMask(copiedComponent.part.type) && surfaceAlreadySelected),
        onClick: () => {
          if (copiedComponent?.kind !== kind) return;
          if (isSurfaceMask(copiedComponent.part.type) && surfaceAlreadySelected) return;
          const copy = cloneSelectionComponent(copiedComponent.part);
          const subMasks = [...selectedEdit.subMasks];
          subMasks.splice(index + 1, 0, copy);
          if (kind === 'adjustment') updateMask(selectedEdit.id, { subMasks });
          else updatePatch(selectedEdit.id, { subMasks });
          selectEdit(kind, selectedEdit.id, copy.id);
        },
      },
      { type: OPTION_SEPARATOR },
      {
        label: t(`${label}.deleteComponent`),
        icon: Trash2,
        isDestructive: true,
        onClick: () => deleteComponent(part),
      },
    ]);
  };

  const selectionButtons = (
    types: typeof MASK_AI_TYPES,
    kind: EditKind,
    onChoose: (type: Mask, depthProvider?: 'marigold') => void,
  ) =>
    types
      .filter((entry) => kind === 'adjustment' || entry.type !== Mask.All)
      .map((entry) => (
        <button
          key={entry.type}
          type="button"
          disabled={isGeneratingAi || isGeneratingAiMask}
          className="min-h-16 rounded-md bg-surface p-2 text-xs text-text-primary hover:bg-card-active disabled:opacity-50"
          onClick={() => onChoose(entry.type)}
        >
          <entry.icon size={19} className="mx-auto mb-1" />
          {t(`masks.types.${entry.type}`, { defaultValue: entry.name })}
        </button>
      ));
  const picker = (
    kind: EditKind,
    onChoose: (type: Mask, depthProvider?: 'marigold') => void,
    isAddingComponent = false,
  ) => (
    <div
      className="grid grid-cols-3 gap-2"
      role="group"
      aria-label={t('editor.localEdits.chooseSelection', { defaultValue: 'Choose selection' })}
    >
      {selectionButtons(MASK_AI_TYPES, kind, onChoose)}
      {appSettings?.marigoldDepthEnabled && (
        <button
          type="button"
          disabled={isGeneratingAi || isGeneratingAiMask}
          className="min-h-16 rounded-md bg-surface p-2 text-xs text-text-primary hover:bg-card-active disabled:opacity-50"
          onClick={() => onChoose(Mask.AiDepth, 'marigold')}
        >
          <span className="block font-medium">
            {t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' })}
          </span>
          <span className="block text-text-secondary">
            {t('editor.masks.marigold.requiresConnector', { defaultValue: 'Requires AI Connector for analysis' })}
          </span>
        </button>
      )}
      {kind === 'adjustment' &&
        appSettings?.marigoldSurfaceEnabled &&
        [Mask.AiNormals, Mask.AiAlbedo].map((type) => {
          const Icon = MASK_ICON_MAP[type];
          return (
            <button
              key={type}
              type="button"
              disabled={
                isGeneratingAi ||
                isGeneratingAiMask ||
                (isAddingComponent && selectedEdit?.subMasks.some((part) => isSurfaceMask(part.type)))
              }
              className="min-h-16 rounded-md bg-surface p-2 text-xs text-text-primary hover:bg-card-active disabled:opacity-50"
              onClick={() => onChoose(type)}
            >
              {Icon && <Icon size={19} className="mx-auto mb-1" />}
              {type === Mask.AiNormals
                ? t('masks.types.normals', { defaultValue: 'Shape Light' })
                : t('masks.types.albedo', { defaultValue: 'Surface Colour' })}
            </button>
          );
        })}
      {selectionButtons(MASK_BASIC_TYPES, kind, onChoose)}
      {selectionButtons(MASK_RANGE_TYPES, kind, onChoose)}
    </div>
  );

  const editRows = (kind: EditKind, entries: Array<MaskContainer | AiPatch>) =>
    entries.map((entry, index) => {
      const active = activeLocalEditKind === kind && selectedEdit?.id === entry.id;
      const hasSurfaceSelection = entry.subMasks.some((part) => isSurfaceMask(part.type));
      return (
        <div
          key={entry.id}
          className={`rounded-md border ${active ? 'border-accent bg-surface' : 'border-surface'}`}
          onContextMenu={(event) => showEditMenu(event, kind, entry)}
        >
          <div className="flex items-center gap-1 p-1">
            {renaming?.id === entry.id && !renaming.component ? (
              <input
                autoFocus
                className="min-w-0 flex-1 rounded border border-accent bg-bg-primary p-2 text-sm outline-none"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={finishRename}
                onContextMenu={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishRename();
                  if (event.key === 'Escape') {
                    renameCancelledRef.current = true;
                    setRenaming(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 break-words p-2 text-left text-sm font-medium leading-5"
                aria-pressed={active}
                onClick={() => selectEdit(kind, entry.id)}
              >
                {entry.name}
              </button>
            )}
            <button
              type="button"
              className="p-1 text-text-secondary hover:text-text-primary"
              aria-label={
                entry.visible
                  ? t('editor.localEdits.hide', { name: entry.name })
                  : t('editor.localEdits.show', { name: entry.name })
              }
              onClick={() =>
                kind === 'adjustment'
                  ? updateMask(entry.id, { visible: !entry.visible })
                  : updatePatch(entry.id, { visible: !entry.visible })
              }
            >
              {entry.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <button
              type="button"
              className="p-1 text-text-secondary hover:text-text-primary"
              disabled={index === 0}
              aria-label={t('editor.localEdits.moveUp', { name: entry.name })}
              onClick={() => moveEdit(kind, entry.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="p-1 text-text-secondary hover:text-text-primary"
              disabled={index === entries.length - 1}
              aria-label={t('editor.localEdits.moveDown', { name: entry.name })}
              onClick={() => moveEdit(kind, entry.id, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="p-1 text-text-secondary hover:text-red-400"
              aria-label={t('editor.localEdits.delete', { name: entry.name })}
              onClick={() => deleteEdit(kind, entry.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
          {active && kind === 'adjustment' && (
            <div className="mx-2 mb-2 space-y-1">
              <button
                type="button"
                disabled={hasSurfaceSelection}
                className="rounded bg-card-active px-2 py-1 text-xs hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => copyToRepair(entry as MaskContainer)}
              >
                <Wand2 size={14} className="mr-1 inline" />
                {t('editor.localEdits.useForRepair', { defaultValue: 'Use selection for AI repair' })}
              </button>
              {hasSurfaceSelection && (
                <p className="text-xs text-text-secondary">
                  {t('editor.localEdits.surfaceRepairUnavailable', {
                    defaultValue:
                      'AI repair cannot use Shape Light or Surface Colour. Create a repair with Brush, Depth, or another supported selection.',
                  })}
                </p>
              )}
            </div>
          )}
          {active && kind === 'repair' && (
            <div className="mx-2 mb-2">
              <button
                type="button"
                className="rounded bg-card-active px-2 py-1 text-xs hover:bg-accent/20"
                onClick={() => copyToAdjustment(entry as AiPatch)}
              >
                <Plus size={14} className="mr-1 inline" />
                {t('editor.localEdits.useForAdjustment', { defaultValue: 'Use selection for adjustment' })}
              </button>
            </div>
          )}
        </div>
      );
    });

  return (
    <div className="flex h-full flex-col overflow-hidden select-none">
      <div className="flex shrink-0 items-center justify-between border-b border-surface p-3">
        <h2 className="text-lg font-semibold">{t('editor.localEdits.title', { defaultValue: 'Local Edits' })}</h2>
        <button
          type="button"
          className="rounded-full p-2 hover:bg-surface"
          aria-label={showPatchMarkers ? t('editor.ai.hideMarkersTooltip') : t('editor.ai.showMarkersTooltip')}
          aria-pressed={!showPatchMarkers}
          onClick={() => setEditor({ showPatchMarkers: !showPatchMarkers })}
        >
          {showPatchMarkers ? <Eye size={18} /> : <EyeOff size={18} />}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 custom-scrollbar">
        {!selectedImage ? (
          <p className="text-sm text-text-secondary">{t('editor.ai.noImageSelected')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="rounded-md bg-surface p-2 text-sm hover:bg-card-active"
                onClick={() => setPickerFor(pickerFor === 'adjustment' ? null : 'adjustment')}
              >
                <Plus size={16} className="mr-1 inline" />
                {t('editor.localEdits.addAdjustment', { defaultValue: 'Add adjustment' })}
              </button>
              <button
                type="button"
                className="rounded-md bg-surface p-2 text-sm hover:bg-card-active"
                onClick={() => setPickerFor(pickerFor === 'repair' ? null : 'repair')}
              >
                <Wand2 size={16} className="mr-1 inline" />
                {t('editor.localEdits.removeReplace', { defaultValue: 'Remove or replace' })}
              </button>
            </div>
            {pickerFor && (
              <section className="space-y-2 rounded-md border border-surface p-2">
                <h3 className="text-sm font-medium">
                  {t('editor.localEdits.chooseSelection', { defaultValue: 'Choose selection' })}
                </h3>
                {picker(pickerFor, (type, depthProvider) => addEdit(pickerFor, type, depthProvider))}
              </section>
            )}
            <section className="space-y-2" aria-label={t('editor.localEdits.edits', { defaultValue: 'Edits' })}>
              <h3 className="text-sm font-semibold">{t('editor.localEdits.repairs', { defaultValue: 'Repairs' })}</h3>
              {repairs.length ? (
                editRows('repair', repairs)
              ) : (
                <p className="text-xs text-text-secondary">
                  {t('editor.localEdits.noRepairs', { defaultValue: 'No repairs yet' })}
                </p>
              )}
              <h3 className="pt-2 text-sm font-semibold">
                {t('editor.localEdits.adjustments', { defaultValue: 'Adjustments' })}
              </h3>
              {adjustments.masks.length ? (
                editRows('adjustment', adjustments.masks)
              ) : (
                <p className="text-xs text-text-secondary">
                  {t('editor.localEdits.noAdjustments', { defaultValue: 'No local adjustments yet' })}
                </p>
              )}
            </section>
            {selectedEdit && (
              <section className="space-y-3 border-t border-surface pt-3">
                <h3 className="text-sm font-semibold">
                  {t('editor.localEdits.selection', { defaultValue: 'Selection' })}
                </h3>
                <div className="space-y-1">
                  {selectedEdit.subMasks.map((part, index) => {
                    const active = selectedSubMask?.id === part.id;
                    const Icon = MASK_ICON_MAP[part.type];
                    const partName = getSubMaskName(part);
                    return (
                      <div
                        key={part.id}
                        className="flex items-center gap-1"
                        onContextMenu={(event) => showComponentMenu(event, part, index)}
                      >
                        {renaming?.id === part.id && renaming.component ? (
                          <input
                            autoFocus
                            className="min-w-0 flex-1 rounded border border-accent bg-bg-primary p-2 text-sm outline-none"
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onBlur={finishRename}
                            onContextMenu={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') finishRename();
                              if (event.key === 'Escape') {
                                renameCancelledRef.current = true;
                                setRenaming(null);
                              }
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className={`min-w-0 flex-1 rounded p-2 text-left text-sm ${active ? 'bg-surface' : 'hover:bg-card-active'}`}
                            aria-pressed={active}
                            onClick={() => selectEdit(activeLocalEditKind!, selectedEdit.id, part.id)}
                          >
                            {Icon && <Icon size={15} className="mr-2 inline" />}
                            {partName}
                          </button>
                        )}
                        <button
                          type="button"
                          className="p-1 text-text-secondary hover:text-red-400"
                          aria-label={t('editor.localEdits.deleteComponent', { name: partName })}
                          onClick={() => deleteComponent(part)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="rounded-md bg-surface px-3 py-2 text-xs hover:bg-card-active"
                  onClick={() => setShowComponentPicker(!showComponentPicker)}
                >
                  <Plus size={14} className="mr-1 inline" />
                  {t('editor.localEdits.addComponent', { defaultValue: 'Add to selection' })}
                </button>
                {showComponentPicker && (
                  <div className="space-y-2 rounded-md border border-surface p-2">
                    <div
                      className="flex gap-1"
                      role="group"
                      aria-label={t('editor.localEdits.combineMode', { defaultValue: 'Combine selection' })}
                    >
                      {modes.map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={componentMode === mode}
                          className={`flex-1 rounded p-1 text-xs ${componentMode === mode ? 'bg-accent/20 text-primary' : 'bg-surface'}`}
                          onClick={() => setComponentMode(mode)}
                        >
                          {mode === SubMaskMode.Additive
                            ? t('editor.localEdits.addMode')
                            : mode === SubMaskMode.Subtractive
                              ? t('editor.localEdits.subtractMode')
                              : t('editor.localEdits.intersectMode')}
                        </button>
                      ))}
                    </div>
                    {picker(
                      activeLocalEditKind!,
                      (type, depthProvider) => addComponent(type, componentMode, depthProvider),
                      true,
                    )}
                  </div>
                )}
                {selectedMask && (
                  <MaskSettingsPanel
                    selectionOnly
                    onLimitWithBrush={() => {
                      setComponentMode(SubMaskMode.Intersect);
                      addComponent(Mask.Brush, SubMaskMode.Intersect);
                    }}
                    container={selectedMask}
                    activeSubMask={selectedSubMask ?? null}
                    aiModelDownloadStatus={aiModelDownloadStatus}
                    brushSettings={brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }}
                    setBrushSettings={(value) =>
                      setEditor((state) => ({
                        brushSettings:
                          typeof value === 'function'
                            ? value(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush })
                            : value,
                      }))
                    }
                    updateContainer={updateMask}
                    updateSubMask={updateSubMask}
                    histogram={histogram}
                    appSettings={appSettings}
                    setIsMaskControlHovered={(hovered) => setEditor({ isMaskControlHovered: hovered })}
                    collapsibleState={maskSections}
                    setCollapsibleState={setMaskSections}
                    copiedSectionAdjustments={copiedSectionAdjustments}
                    setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                    onDragStateChange={(dragging) => setEditor({ isSliderDragging: dragging })}
                    isSettingsSectionOpen={isSettingsSectionOpen}
                    setSettingsSectionOpen={setSettingsSectionOpen}
                    presets={presets}
                    handleGenerateAiDepthMask={handleGenerateAiDepthMask}
                    handleGenerateSurfaceMask={handleGenerateSurfaceMask}
                  />
                )}
                {repairSelection && (
                  <MaskSettingsPanel
                    selectionOnly
                    onLimitWithBrush={() => {
                      setComponentMode(SubMaskMode.Intersect);
                      addComponent(Mask.Brush, SubMaskMode.Intersect);
                    }}
                    container={repairSelection}
                    activeSubMask={selectedSubMask ?? null}
                    aiModelDownloadStatus={aiModelDownloadStatus}
                    brushSettings={brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }}
                    setBrushSettings={(value) =>
                      setEditor((state) => ({
                        brushSettings:
                          typeof value === 'function'
                            ? value(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush })
                            : value,
                      }))
                    }
                    updateContainer={(id, data) =>
                      updatePatch(id, {
                        ...(data.invert !== undefined ? { invert: data.invert } : {}),
                        ...(data.visible !== undefined ? { visible: data.visible } : {}),
                        ...(data.subMasks !== undefined ? { subMasks: data.subMasks } : {}),
                      })
                    }
                    updateSubMask={updateSubMask}
                    histogram={histogram}
                    appSettings={appSettings}
                    setIsMaskControlHovered={(hovered) => setEditor({ isMaskControlHovered: hovered })}
                    collapsibleState={maskSections}
                    setCollapsibleState={setMaskSections}
                    copiedSectionAdjustments={copiedSectionAdjustments}
                    setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                    onDragStateChange={(dragging) => setEditor({ isSliderDragging: dragging })}
                    isSettingsSectionOpen={isSettingsSectionOpen}
                    setSettingsSectionOpen={setSettingsSectionOpen}
                    presets={presets}
                    handleGenerateAiDepthMask={handleGenerateAiDepthMask}
                    handleGenerateSurfaceMask={handleGenerateSurfaceMask}
                  />
                )}
                {selectedMask && (
                  <h3 className="border-t border-surface pt-3 text-sm font-semibold">
                    {t('editor.localEdits.effect', { defaultValue: 'Effect' })}
                  </h3>
                )}
                {selectedMask && (
                  <MaskSettingsPanel
                    effectOnly
                    onLimitWithBrush={() => {
                      setComponentMode(SubMaskMode.Intersect);
                      addComponent(Mask.Brush, SubMaskMode.Intersect);
                    }}
                    container={selectedMask}
                    activeSubMask={selectedSubMask ?? null}
                    aiModelDownloadStatus={aiModelDownloadStatus}
                    brushSettings={brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush }}
                    setBrushSettings={(value) =>
                      setEditor((state) => ({
                        brushSettings:
                          typeof value === 'function'
                            ? value(state.brushSettings ?? { size: 50, feather: 50, tool: ToolType.Brush })
                            : value,
                      }))
                    }
                    updateContainer={updateMask}
                    updateSubMask={updateSubMask}
                    histogram={histogram}
                    appSettings={appSettings}
                    setIsMaskControlHovered={(hovered) => setEditor({ isMaskControlHovered: hovered })}
                    collapsibleState={maskSections}
                    setCollapsibleState={setMaskSections}
                    copiedSectionAdjustments={copiedSectionAdjustments}
                    setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                    onDragStateChange={(dragging) => setEditor({ isSliderDragging: dragging })}
                    isSettingsSectionOpen={isSettingsSectionOpen}
                    setSettingsSectionOpen={setSettingsSectionOpen}
                    presets={presets}
                    handleGenerateAiDepthMask={handleGenerateAiDepthMask}
                    handleGenerateSurfaceMask={handleGenerateSurfaceMask}
                  />
                )}
                {selectedRepair && (
                  <h3 className="border-t border-surface pt-3 text-sm font-semibold">
                    {t('editor.localEdits.effect', { defaultValue: 'Effect' })}
                  </h3>
                )}
                {selectedRepair && (
                  <ConnectionStatus
                    aiProvider={provider}
                    isAIConnectorConnected={isAIConnectorConnected}
                    isSignedIn={!!isSignedIn}
                    isPro={!!isPro}
                    cloudUsage={cloudUsage}
                  />
                )}
                {selectedRepair && (
                  <AISettingsPanel
                    effectOnly
                    container={selectedRepair}
                    activeSubMask={selectedSubMask ?? null}
                    aiModelDownloadStatus={aiModelDownloadStatus}
                    brushSettings={brushSettings ?? { size: 100, feather: 50, tool: ToolType.Brush }}
                    setBrushSettings={(value) =>
                      setEditor((state) => ({
                        brushSettings:
                          typeof value === 'function'
                            ? value(state.brushSettings ?? { size: 100, feather: 50, tool: ToolType.Brush })
                            : value,
                      }))
                    }
                    updateContainer={updatePatch}
                    updateSubMask={updateSubMask}
                    isGeneratingAi={isGeneratingAi}
                    isGeneratingAiMask={isGeneratingAiMask}
                    collapsibleState={aiSections}
                    setCollapsibleState={setAiSections}
                    isGenerativeAvailable={isGenerativeAvailable}
                    capabilityState={capabilities.state}
                    retryCapabilities={capabilities.retry}
                    onManualCleanup={handleDirectPatch}
                  />
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
