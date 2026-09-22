import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../../store/useEditorStore';
import type { AiPatch, Adjustments, RemovalOptions } from '../../../utils/adjustments';
import Button from '../../ui/Button';
import Input from '../../ui/Input';

interface Props {
  patch: AiPatch;
  disabled: boolean;
  onChange: (options: RemovalOptions) => void;
}

export default function RemovalControls({ patch, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const adjustments = useEditorStore((state) => state.adjustments);
  const selectedImage = useEditorStore((state) => state.selectedImage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ adjustments: Adjustments; patch: AiPatch; path: string; url: string }>();
  const options = patch.removalOptions ?? {};
  const showPreview =
    preview?.adjustments === adjustments && preview?.patch === patch && preview?.path === selectedImage?.path;
  const inspect = async () => {
    if (!selectedImage?.path) return;
    setLoading(true);
    setError('');
    try {
      const result = JSON.parse(
        await invoke<string>('invoke_generative_replace_with_mask_def', {
          path: selectedImage.path,
          patchDefinition: patch,
          currentAdjustments: adjustments,
          useFastInpaint: true,
          previewOnly: true,
          token: null,
        }),
      );
      setPreview({ adjustments, patch, path: selectedImage.path, url: result.mask });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-secondary">{t('editor.ai.removal.description')}</p>
      <label className="block text-sm">
        {t('editor.ai.removal.expand')}
        <Input
          type="number"
          min={0}
          max={256}
          step={1}
          disabled={disabled || loading}
          value={options.expandPixels ?? 0}
          onChange={(event) =>
            onChange({
              ...options,
              expandPixels: Math.max(0, Math.min(256, Math.round(Number(event.target.value) || 0))),
            })
          }
        />
      </label>
      <label className="block text-sm">
        {t('editor.ai.removal.feather')}
        <Input
          type="number"
          min={0}
          max={256}
          step={1}
          disabled={disabled || loading}
          value={options.featherPixels ?? 0}
          onChange={(event) =>
            onChange({
              ...options,
              featherPixels: Math.max(0, Math.min(256, Math.round(Number(event.target.value) || 0))),
            })
          }
        />
      </label>
      <Button disabled={disabled || loading || !selectedImage?.path} onClick={inspect}>
        {loading ? t('editor.ai.removal.previewing') : t('editor.ai.removal.preview')}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-text-secondary">
          {error}
        </p>
      )}
      {preview && showPreview && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{t('editor.ai.removal.legend')}</p>
          <img className="max-h-48 w-full object-contain" src={preview.url} alt={t('editor.ai.removal.previewAlt')} />
        </div>
      )}
    </div>
  );
}
