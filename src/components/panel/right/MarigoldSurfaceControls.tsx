import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { discardMarigoldResult, isMarigoldPending } from '../../../hooks/useAiMasking';
import { useEditorStore } from '../../../store/useEditorStore';
import { isSurfaceMask, surfaceGeometryHash, surfaceGeometrySnapshot } from '../../../utils/surfaceGeometry';
import Slider from '../../ui/Slider';
import { displayedLightDirection } from '../../../utils/surfaceEditing';
import type { MaskParameters, SubMask } from './Masks';

export default function MarigoldSurfaceControls({
  subMask,
  enabled,
  generate,
  updateSubMask,
  onDragStateChange,
  onLimitWithBrush,
}: {
  subMask: SubMask;
  enabled: boolean;
  generate: (id: string, kind: 'normals' | 'albedo') => Promise<void>;
  updateSubMask: (id: string, data: Partial<SubMask>) => void;
  onDragStateChange: (dragging: boolean) => void;
  onLimitWithBrush: () => void;
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
  const [showRecolour, setShowRecolour] = useState((subMask.parameters.surfaceAmount ?? 0) > 0);
  const dialog = useRef<HTMLDialogElement>(null);
  const params = subMask.parameters;
  const kind = subMask.type === 'ai-normals' ? 'normals' : 'albedo';
  const stale = !!params.surfaceArtifact && !!hash && hash !== params.surfaceArtifact.geometryHash;
  const saved = !!params.surfaceArtifact && !!params.maskDataBase64;
  const lightAmount = params.normalAmount ?? 0.5;
  const lightDirection = displayedLightDirection(params.normalAngle ?? 0, lightAmount);
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
  ) => {
    const factor = key === 'surfaceTolerance' || key === 'surfaceAmount' ? 100 : 1;
    return (
      <Slider
        key={key}
        label={label}
        min={min * factor}
        max={max * factor}
        step={step * factor}
        suffix={factor === 100 ? '%' : ''}
        defaultValue={fallback * factor}
        value={key === 'normalAngle' ? lightDirection : (params[key] ?? fallback) * factor}
        disabled={stale || multiple}
        fillOrigin="min"
        onDragStateChange={onDragStateChange}
        onChange={(e) =>
          update({
            [key]: Number(e.target.value) / factor,
            ...(key === 'normalAngle' ? { normalAmount: Math.abs(lightAmount) } : {}),
          })
        }
      />
    );
  };
  const analysisAction = (
    <button
      disabled={!enabled || busy || multiple}
      className="rounded bg-surface px-3 py-2 disabled:opacity-50"
      onClick={() => {
        setCancelled(false);
        void generate(subMask.id, kind);
      }}
    >
      {saved
        ? t('editor.surface.regenerate', { defaultValue: 'Update analysis' })
        : t('editor.surface.generate', { defaultValue: 'Analyse photo' })}
    </button>
  );
  const color =
    '#' + (params.surfaceColor ?? [90, 160, 220]).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return (
    <div className="space-y-3 rounded border border-border-color p-3 text-sm">
      <p className="font-medium">
        {kind === 'normals'
          ? t('editor.surface.normals', { defaultValue: 'Shape Light' })
          : t('editor.surface.albedo', { defaultValue: 'Surface Colour' })}
      </p>
      <p role="status" className="text-text-secondary">
        {multiple
          ? t('editor.surface.multiple', {
              defaultValue: 'This edit is inactive. Put Shape Light and Surface Colour in separate masks.',
            })
          : stale
            ? t('editor.surface.stale', {
                defaultValue:
                  'The photo geometry or retouch changed. Update analysis or undo that change to use this edit.',
              })
            : saved
              ? t('editor.surface.saved', { defaultValue: 'Saved analysis · ready to edit offline' })
              : t('editor.surface.empty', { defaultValue: 'Analyse the photograph to begin.' })}
      </p>
      {(!saved || stale) && analysisAction}
      {!enabled && (!saved || stale) && (
        <p className="text-text-secondary">
          {t('editor.surface.enableHint', {
            defaultValue: 'Enable Shape Light and Surface Colour in Settings to analyse photos.',
          })}
        </p>
      )}
      {pending && (
        <div role="status">
          <p>{t('editor.surface.wait', { defaultValue: 'Analysing the photograph or waiting for the server…' })}</p>
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
          {kind === 'normals' ? (
            <>
              <fieldset disabled={stale || multiple} className="space-y-2 disabled:opacity-50">
                <legend className="mb-2 font-medium">
                  {t('editor.surface.lightFrom', { defaultValue: 'Light from' })}
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { angle: 180, label: t('editor.surface.left', { defaultValue: 'Left' }) },
                    { angle: 90, label: t('editor.surface.above', { defaultValue: 'Above' }) },
                    { angle: 0, label: t('editor.surface.right', { defaultValue: 'Right' }) },
                    { angle: -90, label: t('editor.surface.below', { defaultValue: 'Below' }) },
                  ].map(({ angle, label }) => (
                    <button
                      key={angle}
                      className="rounded border border-border-color bg-surface px-3 py-2 aria-pressed:bg-card-active focus-visible:ring-2 focus-visible:ring-accent"
                      aria-pressed={Math.abs(displayedLightDirection(angle, 1) - lightDirection) < 0.5}
                      onClick={() => update({ normalAngle: angle, normalAmount: Math.abs(lightAmount) })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Slider
                label={t('editor.surface.strength', { defaultValue: 'Strength' })}
                min={0}
                max={100}
                step={0.1}
                defaultValue={0}
                suffix="%"
                value={Math.round((Math.abs(lightAmount) / 1.5) * 1000) / 10}
                disabled={stale || multiple}
                onDragStateChange={onDragStateChange}
                onChange={(e) =>
                  update({ normalAngle: lightDirection, normalAmount: (Number(e.target.value) / 100) * 1.5 })
                }
              />
              <p className="text-text-secondary">
                {t('editor.surface.lightHint', {
                  defaultValue:
                    'Brightens surfaces facing the light and darkens the other side. Start gently and judge the photograph; the overlay shows only the facing side. Existing cast shadows stay in place.',
                })}
              </p>
            </>
          ) : (
            <>
              <p className="rounded bg-surface p-3">
                {t('editor.surface.pickPhoto', {
                  defaultValue: 'Click a colour on the photograph, then refine the selection with Colour range.',
                })}
              </p>
              {control(
                'surfaceTolerance',
                t('editor.surface.tolerance', { defaultValue: 'Colour range' }),
                0.005,
                1,
                0.005,
                0.13,
              )}
              <p className="text-text-secondary">
                {t('editor.surface.selectionHint', {
                  defaultValue:
                    'Use the mask overlay to check the selected area, then adjust its exposure, saturation or other local controls.',
                })}
              </p>
              <details
                className="space-y-3"
                open={showRecolour}
                onToggle={(event) => setShowRecolour(event.currentTarget.open)}
              >
                <summary className="cursor-pointer font-medium">
                  {t('editor.surface.recolour', { defaultValue: 'Recolour (optional)' })}
                </summary>
                <label className="flex items-center justify-between gap-2">
                  {t('editor.surface.target', { defaultValue: 'Recolour to' })}
                  <input
                    type="color"
                    disabled={stale || multiple}
                    value={color}
                    aria-label={t('editor.surface.target', { defaultValue: 'Recolour to' })}
                    onChange={(e) =>
                      update({ surfaceColor: [1, 3, 5].map((i) => parseInt(e.target.value.slice(i, i + 2), 16)) })
                    }
                  />
                </label>
                {control(
                  'surfaceAmount',
                  t('editor.surface.amount', { defaultValue: 'Recolour amount' }),
                  0,
                  1,
                  0.01,
                  0,
                )}
                <p className="text-text-secondary">
                  {t('editor.surface.colourHint', {
                    defaultValue:
                      'Choose a replacement colour and increase the amount. Source brightness and texture are retained; bright highlights may show less colour. At zero, only your ordinary local adjustments apply.',
                  })}
                </p>
              </details>
            </>
          )}
          <button
            className="w-full rounded border border-border-color px-3 py-2 disabled:opacity-50"
            disabled={busy || stale || multiple}
            onClick={onLimitWithBrush}
          >
            {t('editor.surface.limitBrush', { defaultValue: 'Limit with a brush' })}
          </button>
          <p className="text-text-secondary">
            {t('editor.surface.region', {
              defaultValue:
                'Paint over the area you want to edit. Only the overlap is affected. Return to this component to continue adjusting light or colour.',
            })}
          </p>
          <details className="space-y-3 text-text-secondary">
            <summary className="cursor-pointer">
              {t('editor.surface.analysisDetails', { defaultValue: 'Analysis details' })}
            </summary>
            {saved && !stale && analysisAction}
            {kind === 'normals' &&
              control(
                'normalAngle',
                t('editor.surface.direction', { defaultValue: 'Light direction (°)' }),
                -180,
                180,
                1,
                0,
              )}
            <button className="rounded bg-surface px-3 py-2" onClick={() => setView(true)}>
              {kind === 'normals'
                ? t('editor.surface.view', { defaultValue: 'View normals map' })
                : t('editor.surface.pick', { defaultValue: 'View colour analysis' })}
            </button>
            <p>
              {t('editor.surface.provider', {
                defaultValue: 'Powered by Marigold. Analysis is an estimate; check fine edges before a strong edit.',
              })}
            </p>
          </details>
        </>
      )}
      <dialog
        ref={dialog}
        aria-label={t('editor.surface.analysisDetails', { defaultValue: 'Analysis details' })}
        onCancel={() => setView(false)}
        onClose={() => setView(false)}
        onKeyDown={(e) => e.stopPropagation()}
        className="m-auto max-w-[95vw] max-h-[95vh] rounded-lg bg-bg-primary text-text-primary p-4 backdrop:bg-black/70"
      >
        <div className="flex justify-between items-center gap-8 mb-3">
          <h2>
            {kind === 'normals'
              ? t('editor.surface.mapNormals', { defaultValue: 'Normals map' })
              : t('editor.surface.mapAlbedo', { defaultValue: 'Colour analysis · click to refine the sample' })}
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
