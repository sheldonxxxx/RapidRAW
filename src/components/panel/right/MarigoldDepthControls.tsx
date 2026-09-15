import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardMarigoldResult, isMarigoldPending } from '../../../hooks/useAiMasking';
import { useEditorStore } from '../../../store/useEditorStore';
import type { MaskParameters, SubMask } from './Masks';

export default function MarigoldDepthControls({
  subMask,
  enabled,
  generate,
}: {
  subMask: SubMask;
  enabled: boolean;
  generate: (id: string, parameters: MaskParameters, shouldApply?: () => boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const busy = useEditorStore((state) => state.isGeneratingAiMask);
  const [pending, setPending] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  return (
    <div className="space-y-2 rounded border border-border-color p-3 text-sm">
      <p>
        {subMask.parameters.depthProvider === 'marigold'
          ? subMask.parameters.depthArtifact
            ? t('editor.masks.marigold.saved', { defaultValue: 'Marigold · saved 16-bit depth' })
            : t('editor.masks.marigold.empty', { defaultValue: 'Marigold · depth not generated' })
          : t('editor.masks.marigold.builtin', { defaultValue: 'Depth source: built-in' })}
      </p>
      <button
        disabled={!enabled || busy}
        className="rounded bg-surface px-3 py-2 disabled:opacity-50"
        onClick={async () => {
          const id = ++generation.current;
          setPending(true);
          setCancelled(false);
          try {
            await generate(
              subMask.id,
              { ...subMask.parameters, depthProvider: 'marigold' },
              () => id === generation.current,
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {t('editor.masks.marigold.generate', { defaultValue: 'Generate with Marigold' })}
      </button>
      {(pending || (busy && isMarigoldPending(subMask.id))) && (
        <>
          <p role="status">
            {t('editor.masks.marigold.progress', { defaultValue: 'Waiting for the GPU or generating depth…' })}
          </p>
          <button
            disabled={cancelled}
            className="underline disabled:opacity-50"
            onClick={() => {
              generation.current++;
              discardMarigoldResult(subMask.id);
              setCancelled(true);
            }}
          >
            {t('editor.masks.marigold.cancel', { defaultValue: 'Discard result' })}
          </button>
          <p className="text-text-secondary">
            {t('editor.masks.marigold.cancelHint', {
              defaultValue: 'The GPU job may finish; discarding keeps the current mask.',
            })}
          </p>
        </>
      )}
      <p className="text-text-secondary">
        {subMask.parameters.depthArtifact
          ? t('editor.masks.marigold.range', {
              defaultValue:
                'Adjust the depth range below without running the model again. Depth is relative, with nearer areas brighter.',
            })
          : t('editor.masks.marigold.generateHint', {
              defaultValue: 'Generate a depth map to select a range. Depth is relative, with nearer areas brighter.',
            })}
      </p>
    </div>
  );
}
