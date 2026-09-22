import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { AppSettings } from '../ui/AppProperties';
import Switch from '../ui/Switch';

export default function MarigoldDepthSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const [address, setAddress] = useState(settings.aiConnectorAddress ?? '');
  useEffect(() => {
    setAddress(settings.aiConnectorAddress ?? '');
    setStatus('');
  }, [settings.aiConnectorAddress]);
  const enabled = settings.marigoldDepthEnabled ?? false;
  return (
    <section className="mt-6 space-y-3 rounded-lg border border-border-color p-4">
      <Switch
        label={t('settings.marigold.enable', { defaultValue: 'Depth Selection' })}
        checked={enabled}
        onChange={(value) => {
          void onChange({ ...settings, marigoldDepthEnabled: value });
        }}
      />
      <p className="text-sm text-text-secondary">
        {t('settings.marigold.description', {
          defaultValue:
            'Select nearer or more distant parts of a photograph for local adjustments. Powered by Marigold through your AI connector and ComfyUI. Saved analysis works offline.',
        })}
      </p>
      {enabled && (
        <>
          {settings.aiProvider === 'ai-connector' ? (
            <p className="text-sm">
              {t('settings.marigold.sharedAddress', { defaultValue: 'Uses the AI connector address below:' })}{' '}
              {settings.aiConnectorAddress || t('settings.marigold.notConfigured', { defaultValue: 'not configured' })}
            </p>
          ) : (
            <label className="block text-sm">
              {t('settings.marigold.address', { defaultValue: 'AI connector address (shared)' })}
              <input
                className="mt-1 w-full rounded bg-bg-primary p-2"
                value={address}
                placeholder="127.0.0.1:5000"
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                onBlur={() => {
                  if (address !== settings.aiConnectorAddress)
                    void onChange({ ...settings, aiConnectorAddress: address });
                }}
              />
            </label>
          )}
          <button
            className="rounded bg-bg-primary px-3 py-2 text-sm disabled:opacity-50"
            disabled={checking || !settings.aiConnectorAddress}
            onClick={async () => {
              setChecking(true);
              setStatus('');
              try {
                await invoke('test_marigold_depth_connection', { address: settings.aiConnectorAddress });
                setStatus(t('settings.marigold.ready', { defaultValue: 'Depth Selection is ready.' }));
              } catch (error) {
                setStatus(String(error));
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking
              ? t('settings.marigold.checking', { defaultValue: 'Checking models…' })
              : t('settings.marigold.check', { defaultValue: 'Check depth setup' })}
          </button>
          <p role="status" className="text-sm break-words">
            {status}
          </p>
        </>
      )}
    </section>
  );
}
