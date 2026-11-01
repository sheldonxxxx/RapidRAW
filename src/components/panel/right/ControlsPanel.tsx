import clsx from 'clsx';
import { AnimatePresence, motion } from 'framer-motion';
import { ChartArea, ClipboardPaste, Copy, LayoutList, PencilSparkles, RotateCcw } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { buildAutoAdjustModeOptions, useEditorActions } from '../../../hooks/useEditorActions';
import { useWaveformControls } from '../../../hooks/useWaveformControls';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import {
  ActiveTools,
  ADJUSTMENT_SECTIONS,
  Adjustments,
  copyAdjustmentKeys,
  getActiveTools,
  getVisibleAdjustmentSections,
  INITIAL_ADJUSTMENTS,
  isToolActive,
  pickAdjustments,
  setToolActive,
  toggleToolActive,
} from '../../../utils/adjustments';
import AdjustmentSection from '../../adjustments/AdjustmentSection';
import type { Option } from '../../ui/AppProperties';
import { OPTION_SEPARATOR, Orientation } from '../../ui/AppProperties';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Resizer from '../../ui/Resizer';
import Text from '../../ui/Text';
import ConnectedWaveform from '../editor/ConnectedWaveform';
import AdjustmentSectionsSubMenu from './AdjustmentSectionsSubMenu';

function AdjustmentSectionContent(props: {
  sectionName: import('../../../utils/adjustments').AdjustmentSection;
  activeTools: ActiveTools;
  onToggleTool(id: string): void;
  [key: string]: unknown;
}) {
  const adjustments = useEditorStore((state) => state.adjustments);
  return <AdjustmentSection {...props} adjustments={adjustments} />;
}

