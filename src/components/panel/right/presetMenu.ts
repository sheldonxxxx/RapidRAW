import { Folder as FolderIcon } from 'lucide-react';
import type { UserPreset } from '../../../hooks/usePresets';
import type { Option, Preset } from '../../ui/AppProperties';

export function buildPresetMenu(items: readonly (UserPreset | Preset)[], onSelect: (preset: Preset) => void): Option[] {
  return items.flatMap((item): Option[] => {
    if ('folder' in item && item.folder) {
      return [{ label: item.folder.name, icon: FolderIcon, submenu: buildPresetMenu(item.folder.children, onSelect) }];
    }
    const preset = 'adjustments' in item ? item : item.preset;
    return preset ? [{ label: preset.name, onClick: () => onSelect(preset) }] : [];
  });
}
