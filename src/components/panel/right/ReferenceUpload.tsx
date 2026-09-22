import { useId, useRef, useState } from 'react';
import { ChevronDown, ImagePlus, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function ReferenceUpload({
  references,
  loading,
  disabled,
  supported,
  onUpload,
  onRemove,
}: {
  references: string[];
  loading: boolean;
  disabled: boolean;
  supported: boolean;
  onUpload: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const contentId = useId();
  const hintId = useId();
  const blocked = disabled || loading || !supported || references.length >= 4;
  return (
    <section className="border-t border-surface" aria-label={t('editor.ai.studio.references')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded py-3 text-xs font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
        <span className="flex-1 text-left">{t('editor.ai.studio.references')}</span>
        <span className="text-text-secondary">{references.length}/4</span>
        {loading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
      </button>
      <div id={contentId} hidden={!open} className="space-y-2 pb-2" aria-busy={loading}>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          tabIndex={-1}
          disabled={blocked}
          onChange={(event) => {
            onUpload(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        {references.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {references.map((reference, index) => (
              <div key={index} className="relative overflow-hidden rounded-md border border-surface bg-bg-secondary">
                <img
                  src={`data:image/png;base64,${reference}`}
                  alt={t('editor.ai.studio.referenceNumber', { number: index + 1 })}
                  className="h-24 w-full object-contain p-2"
                />
                <div className="flex items-center justify-between gap-1 px-2 pb-1 text-xs text-text-secondary">
                  <span>{index + 1}</span>
                  <button
                    type="button"
                    disabled={disabled || loading}
                    onClick={() => onRemove(index)}
                    aria-label={t('editor.ai.studio.removeReferenceNumber', { number: index + 1 })}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={blocked}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-dashed border-text-secondary/25 bg-bg-secondary px-3 py-3 text-xs text-text-primary hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImagePlus size={18} aria-hidden="true" />
          {t(loading ? 'editor.ai.studio.referenceLoading' : 'editor.ai.studio.addReferences')}
        </button>
        <div id={hintId} className="space-y-1 text-xs text-text-secondary" role="status">
          <p>{t(supported ? 'editor.ai.studio.multiReferenceHint' : 'editor.ai.studio.referenceUnsupported')}</p>
          <p>{t('editor.ai.studio.referenceLimits')}</p>
          <p>{t('editor.ai.studio.referenceCountLimit')}</p>
        </div>
      </div>
      {!open && references.length > 0 && !supported && (
        <p role="status" className="pb-2 text-xs text-text-secondary">
          {t('editor.ai.studio.referenceUnsupported')}
        </p>
      )}
    </section>
  );
}
