import { useMemo } from 'react';
import { ToolVisibilityContext } from '../../context/ToolVisibilityContext';
import { ActiveTools } from '../../utils/adjustments';
import BasicAdjustments from './Basic';
import ColorPanel from './Color';
import CurveGraph from './Curves';
import DetailsPanel from './Details';
import EffectsPanel from './Effects';

const SECTION_COMPONENTS: Record<string, import('react').ElementType> = {
  basic: BasicAdjustments,
  curves: CurveGraph,
  color: ColorPanel,
  details: DetailsPanel,
  effects: EffectsPanel,
};

interface AdjustmentSectionProps {
  sectionName: string;
  activeTools: ActiveTools;
  onToggleTool(id: string): void;
  [key: string]: unknown;
}

export default function AdjustmentSection({
  sectionName,
  activeTools,
  onToggleTool,
  ...sectionProps
}: AdjustmentSectionProps) {
  const contextValue = useMemo(
    () => ({ activeTools, onToggleTool, section: sectionName }),
    [activeTools, onToggleTool, sectionName],
  );
  const SectionComponent = SECTION_COMPONENTS[sectionName];

  return (
    <ToolVisibilityContext.Provider value={contextValue}>
      <SectionComponent {...sectionProps} />
    </ToolVisibilityContext.Provider>
  );
}
