import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Download, FolderOpen, Loader2, Sparkles, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../../../store/useEditorStore';
import { useUIStore } from '../../../store/useUIStore';
import { debouncedSetHistory, useEditorActions } from '../../../hooks/useEditorActions';
import { INITIAL_MASK_ADJUSTMENTS, type Adjustments } from '../../../utils/adjustments';
import { Invokes, Panel } from '../../ui/AppProperties';
import Button from '../../ui/Button';

type Operation = 'refine_mask' | 'semantic_mask' | 'deblur' | 'upscale';
type Domain = 'landscape' | 'face';
type Profile = 'fast' | 'balanced' | 'quality';
type Provider = 'auto' | 'cpu' | 'coreml' | 'cuda';
interface ModelStatus {
  id: string;
  name: string;
  ready: boolean;
  download_available: boolean;
  coreml_supported?: boolean;
}
interface EnhancementResult {
  adjustments?: Adjustments;
  mask_id?: string;
  sub_mask_id?: string;
  result_path?: string;
  preview: string;
  before_preview: string;
  receipt: { total_ms?: number; elapsed_ms?: number; output_dimensions?: number[]; warnings?: string[] };
}

const LANDSCAPE = ['vegetation', 'water', 'sky', 'building', 'mountain', 'ground', 'person', 'animal'];
const FACE = ['skin', 'hair', 'eyes', 'brows', 'lips', 'nose', 'neck', 'clothing', 'ears'];
const fieldClass =
  'w-full rounded-md border border-border-color bg-bg-primary px-2 py-2 text-sm text-text-primary focus:outline-accent disabled:opacity-50';

