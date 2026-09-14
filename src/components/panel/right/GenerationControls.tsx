import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RotateCw } from 'lucide-react';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Text from '../../ui/Text';
import { TextVariants } from '../../../types/typography';
import { resolveGenerationOptions, type CapabilityState, type GenerationDraft } from '../../../utils/generationOptions';
import type { AiPatchGeneration } from '../../../utils/adjustments';

interface Props {
  state: CapabilityState;
  draft: GenerationDraft;
  onChange: (value: GenerationDraft) => void;
  onRetry: () => void;
  disabled: boolean;
}

export default function GenerationControls({ state, draft, onChange, onRetry, disabled }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const capabilities = state.status === 'ready' ? state.data : undefined;
  const profile = capabilities?.profiles.find((entry) => entry.id === (draft.profile ?? capabilities.defaultProfile));
  const selection = resolveGenerationOptions(state, draft);
  const useDefault = () => onChange({ seedText: '', useDefault: true });
  const selectStyle =
    'h-10 w-full rounded-md border border-border-color bg-surface px-2 text-sm text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50';

  if (state.status === 'inactive') return null;
  if (draft.useDefault) {
    return (
      <div className="space-y-2">
        <Text variant={TextVariants.small}>{t('editor.ai.generation.connectorDefault')}</Text>
        <Button
          disabled={disabled}
          onClick={() => {
            onChange({ seedText: '' });
            onRetry();
          }}
        >
          {t('editor.ai.generation.chooseWorkflow')}
        </Button>
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
        <Loader2 size={14} className="animate-spin" />
        {t('editor.ai.generation.loading')}
      </div>
    );
  }
  if (!capabilities) {
    return (
      <div className="space-y-2">
        <Text variant={TextVariants.small}>
          {state.status === 'legacy' && !selection.error
            ? t('editor.ai.generation.legacy')
            : t('editor.ai.generation.unavailable')}
        </Text>
        {state.status === 'error' && (
          <p className="text-xs text-text-secondary break-words" role="status">
            {state.message}
          </p>
        )}
        {selection.error && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled} onClick={onRetry}>
              {t('editor.ai.generation.retry')}
            </Button>
            <Button disabled={disabled} onClick={useDefault}>
              {t('editor.ai.generation.useDefault')}
            </Button>
          </div>
        )}
        {state.status === 'legacy' && !selection.error && (
          <Button disabled={disabled} onClick={onRetry}>
            {t('editor.ai.generation.refresh')}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="block text-sm text-text-primary" htmlFor={`${id}-workflow`}>
            {t('editor.ai.generation.workflow')}
          </label>
          <button
            type="button"
            className="p-1 text-text-secondary hover:text-text-primary disabled:opacity-50"
            disabled={disabled}
            onClick={onRetry}
            aria-label={t('editor.ai.generation.refresh')}
            title={t('editor.ai.generation.refresh')}
          >
            <RotateCw size={14} />
          </button>
        </div>
        <select
          id={`${id}-workflow`}
          className={selectStyle}
          disabled={disabled}
          value={profile?.id ?? ''}
          onChange={(event) => {
            const next = capabilities.profiles.find((entry) => entry.id === event.target.value);
            if (next) onChange({ ...draft, profile: next.id, megapixels: next.defaultMegapixels });
          }}
        >
          {!profile && (
            <option value="" disabled>
              {t('editor.ai.generation.chooseWorkflow')}
            </option>
          )}
          {capabilities.profiles.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="block text-sm text-text-primary" htmlFor={`${id}-detail`}>
          {t('editor.ai.generation.detail')}
        </label>
        <select
          id={`${id}-detail`}
          className={selectStyle}
          disabled={disabled || !profile}
          value={
            profile?.megapixels.includes(draft.megapixels ?? profile.defaultMegapixels)
              ? (draft.megapixels ?? profile?.defaultMegapixels)
              : ''
          }
          onChange={(event) => onChange({ ...draft, megapixels: Number(event.target.value) })}
        >
          {selection.error === 'detail' && (
            <option value="" disabled>
              {t('editor.ai.generation.chooseDetail')}
            </option>
          )}
          {profile?.megapixels.map((mp) => (
            <option key={mp} value={mp}>
              {t('editor.ai.generation.megapixels', { megapixels: mp })}
            </option>
          ))}
        </select>
        <Text variant={TextVariants.small}>{t('editor.ai.generation.detailHelp')}</Text>
      </div>
      {capabilities.seed && (
        <div className="space-y-1">
          <label className="block text-sm text-text-primary" htmlFor={`${id}-seed`}>
            {t('editor.ai.generation.seed')}
          </label>
          <Input
            id={`${id}-seed`}
            disabled={disabled}
            type="text"
            value={draft.seedText}
            placeholder={t('editor.ai.generation.randomSeed')}
            onChange={(event) => onChange({ ...draft, seedText: event.target.value })}
          />
          <Text variant={TextVariants.small}>{t('editor.ai.generation.seedHelp')}</Text>
        </div>
      )}
      {selection.error && (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-text-secondary">{t(`editor.ai.generation.errors.${selection.error}`)}</p>
          {selection.error !== 'seed' && (
            <Button disabled={disabled} onClick={useDefault}>
              {t('editor.ai.generation.useDefault')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function GenerationResultInfo({ generation }: { generation?: AiPatchGeneration }) {
  const { t } = useTranslation();
  if (!generation?.generatedSize || !generation.context) return null;
  return (
    <div className="space-y-1 text-xs text-text-secondary" aria-label={t('editor.ai.generation.lastResult')}>
      <p>
        {t('editor.ai.generation.resultSize', {
          width: generation.generatedSize[0],
          height: generation.generatedSize[1],
          placedWidth: generation.context.width,
          placedHeight: generation.context.height,
        })}
      </p>
      <p>{t('editor.ai.generation.resultSeed', { seed: String(generation.seed) })}</p>
    </div>
  );
}
