import type { RowComponentProps } from 'react-window';
import type { ImageFile, ThumbnailAspectRatio } from '../../ui/AppProperties';
import type { ColumnWidths, MainLibraryProps } from '../MainLibrary';
import type { GroupBadgeInfo, GroupId } from '../../../utils/imageGrouping';

export interface ImageRow {
  type: 'images';
  images: ImageFile[];
  startIndex?: number;
  rowHeight?: number;
  justifiedWidths?: number[];
}
export type LibraryRow =
  ImageRow | { type: 'header'; path: string; count: number; isExpanded: boolean } | { type: 'footer' };

export interface ThumbnailProps {
  isActive: boolean;
  isSelected: boolean;
  isForcedHover?: boolean;
  onContextMenu: MainLibraryProps['onContextMenu'];
  onImageClick: MainLibraryProps['onImageClick'];
  onImageDoubleClick: MainLibraryProps['onImageDoubleClick'];
  onLoad(path: string): void;
  path: string;
  rating: number;
  tags: ImageFile['tags'];
  aspectRatio: ThumbnailAspectRatio;
  isEdited?: boolean;
  exif: ImageFile['exif'];
  isCloudPlaceholder: boolean;
  groupBadgeLabel?: string | null;
  onAspectRatioLoaded?(path: string, ratio: number): void;
}

export interface ListItemProps extends ThumbnailProps {
  modified: number;
  columnWidths: ColumnWidths;
  isPrevSelected: boolean;
  isNextSelected: boolean;
}

export interface LibraryRowData {
  rows: LibraryRow[];
  activePath: string | null;
  multiSelectedSet: Set<string>;
  onContextMenu: MainLibraryProps['onContextMenu'];
  onImageClick: MainLibraryProps['onImageClick'];
  onImageDoubleClick: MainLibraryProps['onImageDoubleClick'];
  thumbnailAspectRatio: ThumbnailAspectRatio;
  onImageLoad(path: string): void;
  imageRatings: Record<string, number>;
  baseFolderPath: string | null;
  itemWidth: number;
  itemHeight: number;
  outerPadding: number;
  gap: number;
  isListView: boolean;
  columnWidths: ColumnWidths;
  queueThumbnailRequest(path: string): void;
  onToggleRecursiveFolder(path: string): void;
  groupBadgeInfo: Map<GroupId, GroupBadgeInfo> | null;
  onAspectRatioLoaded(path: string, ratio: number): void;
}

export type LibraryRowProps = RowComponentProps<LibraryRowData>;
