import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../store/useEditorStore';
import type { SubMask } from './Masks';

const previewButtonClass =
  'rounded bg-surface px-3 py-2 hover:bg-hover-color focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-card-active disabled:opacity-50';

function DepthMapDialog({ source, provider, onClose }: { source: string; provider: string; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const scale = zoom ?? fitScale;
  const minimumScale = Math.min(0.01, fitScale / 4);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !size.width || !size.height) return;
    const updateFit = () =>
      setFitScale(Math.min(1, viewport.clientWidth / size.width, viewport.clientHeight / size.height));
    updateFit();
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [size]);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="m-auto h-[88vh] max-h-[900px] w-[94vw] max-w-6xl rounded-xl border border-border-color bg-bg-primary p-0 text-text-primary shadow-2xl backdrop:bg-black/70"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-color p-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold">
              {t('editor.masks.depthPreview.title', { defaultValue: 'Depth map' })}
            </h2>
            <p className="text-sm text-text-secondary">
              {provider}
              {size.width > 0 ? ` · ${size.width} × ${size.height}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button className={previewButtonClass} aria-pressed={zoom === null} onClick={() => setZoom(null)}>
              {t('editor.masks.depthPreview.fit', { defaultValue: 'Fit' })}
            </button>
            <button className={previewButtonClass} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
              100%
            </button>
            <button
              className={previewButtonClass}
              aria-label={t('editor.masks.depthPreview.zoomOut', { defaultValue: 'Zoom out' })}
              disabled={!size.width || scale <= minimumScale}
              onClick={() => setZoom(Math.max(minimumScale, scale / 2))}
            >
              −
            </button>
            <span className="min-w-12 text-center" aria-live="polite">
              {zoom === null
                ? t('editor.masks.depthPreview.fit', { defaultValue: 'Fit' })
                : `${Math.round(zoom * 1000) / 10}%`}
            </span>
            <button
              className={previewButtonClass}
              aria-label={t('editor.masks.depthPreview.zoomIn', { defaultValue: 'Zoom in' })}
              disabled={!size.width || scale >= 4}
              onClick={() => setZoom(Math.min(4, scale * 2))}
            >
              +
            </button>
            <button className={`${previewButtonClass} ml-2`} onClick={onClose} autoFocus>
              {t('editor.masks.depthPreview.close', { defaultValue: 'Close' })}
            </button>
          </div>
        </header>
        <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto bg-black/60" tabIndex={0}>
          {failed ? (
            <p className="p-6 text-center" role="alert">
              {t('editor.masks.depthPreview.error', { defaultValue: 'The saved depth map could not be displayed.' })}
            </p>
          ) : (
            <div
              className="flex min-h-full min-w-full items-center justify-center"
              style={
                zoom === null
                  ? { width: '100%', height: '100%' }
                  : { width: size.width * zoom, height: size.height * zoom }
              }
            >
              <img
                src={source}
                alt={t('editor.masks.depthPreview.alt', {
                  defaultValue: 'Full depth map: nearer areas are brighter, farther areas are darker',
                })}
                draggable={false}
                className={zoom === null ? 'h-full w-full object-scale-down' : 'max-w-none shrink-0'}
                style={zoom === null ? undefined : { width: size.width * zoom, height: size.height * zoom }}
                onLoad={(event) =>
                  setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
                }
                onError={() => setFailed(true)}
              />
            </div>
          )}
        </div>
        <footer className="shrink-0 space-y-2 border-t border-border-color p-4 text-sm">
          <div className="mx-auto flex max-w-md items-center gap-3">
            <span>{t('editor.masks.depthPreview.far', { defaultValue: 'Far' })}</span>
            <div
              className="h-3 flex-1 rounded border border-border-color bg-gradient-to-r from-black to-white"
              aria-hidden="true"
            />
            <span>{t('editor.masks.depthPreview.near', { defaultValue: 'Near' })}</span>
          </div>
          <p className="text-center text-text-secondary">
            {t('editor.masks.depthPreview.description', {
              defaultValue:
                'Full image before rotation and crop. Shows relative depth, independent of your selected range.',
            })}
          </p>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}

export default function DepthMapPreview({ subMask }: { subMask: SubMask }) {
  const { t } = useTranslation();
  const path = useEditorStore((state) => state.selectedImage?.path);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const scope = `${path ?? ''}:${subMask.id}`;
  const source = subMask.parameters.maskDataBase64;
  const available = typeof source === 'string' && source.startsWith('data:image/png;base64,');

  return (
    <div className="space-y-2">
      <button
        className={`${previewButtonClass} w-full border border-border-color text-sm`}
        disabled={!available}
        onClick={() => setOpenedFor(scope)}
      >
        {t('editor.masks.depthPreview.open', { defaultValue: 'Visualize depth' })}
      </button>
      {!available && (
        <p className="text-sm text-text-secondary">
          {t('editor.masks.depthPreview.missing', { defaultValue: 'Generate a depth map to preview it.' })}
        </p>
      )}
      {available && openedFor === scope && (
        <DepthMapDialog
          source={source}
          provider={
            subMask.parameters.depthProvider === 'marigold'
              ? 'Marigold'
              : t('editor.masks.depthPreview.builtin', { defaultValue: 'Built-in depth' })
          }
          onClose={() => setOpenedFor(null)}
        />
      )}
    </div>
  );
}
