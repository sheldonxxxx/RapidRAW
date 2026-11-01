import type { Adjustments } from './adjustments';
import { preparePreviewAdjustments } from './previewPipeline';

/** Inline assets keep a standalone request independent of cache eviction. */
export const prepareAdjustmentsPayload = (adjustments: Adjustments) => ({
  payload: preparePreviewAdjustments(adjustments, new Set()).payload,
  markSent() {},
});
