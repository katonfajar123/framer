export interface Size {
  width: number;
  height: number;
}

export interface Transform {
  scale: number;
  /** Translation of the image's top-left corner inside the stage, in CSS pixels. */
  x: number;
  y: number;
}

export const MAX_SCALE = 16;
/** Total breathing room (both sides) kept around a fitted photo so it never touches the chrome. */
export const FIT_MARGIN = 48;

/** Scale at which the whole image fits the stage. Small images are never enlarged past 100%. */
export function fitScale(image: Size, stage: Size): number {
  if (!image.width || !image.height || !stage.width || !stage.height) return 1;
  return Math.min(1, (stage.width - FIT_MARGIN) / image.width, (stage.height - FIT_MARGIN) / image.height);
}

/** Keep the image on screen: centred when smaller than the stage, edge-aligned when larger. */
export function clampPan(transform: Transform, image: Size, stage: Size): Transform {
  const scaledWidth = image.width * transform.scale;
  const scaledHeight = image.height * transform.scale;
  const axis = (position: number, scaled: number, available: number) =>
    scaled <= available ? (available - scaled) / 2 : Math.min(0, Math.max(available - scaled, position));
  return {
    scale: transform.scale,
    x: axis(transform.x, scaledWidth, stage.width),
    y: axis(transform.y, scaledHeight, stage.height),
  };
}

/** Change the scale while keeping the image point under `point` (stage coordinates) fixed. */
export function zoomAround(transform: Transform, scale: number, point: { x: number; y: number }, image: Size, stage: Size): Transform {
  const ratio = scale / transform.scale;
  return clampPan(
    {
      scale,
      x: point.x - (point.x - transform.x) * ratio,
      y: point.y - (point.y - transform.y) * ratio,
    },
    image,
    stage,
  );
}
