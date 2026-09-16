import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import type { AppSettings } from '../ui/AppProperties';
import Switch from '../ui/Switch';

export default function MarigoldSurfaceSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const [checkedAddress, setCheckedAddress] = useState('');
  return (
    <section className="mt-6 space-y-3 rounded-lg border border-border-color p-4">
      <Switch
        label={t('settings.surface.enable', { defaultValue: 'Optional Marigold directional light and colour' })}
        checked={settings.marigoldSurfaceEnabled ?? false}
        onChange={(value) => {
          void onChange({ ...settings, marigoldSurfaceEnabled: value });
        }}
      />
      <p className="text-sm text-text-secondary">
        {t('settings.surface.description', {
          defaultValue:
            'Use surface normals for directional dodge and burn, and albedo for colour selections and recolouring. Uses the same AI connector and ComfyUI as your other AI tools. Saved maps work offline.',
        })}
      </p>
      {settings.marigoldSurfaceEnabled && (
        <>
          {settings.aiProvider === 'ai-connector' || settings.marigoldDepthEnabled ? (
            <p className="text-sm">
              {t('settings.surface.sharedAddress', { defaultValue: 'Uses your shared AI connector address:' })}{' '}
              {settings.aiConnectorAddress || t('settings.marigold.notConfigured', { defaultValue: 'not configured' })}
            </p>
          ) : (
            <label className="block text-sm">
              {t('settings.marigold.address', { defaultValue: 'AI connector address (shared)' })}
              <input
                className="mt-1 w-full rounded bg-bg-primary p-2"
                defaultValue={settings.aiConnectorAddress ?? ''}
                key={settings.aiConnectorAddress}
                placeholder="127.0.0.1:5000"
                onKeyDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  if (e.target.value !== settings.aiConnectorAddress)
                    void onChange({ ...settings, aiConnectorAddress: e.target.value });
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
              setCheckedAddress(settings.aiConnectorAddress ?? '');
              try {
                const result = await invoke<{ tasks: Record<string, { ready: boolean }> }>(
                  'test_marigold_surface_connection',
                  { address: settings.aiConnectorAddress },
                );
                const ready = t('settings.surface.taskReady', { defaultValue: 'ready' });
                const missing = t('settings.surface.taskMissing', {
                  defaultValue: 'not ready — check server models and nodes',
                });
                setStatus(
                  t('settings.surface.taskStatus', {
                    defaultValue: 'Normals: {{normals}}. Albedo: {{albedo}}.',
                    normals: result.tasks?.normals?.ready ? ready : missing,
                    albedo: result.tasks?.albedo?.ready ? ready : missing,
                  }),
                );
              } catch (error) {
                setStatus(String(error));
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking
              ? t('settings.marigold.checking', { defaultValue: 'Checking models…' })
              : t('settings.surface.check', { defaultValue: 'Check normals and albedo setup' })}
          </button>
          <p role="status" className="text-sm break-words">
            {checkedAddress === settings.aiConnectorAddress ? status : ''}
          </p>
        </>
      )}
    </section>
  );
}
