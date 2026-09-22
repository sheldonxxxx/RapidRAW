import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../store/useEditorStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import type { InpaintCandidate } from '../../../utils/adjustments';
import { toggleInpaintCandidate, inpaintSpatialKey } from '../../../utils/inpaintHistory';
import Button from '../../ui/Button';

export default function InpaintGallery({
  disabled,
  editId,
  onReuse,
}: {
  disabled: boolean;
  editId: string | null;
  onReuse: (candidate: InpaintCandidate) => void;
}) {
  const { t } = useTranslation();
  const adjustments = useEditorStore((state) => state.adjustments);
  const path = useEditorStore((state) => state.selectedImage?.path);
  const { setAdjustments } = useEditorActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const candidates = (adjustments.inpaintHistory ?? []).filter((candidate) => candidate.patch.id === editId);
  const selected = candidates.find((entry) => entry.id === selectedId) ?? candidates.at(-1);
  const compatible = selected?.spatialKey === inpaintSpatialKey(adjustments);

  useEffect(() => {
    setSelectedId(null);
    setConfirmDelete(false);
  }, [path, editId]);

  if (!editId) return null;
  if (!selected) return <p className="text-xs text-text-secondary">{t('editor.ai.studio.empty')}</p>;
  return (
    <section className="space-y-3 border-t border-surface pt-3" aria-label={t('editor.ai.studio.history')}>
      <div className="flex justify-between text-sm font-medium">
        <span>{t('editor.ai.studio.history')}</span>
        <span>{candidates.length}</span>
      </div>
      <p className="text-xs text-text-secondary">{t('editor.ai.studio.saved')}</p>
      <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
        {[...candidates].reverse().map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            disabled={
              disabled ||
              (candidate.spatialKey !== inpaintSpatialKey(adjustments) &&
                !adjustments.aiPatches.some((patch) => patch.appliedCandidateId === candidate.id && patch.visible))
            }
            aria-pressed={adjustments.aiPatches.some(
              (patch) => patch.appliedCandidateId === candidate.id && patch.visible,
            )}
            aria-label={t('editor.ai.studio.result', { number: candidates.length - index })}
            onClick={() => {
              useEditorStore.getState().patchesSentToBackend.clear();
              setAdjustments((current) => toggleInpaintCandidate(current, candidate));
              setSelectedId(candidate.id);
              setConfirmDelete(false);
            }}
            className={`rounded-md overflow-hidden border-2 ${adjustments.aiPatches.some((patch) => patch.appliedCandidateId === candidate.id && patch.visible) ? 'border-accent' : 'border-transparent'} focus-visible:outline focus-visible:outline-2`}
          >
            <img
              loading="lazy"
              className="w-full aspect-square object-contain bg-black/20"
              src={`data:image/png;base64,${candidate.patch.patchData?.color}`}
              alt=""
            />
            <span className="block text-xs py-1">{candidates.length - index}</span>
          </button>
        ))}
      </div>
      {adjustments.aiPatches.some((patch) => patch.appliedCandidateId === selected.id && patch.visible) && (
        <p className="text-xs text-accent" role="status">
          {t('editor.ai.studio.applied')}
        </p>
      )}
      <p className="text-xs break-words">
        {selected.patch.prompt ||
          t(selected.method === 'basic' ? 'editor.ai.studio.basic' : 'editor.ai.studio.removal')}
      </p>
      <p className="text-xs text-text-secondary">
        {new Date(selected.createdAt).toLocaleString()} ·{' '}
        {selected.patch.patchData?.generation?.profile ?? selected.method}
      </p>
      {!compatible && (
        <p role="status" className="text-xs">
          {t('editor.ai.studio.spatialMismatch')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button className="bg-surface text-text-primary text-sm" disabled={disabled} onClick={() => onReuse(selected)}>
          {t('editor.ai.studio.reuse')}
        </Button>
        <Button
          className="bg-surface text-text-primary text-sm"
          disabled={disabled}
          onClick={() => setConfirmDelete(true)}
        >
          {t('editor.ai.studio.delete')}
        </Button>
      </div>
      {confirmDelete && (
        <div className="space-y-2 text-xs" role="alert">
          <p>{t('editor.ai.studio.deleteConfirm')}</p>
          <div className="flex gap-2">
            <Button
              disabled={disabled}
              onClick={() => {
                setAdjustments((current) => ({
                  ...current,
                  inpaintHistory: current.inpaintHistory?.filter((entry) => entry.id !== selected.id),
                }));
                setSelectedId(null);
                setConfirmDelete(false);
              }}
            >
              {t('editor.ai.studio.delete')}
            </Button>
            <Button onClick={() => setConfirmDelete(false)}>{t('editor.ai.studio.cancel')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
