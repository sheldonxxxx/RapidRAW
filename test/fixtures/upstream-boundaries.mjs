// Transport and React adapters shared by the existing isolated hook fixtures.
export function extendUpstreamBoundaries(stubs) {
  const append = (module, name, declaration) => {
    if (stubs[module] && !new RegExp(`(?:const|function|class|\\{)\\s*${name}\\b`).test(stubs[module])) {
      stubs[module] += '\n' + declaration;
    }
  };
  if (stubs.react) {
    if (!/export default/.test(stubs.react)) stubs.react += '\nexport default {};';
    append('react', 'memo', 'export const memo = component => component;');
    append(
      'react',
      'useState',
      'export const useState = value => [typeof value === "function" ? value() : value, () => {}];',
    );
    append('react', 'useMemo', 'export const useMemo = create => create();');
    append('react', 'useRef', 'export const useRef = current => ({current});');
  }
  if (stubs['@tauri-apps/api/core']) {
    append('@tauri-apps/api/core', 'Channel', 'export class Channel { onmessage = () => {}; }');
  }
  for (const module of ['../store/useProcessStore', '../../../store/useProcessStore']) {
    append(
      module,
      'JobKind',
      'export const JobKind = {ModelDownload:"modelDownload",AiTagging:"aiTagging",Copy:"copy",Move:"move"};',
    );
    append(module, 'JobStatus', 'export const JobStatus = {Success:"success",Error:"error"};');
  }
  for (const module of ['../components/ui/AppProperties', '../../ui/AppProperties']) {
    append(module, 'ImageFlag', 'export const ImageFlag = {Pick:"pick",Reject:"reject"};');
    append(
      module,
      'Invokes',
      'export const Invokes = {GetAiJobsStatus:"get_ai_jobs_status",GetPendingAiPaths:"get_pending_ai_paths",SubscribeAnalytics:"subscribe_analytics"};',
    );
  }
  stubs['react-toastify'] ??= 'export const toast={error(){},info(){},success(){}};';
  for (const module of ['../components/ui/AppProperties', '../../ui/AppProperties']) {
    append(module, 'Panel', 'export const Panel={Crop:"crop",Adjustments:"adjustments"};');
    append(module, 'RawStatus', 'export const RawStatus={All:"all",NonRawOnly:"nonRawOnly",RawOnly:"rawOnly"};');
    append(
      module,
      'EditedStatus',
      'export const EditedStatus={All:"all",EditedOnly:"editedOnly",UneditedOnly:"uneditedOnly"};',
    );
    append(
      module,
      'FlagStatus',
      'export const FlagStatus={All:"all",Picks:"picks",Rejects:"rejects",Unflagged:"unflagged"};',
    );
    append(module, 'SortDirection', 'export const SortDirection={Ascending:"asc",Descending:"desc"};');
  }
  for (const module of ['../components/panel/right/Masks']) {
    append(module, 'ToolType', 'export const ToolType={Brush:"brush",Eraser:"eraser"};');
  }
  stubs['react-i18next'] ??= 'export const useTranslation = () => ({t:(key, options)=>options?.defaultValue ?? key});';
}
