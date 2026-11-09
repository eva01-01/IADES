import { segmentForeground } from './background-removal';
import { applyForegroundMask, blobToDataUrl, maskToBlob } from './mask-image';
import { storeAsset } from './api';

type StoredAsset = { id: string; src: string; sourceName: string; sourceUrl?: string; width: number; height: number };
export type PreparedImageAsset = Omit<StoredAsset, 'id'> & { id?: string; originalSrc?: string; maskSrc?: string; cutoutWarning?: string };

async function imageDimensions(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}

async function segmentImage(blob: Blob) {
  const dimensions = await imageDimensions(blob);
  const segmentation = await segmentForeground(blob, 'universal');
  const [transparent, mask] = await Promise.all([
    applyForegroundMask(blob, segmentation),
    maskToBlob(segmentation.mask, segmentation.width, segmentation.height),
  ]);
  return { dimensions, transparent, mask, maskWidth: segmentation.width, maskHeight: segmentation.height };
}

export async function prepareImportedImage(projectId: string, blob: Blob, name: string, sourceName = name) {
  const dimensions = await imageDimensions(blob);
  let cutout: Awaited<ReturnType<typeof segmentImage>> | undefined;
  let cutoutWarning: string | undefined;
  try {
    cutout = await segmentImage(blob);
  } catch (error) {
    cutoutWarning = error instanceof Error ? error.message : 'Automatic background removal failed.';
  }
  const original = await storeAsset({ projectId, name: `${name}-original`, dataUrl: await blobToDataUrl(blob), width: dimensions.width, height: dimensions.height, sourceName });
  if (!cutout) return { ...original, width: dimensions.width, height: dimensions.height, cutoutWarning } satisfies PreparedImageAsset;
  try {
    const [transparent, mask] = await Promise.all([
      storeAsset({ projectId, name: `${name}-cutout.png`, dataUrl: await blobToDataUrl(cutout.transparent), width: dimensions.width, height: dimensions.height, sourceName }),
      storeAsset({ projectId, name: `${name}-mask.png`, dataUrl: await blobToDataUrl(cutout.mask), width: cutout.maskWidth, height: cutout.maskHeight, sourceName: `${sourceName} mask` }),
    ]);
    return { ...transparent, width: dimensions.width, height: dimensions.height, originalSrc: original.src, maskSrc: mask.src } satisfies PreparedImageAsset;
  } catch (error) {
    return { ...original, width: dimensions.width, height: dimensions.height, cutoutWarning: error instanceof Error ? error.message : 'Unable to save the automatic background removal.' } satisfies PreparedImageAsset;
  }
}

export async function prepareGeneratedImage(projectId: string, original: Omit<StoredAsset, 'id'> & Partial<Pick<StoredAsset, 'id'>>): Promise<PreparedImageAsset> {
  try {
    const response = await fetch(original.src);
    if (!response.ok) throw new Error('The generated image could not be loaded for background removal.');
    const blob = await response.blob();
    const cutout = await segmentImage(blob);
    const [transparent, mask] = await Promise.all([
      storeAsset({ projectId, name: `${original.sourceName}-cutout.png`, dataUrl: await blobToDataUrl(cutout.transparent), width: cutout.dimensions.width, height: cutout.dimensions.height, sourceName: original.sourceName }),
      storeAsset({ projectId, name: `${original.sourceName}-mask.png`, dataUrl: await blobToDataUrl(cutout.mask), width: cutout.maskWidth, height: cutout.maskHeight, sourceName: `${original.sourceName} mask` }),
    ]);
    return { ...transparent, width: cutout.dimensions.width, height: cutout.dimensions.height, originalSrc: original.src, maskSrc: mask.src };
  } catch (error) {
    return { ...original, cutoutWarning: error instanceof Error ? error.message : 'Automatic background removal failed.' };
  }
}