export default function Controls() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { isResizingWaveform, onToggleWaveform, setActiveWaveformChannel, handleWaveformResize } =
    useWaveformControls();
  const { setAdjustments, handleAutoAdjustments, handleLutSelect, setLutPreviewOverride } = useEditorActions();

  const { appSettings, theme } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
    })),
  );

  const visibleSections = getVisibleAdjustmentSections(appSettings?.adjustmentLayout);

  const { collapsibleSectionsState, setUI } = useUIStore(
    useShallow((state) => ({
      collapsibleSectionsState: state.collapsibleSectionsState,
      setUI: state.setUI,
    })),
  );

  const {
    activeToolsState,
    sectionVisibility,
    copiedSectionAdjustments,
    selectedImage,
    isWbPickerActive,
    isWaveformVisible,
    waveformHeight,
    setEditor,
  } = useEditorStore(
    useShallow((state) => ({
      activeToolsState: state.adjustments.activeTools,
      sectionVisibility: state.adjustments.sectionVisibility,
      copiedSectionAdjustments: state.copiedSectionAdjustments,
      selectedImage: state.selectedImage,
      isWbPickerActive: state.isWbPickerActive,
      isWaveformVisible: state.isWaveformVisible,
      waveformHeight: state.waveformHeight,
      setEditor: state.setEditor,
    })),
  );

  const activeTools = useMemo(
    () => getActiveTools({ activeTools: activeToolsState, sectionVisibility }),
    [activeToolsState, sectionVisibility],
  );

  const setCopiedSectionAdjustments = useCallback(
    (val: typeof copiedSectionAdjustments) => setEditor({ copiedSectionAdjustments: val }),
    [setEditor],
  );

  const toggleWbPicker = useCallback(
    () =>
      setEditor((state) => ({
        isWbPickerActive: !state.isWbPickerActive,
        isRelightPickerActive: false,
        activeCenterMarker: null,
      })),
    [setEditor],
  );

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const setCollapsibleState = useCallback(
    (updater: React.SetStateAction<typeof collapsibleSectionsState>) =>
      setUI((state) => ({
        collapsibleSectionsState: typeof updater === 'function' ? updater(state.collapsibleSectionsState) : updater,
      })),
    [setUI],
  );

  const handleToggleVisibility = useCallback(
    (id: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        activeTools: toggleToolActive(getActiveTools(prev), id),
      }));
    },
    [setAdjustments],
  );

  const handleResetAdjustments = () => {
    setAdjustments(
      (prev: Adjustments) => ({
        ...prev,
        ...Object.keys(ADJUSTMENT_SECTIONS)
          .flatMap((s) => ADJUSTMENT_SECTIONS[s])
          .reduce((acc, key: string) => {
            acc[key] = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            return acc;
          }, {} as Partial<Adjustments>),
        activeTools: { ...INITIAL_ADJUSTMENTS.activeTools },
      }),
      t('contextMenus.editor.resetAdjustments'),
    );
  };

  const handleAutoAdjustContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, buildAutoAdjustModeOptions(t, handleAutoAdjustments));
  };

  const handleToggleSection = (section: import('../../../utils/adjustments').AdjustmentSection) => {
    setCollapsibleState((prev) => {
      const isOpening = !prev[section];
      if (appSettings?.enableFocusMode && isOpening) {
        const newState = { ...prev };
        Object.keys(newState).forEach((keyString) => {
          const key = keyString as keyof typeof newState;
          newState[key] = false;
        });
        newState[section] = true;
        return newState;
      }
      return { ...prev, [section]: !prev[section] };
    });
  };

  const handleSectionContextMenu = (
    event: React.MouseEvent,
    sectionName: import('../../../utils/adjustments').AdjustmentSection,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
    if (!sectionKeys) {
      return;
    }

    const handleCopy = () => {
      const { adjustments } = useEditorStore.getState();
      const adjustmentsToCopy = pickAdjustments(useEditorStore.getState().adjustments, sectionKeys);
      for (const key of sectionKeys) {
        if (Object.prototype.hasOwnProperty.call(adjustments, key)) {
          copyAdjustmentKeys(adjustmentsToCopy, adjustments, [key as keyof Adjustments]);
        }
      }
      setCopiedSectionAdjustments({ section: sectionName, values: adjustmentsToCopy });
    };

    const handlePaste = () => {
      if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) {
        return;
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...copiedSectionAdjustments.values,
        activeTools: setToolActive(getActiveTools(prev), sectionName, true),
      }));
    };

    const handleReset = () => {
      const resetValues = pickAdjustments(INITIAL_ADJUSTMENTS, sectionKeys);
      for (const key of sectionKeys) {
        copyAdjustmentKeys(resetValues, INITIAL_ADJUSTMENTS, [key as keyof Adjustments]);
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...resetValues,
        activeTools: setToolActive(getActiveTools(prev), sectionName, true),
      }));
    };

    const isPasteAllowed = copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName;
    const translatedSection = t(`editor.adjustments.sections.${sectionName}`, { defaultValue: sectionName });

    const pasteLabel = copiedSectionAdjustments
      ? t('editor.adjustments.actions.pasteLabel', { section: translatedSection })
      : t('editor.adjustments.actions.pasteSettings');

    const options: Option[] = [
      {
        label: t('editor.adjustments.actions.copySectionSettings', { section: translatedSection }),
        icon: Copy,
        onClick: handleCopy,
      },
      { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
      { type: OPTION_SEPARATOR },
      {
        label: t('editor.adjustments.actions.resetSectionSettings', { section: translatedSection }),
        icon: RotateCcw,
        onClick: handleReset,
      },
      { type: OPTION_SEPARATOR },
      {
        label: t('editor.adjustments.actions.customizePanels'),
        icon: LayoutList,
        submenu: [{ renderContent: () => <AdjustmentSectionsSubMenu /> }],
      },
    ];

    showContextMenu(event.clientX, event.clientY, options);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.adjustments.title')}</Text>
        <div className="flex items-center gap-1">
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={() => handleAutoAdjustments()}
            onContextMenu={handleAutoAdjustContextMenu}
            data-tooltip={t('editor.adjustments.tooltips.autoAdjust')}
          >
            <PencilSparkles size={18} />
          </button>
          <button
            className={clsx(
              'p-2 rounded-full transition-colors',
              isWaveformVisible ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
            )}
            onClick={onToggleWaveform}
            data-tooltip={t('editor.adjustments.tooltips.toggleAnalytics')}
          >
            <ChartArea size={18} />
          </button>
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleResetAdjustments}
            data-tooltip={t('editor.adjustments.tooltips.resetAdjustments')}
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isWaveformVisible && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: waveformHeight || 256, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
            className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
          >
            <div className="grow w-full h-full p-3 pb-2 min-h-0">
              <ConnectedWaveform
                setDisplayMode={setActiveWaveformChannel}
                setAdjustments={setAdjustments}
                theme={theme}
              />
            </div>
            <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grow overflow-y-scroll p-3 flex flex-col gap-2">
        {selectedImage ? (
          visibleSections.map((sectionName: import('../../../utils/adjustments').AdjustmentSection) => {
            const title = t(`editor.adjustments.sections.${sectionName}`, { defaultValue: sectionName });

            return (
              <div className="shrink-0 group" key={sectionName}>
                <CollapsibleSection
                  isContentVisible={isToolActive(activeTools, sectionName)}
                  isOpen={collapsibleSectionsState[sectionName as keyof typeof collapsibleSectionsState]}
                  onContextMenu={(e) => handleSectionContextMenu(e, sectionName)}
                  onToggle={() => handleToggleSection(sectionName)}
                  onToggleVisibility={() => handleToggleVisibility(sectionName)}
                  title={title}
                >
                  <AdjustmentSectionContent
                    sectionName={sectionName}
                    activeTools={activeTools}
                    onToggleTool={handleToggleVisibility}
                    setAdjustments={setAdjustments}
                    theme={theme}
                    handleLutSelect={handleLutSelect}
                    onLutHover={setLutPreviewOverride}
                    appSettings={appSettings}
                    asShotWhiteBalance={selectedImage.asShotWhiteBalance}
                    isWbPickerActive={isWbPickerActive}
                    toggleWbPicker={toggleWbPicker}
                    onDragStateChange={onDragStateChange}
                  />
                </CollapsibleSection>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {t('editor.ai.noImageSelected')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
