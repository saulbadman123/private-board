// Paper sizes and upload limits shared by the browser and the server, so they cannot drift apart.
// Standard is the original paper. Large needs migration 202610220001_large_drawings.sql.
export const PAPER_SIZES = {
  standard: { width: 1024, height: 768, label: 'Standard' },
  large: { width: 1600, height: 1200, label: 'Large' }
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;
export const MAX_DRAWING_WIDTH = 1600;
export const MAX_DRAWING_HEIGHT = 1200;
export const MAX_DRAWING_PIXELS = MAX_DRAWING_WIDTH * MAX_DRAWING_HEIGHT;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
// Brush sizes are chosen relative to Standard paper and scale with the paper, so Fine/Medium/Broad look the same on both.
export const BRUSH_REFERENCE_WIDTH = PAPER_SIZES.standard.width;
export function paperFor(width: number, height: number): PaperSize {
  return width === PAPER_SIZES.large.width && height === PAPER_SIZES.large.height ? 'large' : 'standard';
}