export default function EnhancementPanel() {
  const { t } = useTranslation();
  const label = (key: string, defaultValue: string) => t(`editor.enhancement.${key}`, { defaultValue });
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const adjustments = useEditorStore((s) => s.adjustments);
  const activeMaskContainerId = useEditorStore((s) => s.activeMaskContainerId);
  const activeMaskId = useEditorStore((s) => s.activeMaskId);
  const otherJobRunning = useEditorStore((s) => s.isGeneratingAi || s.isGeneratingAiMask);
  const { setAdjustments } = useEditorActions();
  const [expanded, setExpanded] = useState(false);
  const [operation, setOperation] = useState<Operation>('refine_mask');
  const [profile, setProfile] = useState<Profile>('balanced');
  const [provider, setProvider] = useState<Provider>('auto');
  const [domain, setDomain] = useState<Domain>('landscape');
  const [classes, setClasses] = useState<string[]>(['vegetation']);
  const [targetKey, setTargetKey] = useState('');
  const [strength, setStrength] = useState(60);
  const [confidence, setConfidence] = useState(50);
  const [radius, setRadius] = useState(32);
  const [useRegion, setUseRegion] = useState(false);
  const [region, setRegion] = useState(['0', '0', '', '']);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>(['auto', 'cpu']);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<EnhancementResult | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const job = useRef<string | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);

  const targets = (adjustments.masks || []).flatMap((mask) =>
    mask.subMasks.map((sub, index) => ({
      key: `${mask.id}:${sub.id}`,
      maskId: String(mask.id),
      subMaskId: String(sub.id),
      name: `${mask.name || label('mask', 'Mask')} · ${index + 1}`,
    })),
  );
  const activeKey = `${activeMaskContainerId}:${activeMaskId}`;
  const selectedTarget =
    targets.find((target) => target.key === targetKey) ||
    targets.find((target) => target.key === activeKey) ||
    targets[0];
  const modelId = operation === 'refine_mask' ? 'matting' : operation === 'semantic_mask' ? domain : operation;
  const selectedModel = models.find((model) => model.id === modelId);
  const isRestoration = operation === 'deblur' || operation === 'upscale';
  const busy = running || installing !== null;

  useEffect(() => {
    if (provider === 'coreml' && !selectedModel?.coreml_supported) setProvider('auto');
  }, [provider, selectedModel?.coreml_supported]);

  const refreshModels = async () => {
    const response = await invoke<{ models: ModelStatus[]; providers: string[] }>('enhancement_models');
    if (mounted.current) {
      setModels(response.models);
      setAvailableProviders(response.providers);
      setModelsLoaded(true);
    }
  };

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void refreshModels().catch((cause) => {
      if (!disposed) setError(String(cause));
    });
    void listen<{ request_id: string; fraction: number }>('enhancement-progress', (event) => {
      if (!disposed && event.payload.request_id === job.current) {
        setFraction(Math.max(0, Math.min(1, event.payload.fraction)));
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
      })
      .catch((cause) => {
        if (!disposed) setError(String(cause));
      });
    return () => {
      disposed = true;
      mounted.current = false;
      unsubscribe?.();
      cancelled.current = true;
      if (job.current) void invoke('cancel_enhancement', { requestId: job.current }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    setResult(null);
    setNotice('');
    setError('');
    setTargetKey('');
    setUseRegion(false);
    if (job.current) {
      cancelled.current = true;
      void invoke('cancel_enhancement', { requestId: job.current }).catch(() => {});
    }
  }, [selectedImage?.path]);

  const install = async (model: ModelStatus) => {
    setError('');
    setInstalling(model.id);
    try {
      let path: string | undefined;
      if (!model.download_available) {
        const selection = await open({
          multiple: false,
          directory: false,
          filters: [{ name: 'ONNX', extensions: ['onnx'] }],
        });
        if (typeof selection !== 'string') return;
        path = selection;
      }
      await invoke('install_enhancement_model', { modelId: model.id, path });
      await refreshModels();
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      if (mounted.current) setInstalling(null);
    }
  };

  const run = async () => {
    const snapshot = useEditorStore.getState();
    if (!snapshot.selectedImage || job.current) return;
    const sourcePath = snapshot.selectedImage.path;
    const serialized = JSON.stringify(snapshot.adjustments);
    let bounds: number[] | undefined;
    if (useRegion && (isRestoration || (operation === 'semantic_mask' && domain === 'face'))) {
      bounds = region.map(Number);
      if (
        region.some((value) => value.trim() === '') ||
        bounds.some((value) => !Number.isSafeInteger(value) || value < 0) ||
        bounds[2] === 0 ||
        bounds[3] === 0
      ) {
        setError(label('invalidRegion', 'Enter a valid area: X, Y, width and height in pixels.'));
        return;
      }
    }
    const requestId = uuidv4();
    job.current = requestId;
    cancelled.current = false;
    setRunning(true);
    setCancelling(false);
    setFraction(0);
    setError('');
    setNotice('');
    setResult(null);
    try {
      const response = await invoke<EnhancementResult>('run_enhancement', {
        requestId,
        path: sourcePath,
        jsAdjustments: JSON.parse(serialized),
        request: {
          operation,
          profile,
          provider,
          domain,
          classes: operation === 'semantic_mask' ? classes : [],
          strength: strength / 100,
          confidence: confidence / 100,
          boundary_radius: radius,
          region: bounds,
        },
        maskId: operation === 'refine_mask' ? selectedTarget?.maskId : undefined,
        subMaskId: operation === 'refine_mask' ? selectedTarget?.subMaskId : undefined,
      });
      if (!mounted.current || cancelled.current) return;
      const current = useEditorStore.getState();
      if (current.selectedImage?.path !== sourcePath) return;
      setResult(response);
      setShowBefore(false);
      if (response.adjustments) {
        if (JSON.stringify(current.adjustments) !== serialized) {
          setNotice(
            label(
              'concurrentEdit',
              'The photo changed while processing. The result is shown below; run again to apply it to your current edit.',
            ),
          );
          return;
        }
        debouncedSetHistory.flush();
        const existingMaskIds = new Set(snapshot.adjustments.masks.map((mask) => mask.id));
        setAdjustments({
          ...response.adjustments,
          masks: response.adjustments.masks.map((mask) =>
            existingMaskIds.has(mask.id)
              ? mask
              : {
                  ...mask,
                  adjustments: { ...structuredClone(INITIAL_MASK_ADJUSTMENTS), ...mask.adjustments },
                },
          ),
        });
        debouncedSetHistory.flush();
        useEditorStore.getState().setEditor({
          activeLocalEditKind: 'adjustment',
          activeMaskContainerId: response.mask_id || null,
          activeMaskId: response.sub_mask_id || null,
          activeAiPatchContainerId: null,
          activeAiSubMaskId: null,
        });
        useUIStore.getState().setPanel(Panel.Masks);
        setNotice(label('maskApplied', 'Mask saved. Use local adjustments to edit the selected area.'));
      } else {
        setNotice(label('imageSaved', 'A separate 16-bit TIFF is ready, with your current edits included.'));
      }
    } catch (cause) {
      if (mounted.current && !cancelled.current) setError(String(cause));
    } finally {
      job.current = null;
      if (mounted.current) {
        setRunning(false);
        setCancelling(false);
      }
    }
  };

  const cancel = async () => {
    if (!job.current) return;
    cancelled.current = true;
    setCancelling(true);
    try {
      await invoke('cancel_enhancement', { requestId: job.current });
    } catch (cause) {
      setError(String(cause));
    }
  };

  return (
    <section
      className="mb-4 shrink-0 rounded-lg border border-border-color bg-surface"
      aria-label={label('title', 'Photo enhancement')}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left text-sm font-semibold"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Sparkles size={16} aria-hidden="true" />
        {label('title', 'Photo enhancement')}
        <span className="ml-auto text-text-secondary" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-border-color p-3">
          <p className="text-xs text-text-secondary">
            {label('intro', 'Refine selections and restore photographic detail on this computer.')}
          </p>
          <label className="block space-y-1 text-xs">
            {label('operation', 'Enhancement')}
            <select
              className={fieldClass}
              value={operation}
              disabled={busy}
              onChange={(event) => {
                setOperation(event.target.value as Operation);
                setUseRegion(false);
                setResult(null);
                setNotice('');
              }}
            >
              <option value="refine_mask">{label('refineMask', 'Refine mask edges')}</option>
              <option value="semantic_mask">{label('semanticMask', 'Select photo elements')}</option>
              <option value="deblur">{label('deblur', 'Reduce blur · experimental')}</option>
              <option value="upscale">{label('upscale', 'Super resolution · 2×')}</option>
            </select>
          </label>
          {operation === 'refine_mask' && (
            <label className="block space-y-1 text-xs">
              {label('selection', 'Selection to refine')}
              <select
                className={fieldClass}
                value={selectedTarget?.key || ''}
                disabled={busy || targets.length === 0}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                {targets.length === 0 && <option value="">{label('createMask', 'Create a local mask first')}</option>}
                {targets.map((target) => (
                  <option key={target.key} value={target.key}>
                    {target.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {operation === 'semantic_mask' && (
            <>
              <label className="block space-y-1 text-xs">
                {label('domain', 'Photo elements')}
                <select
                  className={fieldClass}
                  disabled={busy}
                  value={domain}
                  onChange={(event) => {
                    const next = event.target.value as Domain;
                    setDomain(next);
                    setClasses([next === 'face' ? 'skin' : 'vegetation']);
                  }}
                >
                  <option value="landscape">{label('landscape', 'Landscape and subjects')}</option>
                  <option value="face">{label('face', 'Face and hair')}</option>
                </select>
              </label>
              <fieldset className="grid grid-cols-2 gap-2" disabled={busy}>
                <legend className="mb-2 text-xs">{label('selectElements', 'Include in the mask')}</legend>
                {(domain === 'face' ? FACE : LANDSCAPE).map((category) => (
                  <label key={category} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={classes.includes(category)}
                      onChange={(event) =>
                        setClasses((previous) =>
                          event.target.checked ? [...previous, category] : previous.filter((item) => item !== category),
                        )
                      }
                    />
                    {label(`categories.${category}`, category.charAt(0).toUpperCase() + category.slice(1))}
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {operation !== 'semantic_mask' && (
            <fieldset disabled={busy}>
              <legend className="mb-1 text-xs">{label('performance', 'Performance')}</legend>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-bg-primary p-1">
                {(['fast', 'balanced', 'quality'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={profile === value}
                    className={`rounded px-1 py-2 text-xs ${profile === value ? 'bg-accent text-button-text' : 'text-text-secondary hover:bg-card-active'}`}
                    onClick={() => setProfile(value)}
                  >
                    {label(
                      `profiles.${value}`,
                      value === 'fast' ? 'Fast' : value === 'balanced' ? 'Balanced' : 'Quality',
                    )}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-text-secondary">
                {label('profileHint', 'Fast uses less memory. Quality uses more context and may take longer.')}
              </p>
            </fieldset>
          )}
          {isRestoration && (
            <label className="block text-xs">
              {label('strength', 'Strength')} <span className="float-right">{strength}%</span>
              <input
                className="mt-2 w-full accent-accent"
                type="range"
                min="0"
                max="100"
                value={strength}
                disabled={busy}
                onChange={(event) => setStrength(Number(event.target.value))}
              />
              <span className="text-text-secondary">
                {label('strengthHint', 'Start gently and inspect fine texture at full size.')}
              </span>
            </label>
          )}
          {operation === 'deblur' && (
            <p className="text-xs text-text-secondary">
              {label(
                'deblurHint',
                'For mild motion blur. Denoise noisy photos first; unstable results are stopped automatically. Review fine detail before using the result.',
              )}
            </p>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer py-1 text-text-secondary">
              {label('advanced', 'Advanced options')}
            </summary>
            <div className="mt-2 space-y-3">
              <label className="block space-y-1">
                {label('processor', 'Processor')}
                <select
                  className={fieldClass}
                  value={provider}
                  disabled={busy}
                  onChange={(event) => setProvider(event.target.value as Provider)}
                >
                  <option value="auto">{label('automatic', 'Automatic')}</option>
                  <option value="cpu">CPU</option>
                  <option
                    value="coreml"
                    disabled={!selectedModel?.coreml_supported || !availableProviders.includes('coreml')}
                  >
                    {label('coreml', 'Apple Core ML')}
                  </option>
                  <option value="cuda" disabled={!availableProviders.includes('cuda')}>
                    {label('cuda', 'NVIDIA CUDA')}
                  </option>
                </select>
              </label>
              {operation === 'refine_mask' && (
                <label className="block space-y-1">
                  {label('edgeWidth', 'Boundary width (pixels)')}
                  <input
                    className={fieldClass}
                    type="number"
                    min="1"
                    max="256"
                    value={radius}
                    disabled={busy}
                    onChange={(event) => setRadius(Number(event.target.value))}
                  />
                </label>
              )}
              {operation === 'semantic_mask' && (
                <label className="block">
                  {label('confidence', 'Selection confidence')} <span className="float-right">{confidence}%</span>
                  <input
                    className="mt-2 w-full accent-accent"
                    type="range"
                    min="0"
                    max="100"
                    value={confidence}
                    disabled={busy}
                    onChange={(event) => setConfidence(Number(event.target.value))}
                  />
                </label>
              )}
              {(isRestoration || (operation === 'semantic_mask' && domain === 'face')) && (
                <>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={useRegion}
                      disabled={busy}
                      onChange={(event) => setUseRegion(event.target.checked)}
                    />
                    {isRestoration
                      ? label('useImageRegion', 'Process a smaller area')
                      : label('useFaceRegion', 'Limit to a face area')}
                  </label>
                  {useRegion && (
                    <>
                      <p className="text-text-secondary">
                        {isRestoration
                          ? label(
                              'imageRegionHint',
                              'Enter bounds in the current edited photo, in pixels. The saved image will contain only this area. You can also crop in the editor before running enhancement.',
                            )
                          : label(
                              'faceRegionHint',
                              'Use the face bounds in the full, oriented photo. Useful for small faces or selecting one person.',
                            )}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {['X', 'Y', 'Width', 'Height'].map((name, index) => (
                          <label key={name} className="block space-y-1">
                            {label(`region.${name.toLowerCase()}`, name)}
                            <input
                              className={fieldClass}
                              type="number"
                              min={index < 2 ? 0 : 1}
                              step="1"
                              value={region[index]}
                              disabled={busy}
                              onChange={(event) =>
                                setRegion((previous) =>
                                  previous.map((value, at) => (at === index ? event.target.value : value)),
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </details>
          {selectedModel && !selectedModel.ready && (
            <div className="space-y-2 rounded-md bg-bg-primary p-2 text-xs">
              <p>
                {selectedModel.name} · {label('setupNeeded', 'One-time setup needed')}
              </p>
              {!selectedModel.download_available && (
                <p className="text-text-secondary">
                  {label(
                    'importHint',
                    'Import the ONNX model prepared with the repository’s enhancement exporter. See the AI enhancement guide for setup.',
                  )}
                </p>
              )}
              <Button className="w-full text-xs" disabled={busy} onClick={() => void install(selectedModel)}>
                {installing === modelId ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {installing === modelId
                  ? label('installing', 'Installing…')
                  : selectedModel.download_available
                    ? label('downloadModel', 'Download model')
                    : label('importModel', 'Import model')}
              </Button>
            </div>
          )}
          {running ? (
            <div className="space-y-2">
              <progress
                className="h-2 w-full"
                max="1"
                value={fraction}
                aria-label={label('progress', 'Enhancement progress')}
              />
              <Button
                className="w-full bg-surface text-xs text-text-primary"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                <X size={14} />
                {cancelling ? label('cancelling', 'Cancelling after the current step…') : label('cancel', 'Cancel')}
              </Button>
            </div>
          ) : (
            <Button
              className="w-full text-sm"
              disabled={
                busy ||
                otherJobRunning ||
                !selectedImage?.isReady ||
                !selectedModel?.ready ||
                (operation === 'refine_mask' && !selectedTarget) ||
                (operation === 'semantic_mask' && classes.length === 0)
              }
              onClick={() => void run()}
            >
              <Sparkles size={15} />
              {isRestoration
                ? label('createImage', 'Create enhanced image')
                : operation === 'refine_mask'
                  ? label('refineSelectedMask', 'Refine selected mask')
                  : label('createSelection', 'Create selection')}
            </Button>
          )}
          {!modelsLoaded && !error && (
            <p className="text-xs text-text-secondary">{label('loadingModels', 'Checking available models…')}</p>
          )}
          {error && (
            <p role="alert" className="break-words text-xs text-red-400">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-xs text-text-secondary">
              {notice}
            </p>
          )}
          {result && (
            <div className="space-y-2">
              {result.receipt.warnings?.map((warning, index) => (
                <p
                  key={index}
                  role="status"
                  className="rounded-md border border-border-color p-2 text-xs text-text-primary"
                >
                  {warning}
                </p>
              ))}
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  aria-pressed={showBefore}
                  className={`rounded p-2 text-xs ${showBefore ? 'bg-card-active' : ''}`}
                  onClick={() => setShowBefore(true)}
                >
                  {label('before', 'Before')}
                </button>
                <button
                  type="button"
                  aria-pressed={!showBefore}
                  className={`rounded p-2 text-xs ${!showBefore ? 'bg-card-active' : ''}`}
                  onClick={() => setShowBefore(false)}
                >
                  {label('result', 'Result')}
                </button>
              </div>
              <img
                src={showBefore ? result.before_preview : result.preview}
                alt={
                  showBefore ? label('beforeAlt', 'Photo before enhancement') : label('resultAlt', 'Enhancement result')
                }
                className="w-full rounded-md bg-black object-contain"
              />
              {result.receipt.output_dimensions && (
                <p className="text-xs text-text-secondary">
                  {t('editor.enhancement.resultMetrics', {
                    defaultValue: '{{dimensions}} px · {{seconds}} s',
                    dimensions: result.receipt.output_dimensions.join(' × '),
                    seconds: ((result.receipt.total_ms ?? result.receipt.elapsed_ms ?? 0) / 1000).toFixed(1),
                  })}
                </p>
              )}
              {result.result_path && (
                <Button
                  className="w-full bg-surface text-xs text-text-primary"
                  onClick={() =>
                    void invoke(Invokes.ShowInFinder, { path: result.result_path }).catch((cause) =>
                      setError(String(cause)),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  {label('showSavedImage', 'Show saved image')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
