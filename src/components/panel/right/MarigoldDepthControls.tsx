import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardMarigoldResult, isMarigoldPending } from '../../../hooks/useAiMasking';
import { useEditorStore } from '../../../store/useEditorStore';
import { DEPTH_SELECTIONS } from '../../../utils/surfaceEditing';
import type { MaskParameters, SubMask } from './Masks';

export default function MarigoldDepthControls({
  subMask,
  enabled,
  generate,
  updateSubMask,
}: {
  subMask: SubMask;
  enabled: boolean;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
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
  const analysisAction = (
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
      {t('editor.masks.marigold.generate', { defaultValue: 'Analyse depth' })}
    </button>
  );
  return (
    <div className="space-y-2 rounded border border-border-color p-3 text-sm">
      <p className="font-medium">{t('editor.masks.marigold.newMask', { defaultValue: 'Depth Selection' })}</p>
      <p className="text-text-secondary">
        {t('editor.masks.marigold.requiresConnector', { defaultValue: 'Requires AI Connector for analysis' })}
      </p>
      <p className="text-text-secondary">
        {t('editor.masks.marigold.purpose', {
          defaultValue:
            'Choose a distance range, then adjust its exposure, colour or contrast with the local controls.',
        })}
      </p>
      <p>
        {subMask.parameters.depthProvider === 'marigold'
          ? subMask.parameters.depthArtifact
            ? t('editor.masks.marigold.saved', { defaultValue: 'Saved depth analysis · ready to edit offline' })
            : t('editor.masks.marigold.empty', { defaultValue: 'Depth analysis not yet available' })
          : t('editor.masks.marigold.builtin', { defaultValue: 'Depth source: built-in' })}
      </p>
      {subMask.parameters.depthProvider === 'marigold' && subMask.parameters.depthArtifact && (
        <div
          role="group"
          aria-label={t('editor.masks.marigold.startingRange', { defaultValue: 'Starting selection' })}
          className="grid grid-cols-3 gap-2"
        >
          {(
            [
              ['near', t('editor.masks.marigold.near', { defaultValue: 'Near' })],
              ['middle', t('editor.masks.marigold.middle', { defaultValue: 'Middle' })],
              ['far', t('editor.masks.marigold.far', { defaultValue: 'Far' })],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className="rounded border border-border-color bg-surface px-2 py-2 aria-pressed:bg-card-active focus-visible:ring-2 focus-visible:ring-accent"
              aria-pressed={Object.entries(DEPTH_SELECTIONS[key]).every(
                ([parameter, value]) => subMask.parameters[parameter as keyof MaskParameters] === value,
              )}
              onClick={() =>
                updateSubMask(subMask.id, { parameters: { ...subMask.parameters, ...DEPTH_SELECTIONS[key] } })
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {subMask.parameters.depthArtifact ? (
        <details>
          <summary className="cursor-pointer text-text-secondary">
            {t('editor.surface.analysisDetails', { defaultValue: 'Analysis details' })}
          </summary>
          <div className="mt-2">{analysisAction}</div>
        </details>
      ) : (
        analysisAction
      )}
      {(pending || (busy && isMarigoldPending(subMask.id))) && (
        <>
          <p role="status">
            {t('editor.masks.marigold.progress', { defaultValue: 'Analysing distance or waiting for the server…' })}
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
                'Near, Middle and Far are starting ranges, not object selections. Refine the range below and check the overlay; no new analysis is needed.',
            })
          : t('editor.masks.marigold.generateHint', {
              defaultValue:
                'Analyse the photo to select nearer or more distant areas. These are relative ranges, not measured distances.',
            })}
      </p>
    </div>
  );
}
