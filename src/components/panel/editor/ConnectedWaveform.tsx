import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../../store/useEditorStore';
import { Adjustments } from '../../../utils/adjustments';
import Waveform from './Waveform';

interface ConnectedWaveformProps {
  setDisplayMode(mode: string): void;
  setAdjustments(value: (prev: Adjustments) => Adjustments): void;
  theme?: string;
}

export default function ConnectedWaveform({ setDisplayMode, setAdjustments, theme }: ConnectedWaveformProps) {
  const { hasWaveform, hasHistogram, activeWaveformChannel, showClipping } = useEditorStore(
    useShallow((state) => ({
      hasWaveform: !!state.waveform,
      hasHistogram: !!state.histogram?.red,
      activeWaveformChannel: state.activeWaveformChannel,
      showClipping: state.showClipping,
    })),
  );

  const onToggleClipping = useCallback(() => {
    useEditorStore.getState().setEditor((state) => ({ showClipping: !state.showClipping }));
  }, [setAdjustments]);

  return (
    <Waveform
      hasWaveform={hasWaveform}
      hasHistogram={hasHistogram}
      displayMode={activeWaveformChannel || 'luma'}
      setDisplayMode={setDisplayMode}
      showClipping={showClipping}
      onToggleClipping={onToggleClipping}
      theme={theme}
    />
  );
}
