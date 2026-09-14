/** Report-only families. Grouped requirements retain independent evidence and never share credit. */
export function classifyRequirement(id) {
  const separator = id.indexOf(':'),
    kind = id.slice(0, separator),
    path = id.slice(separator + 1);
  if (kind === 'tool') return { kind, family: `tool:${path}`, context: 'public tool', purpose: 'tool execution' };
  if (kind === 'parameter') {
    const method = path.split('.')[0];
    if (method === 'batch_export' && path.startsWith('batch_export.options.'))
      return {
        kind,
        family: 'delivery-options',
        context: 'batch forwarding',
        purpose: 'shared implementation; forwarding needs its own checks',
      };
    if (method === 'export')
      return { kind, family: 'delivery-options', context: 'single export', purpose: 'delivery behavior' };
    return {
      kind,
      family: `tool-input:${method}`,
      context: 'direct tool input',
      purpose: /\.expected_revision(?:=|$)/.test(path) ? 'revision contract' : 'input behavior',
    };
  }
  if (kind !== 'adjustment') return { kind, family: 'unclassified', context: path, purpose: 'unclassified' };
  const local = path.startsWith('masks[].adjustments.');
  const component = path.match(/^(masks|aiPatches)\[\]\.subMasks\[\]<([^>]+)>\.(.*)$/);
  if (component)
    return {
      kind,
      family: `submask:${component[2]}`,
      context: component[1] === 'masks' ? 'local mask component' : 'retouch patch component',
      purpose: /^(id|name|type)(?:=|$)/.test(component[3]) ? 'identity and persistence' : 'mask rendering',
      shared_schema: true,
    };
  const control = (local ? path.slice('masks[].adjustments.'.length) : path).split(/[.=]/)[0];
  const context = local
    ? 'local adjustment'
    : /^(masks|aiPatches)\[\]/.test(path)
      ? 'composite container'
      : 'global adjustment';
  let purpose = 'rendering behavior';
  if (control === 'sectionVisibility') purpose = 'rendering enable/disable';
  else if (['lutData', 'lutName', 'lutSize', 'aspectRatio'].includes(control))
    purpose = 'recipe metadata and editing intent';
  else if (/^(masks|aiPatches)\[\]\.(id|name|prompt|isLoading)(?:=|$)/.test(path)) purpose = 'identity and persistence';
  return { kind, family: `adjustment:${control}`, context, purpose, ...(local ? { shared_schema: true } : {}) };
}

export function summarizeGroups(requirements) {
  const groups = new Map();
  for (const row of requirements) {
    const { family } = row.classification;
    if (!groups.has(family))
      groups.set(family, {
        family,
        required: 0,
        without_evidence: 0,
        direct_input: 0,
        derived_state: 0,
        pixel_assertion: 0,
        contexts: new Set(),
      });
    const group = groups.get(family);
    group.required++;
    group.contexts.add(row.classification.context);
    if (!row.levels.length) group.without_evidence++;
    if (row.evidence_by_basis.direct_input.length) group.direct_input++;
    if (row.evidence_by_basis.derived_state.length) group.derived_state++;
    if (row.levels.includes('pixel_assertion')) group.pixel_assertion++;
  }
  return [...groups.values()]
    .map((group) => ({ ...group, contexts: [...group.contexts].sort() }))
    .sort((a, b) => b.without_evidence - a.without_evidence || a.family.localeCompare(b.family));
}
