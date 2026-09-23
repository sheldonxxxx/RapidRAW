export function maskOverlayForEditing<T extends { visible: boolean }>(mask: T, isAiEdit: boolean): T {
  return isAiEdit && !mask.visible ? { ...mask, visible: true } : mask;
}
