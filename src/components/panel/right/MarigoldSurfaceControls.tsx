import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardMarigoldResult, isMarigoldPending } from '../../../hooks/useAiMasking';
import { useEditorStore } from '../../../store/useEditorStore';
import { isSurfaceMask, surfaceGeometryHash, surfaceGeometrySnapshot } from '../../../utils/surfaceGeometry';
import Slider from '../../ui/Slider';
import type { MaskParameters, SubMask } from './Masks';

export default function MarigoldSurfaceControls({
  subMask,
  enabled,
  generate,
  updateSubMask,
  onDragStateChange,
}: {
  subMask: SubMask;
  enabled: boolean;
  generate: (id: string, kind: 'normals' | 'albedo') => Promise<void>;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
  onDragStateChange: (dragging: boolean) => void;
}) {
  const { t } = useTranslation();
  const busy = useEditorStore((s) => s.isGeneratingAiMask);
  const snapshot = useEditorStore((s) => surfaceGeometrySnapshot(s.adjustments));
  const multiple = useEditorStore(
    (s) =>
      (s.adjustments.masks
        .find((m) => m.subMasks.some((p) => p.id === subMask.id))
        ?.subMasks.filter((p) => isSurfaceMask(p.type)).length ?? 0) > 1,
  );
  const [hash, setHash] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [view, setView] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const params = subMask.parameters;
  const kind = subMask.type === 'ai-normals' ? 'normals' : 'albedo';
  const stale = !!params.surfaceArtifact && !!hash && hash !== params.surfaceArtifact.geometryHash;
  const saved = !!params.surfaceArtifact && !!params.maskDataBase64;
  const pending = busy && isMarigoldPending(subMask.id);
  const update = (values: Partial<MaskParameters>) =>
    updateSubMask(subMask.id, { parameters: { ...params, ...values } });
  useEffect(() => {
    let active = true;
    void surfaceGeometryHash(snapshot).then((result) => {
      if (active) setHash(result);
    });
    return () => {
      active = false;
    };
  }, [snapshot]);
  useEffect(() => {
    if (view) dialog.current?.showModal();
    else dialog.current?.close();
  }, [view]);
  const control = (
    key: 'normalAngle' | 'normalAmount' | 'surfaceTolerance' | 'surfaceAmount',
    label: string,
    min: number,
    max: number,
    step: number,
    fallback: number,
  ) => (
    <Slider
      key={key}
      label={label}
      min={min}
      max={max}
      step={step}
      defaultValue={fallback}
      value={params[key] ?? fallback}
      fillOrigin="min"
      onDragStateChange={onDragStateChange}
      onChange={(e) => update({ [key]: Number(e.target.value) })}
    />
  );
  const color =
    '#' + (params.surfaceColor ?? [90, 160, 220]).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return (
    <div className="space-y-3 rounded border border-border-color p-3 text-sm">
      <p>
        {kind === 'normals'
          ? t('editor.surface.normals', { defaultValue: 'Directional light · normals' })
          : t('editor.surface.albedo', { defaultValue: 'Colour selection · albedo' })}
      </p>
      <p role="status" className="text-text-secondary">
        {multiple
          ? t('editor.surface.multiple', {
              defaultValue:
                'This mask is inactive. Keep one normals or albedo component per mask; move the other to a separate mask.',
            })
          : stale
            ? t('editor.surface.stale', {
                defaultValue:
                  'Geometry or retouch changed. This mask is inactive until you regenerate its map or undo that change.',
              })
            : saved
              ? t('editor.surface.saved', { defaultValue: 'Saved 16-bit map · controls work offline' })
              : t('editor.surface.empty', { defaultValue: 'Generate a map to begin.' })}
      </p>
      <button
        disabled={!enabled || busy || multiple}
        className="rounded bg-surface px-3 py-2 disabled:opacity-50"
        onClick={() => {
          setCancelled(false);
          void generate(subMask.id, kind);
        }}
      >
        {saved
          ? t('editor.surface.regenerate', { defaultValue: 'Regenerate map' })
          : t('editor.surface.generate', { defaultValue: 'Generate map' })}
      </button>
      {!enabled && (
        <p className="text-text-secondary">
          {t('editor.surface.enableHint', {
            defaultValue: 'Enable Marigold directional light and colour in Settings to generate maps.',
          })}
        </p>
      )}
      {pending && (
        <div role="status">
          <p>{t('editor.surface.wait', { defaultValue: 'Waiting for the GPU or generating a surface map…' })}</p>
          <button
            className="underline disabled:opacity-50"
            disabled={cancelled}
            onClick={() => {
              discardMarigoldResult(subMask.id);
              setCancelled(true);
            }}
          >
            {t('editor.masks.marigold.cancel', { defaultValue: 'Discard result' })}
          </button>
          <p>
            {t('editor.masks.marigold.cancelHint', {
              defaultValue: 'The GPU job may finish; discarding keeps the current mask.',
            })}
          </p>
        </div>
      )}
      {saved && (
        <>
          <button className="rounded bg-surface px-3 py-2" onClick={() => setView(true)}>
            {kind === 'normals'
              ? t('editor.surface.view', { defaultValue: 'View normals map' })
              : t('editor.surface.pick', { defaultValue: 'Choose colour on albedo map' })}
          </button>
          {kind === 'normals' ? (
            <>
              {control(
                'normalAngle',
                t('editor.surface.direction', { defaultValue: 'Light direction (°)' }),
                -180,
                180,
                1,
                0,
              )}
              {control(
                'normalAmount',
                t('editor.surface.lightAmount', { defaultValue: 'Dodge / burn strength (EV)' }),
                -1.5,
                1.5,
                0.05,
                0.5,
              )}
              <p className="text-text-secondary">
                {t('editor.surface.lightHint', {
                  defaultValue:
                    '0° lights from the right; 90° from above. Positive strength brightens facing surfaces and darkens opposing surfaces; negative strength reverses this. The overlay shows the facing selection. This is a tonal effect, not a physically accurate light simulation.',
                })}
              </p>
            </>
          ) : (
            <>
              {control(
                'surfaceTolerance',
                t('editor.surface.tolerance', { defaultValue: 'Colour range' }),
                0.005,
                1,
                0.005,
                0.13,
              )}
              <label className="flex items-center justify-between gap-2">
                {t('editor.surface.target', { defaultValue: 'Recolour to' })}
                <input
                  type="color"
                  value={color}
                  aria-label={t('editor.surface.target', { defaultValue: 'Recolour to' })}
                  onChange={(e) =>
                    update({ surfaceColor: [1, 3, 5].map((i) => parseInt(e.target.value.slice(i, i + 2), 16)) })
                  }
                />
              </label>
              {control('surfaceAmount', t('editor.surface.amount', { defaultValue: 'Recolour amount' }), 0, 1, 0.01, 0)}
              <p className="text-text-secondary">
                {t('editor.surface.colourHint', {
                  defaultValue:
                    'Pick a colour on the albedo map, then increase the recolour amount. Brightness and texture are retained; very bright areas may be less saturated. At zero, use this as a selection for ordinary local adjustments.',
                })}
              </p>
            </>
          )}
          <p className="text-text-secondary">
            {t('editor.surface.region', {
              defaultValue:
                'Intersect with a brush or subject mask to confine the edit. Use separate masks for normals and albedo.',
            })}
          </p>
        </>
      )}
      <dialog
        ref={dialog}
        onCancel={() => setView(false)}
        onClose={() => setView(false)}
        onKeyDown={(e) => e.stopPropagation()}
        className="m-auto max-w-[95vw] max-h-[95vh] rounded-lg bg-bg-primary text-text-primary p-4 backdrop:bg-black/70"
      >
        <div className="flex justify-between items-center gap-8 mb-3">
          <h2>
            {kind === 'normals'
              ? t('editor.surface.mapNormals', { defaultValue: 'Normals map' })
              : t('editor.surface.mapAlbedo', { defaultValue: 'Albedo map · click a colour to select it' })}
          </h2>
          <button className="rounded bg-surface px-3 py-2" onClick={() => setView(false)}>
            {t('common.close', { defaultValue: 'Close' })}
          </button>
        </div>
        {view && params.maskDataBase64 && (
          <div className="relative w-fit mx-auto">
            <img
              src={params.maskDataBase64}
              alt={kind === 'normals' ? 'Saved normals map' : 'Saved albedo map'}
              className={`block max-h-[75vh] max-w-[85vw] w-auto ${kind === 'albedo' ? 'cursor-crosshair' : ''}`}
              onClick={
                kind === 'albedo'
                  ? (e) => {
                      const box = e.currentTarget.getBoundingClientRect();
                      update({
                        surfacePointX: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)),
                        surfacePointY: Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)),
                      });
                    }
                  : undefined
              }
            />
            {kind === 'albedo' && (
              <span
                aria-hidden="true"
                className="absolute pointer-events-none h-4 w-4 rounded-full border-2 border-white shadow-[0_0_0_1px_black] -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${(params.surfacePointX ?? 0.5) * 100}%`,
                  top: `${(params.surfacePointY ?? 0.5) * 100}%`,
                }}
              />
            )}
          </div>
        )}
        <p className="mt-2 text-text-secondary">
          {t('editor.surface.mapHint', {
            defaultValue:
              'Analysis map before display rotation and crop. Your photo and edit retain their original resolution.',
          })}
        </p>
      </dialog>
    </div>
  );
}
