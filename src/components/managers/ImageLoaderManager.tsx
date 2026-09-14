import { useImageLoader } from '../../hooks/useImageLoader';

interface Props {
  cachedEditStateRef: Parameters<typeof useImageLoader>[0];
}

export default function ImageLoaderManager({ cachedEditStateRef }: Props) {
  useImageLoader(cachedEditStateRef);

  return null;
}
