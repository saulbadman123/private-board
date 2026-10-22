// Zoom and pan for a picture (the drawing canvas, or a posted drawing) inside a scrollable box.
// Zoom only changes how large the picture is shown in CSS pixels; the bitmap is never resized or resampled.
export type Size = { width: number; height: number };
export type StageOptions = {
  stage: HTMLElement;                 // the scroll container
  content: HTMLElement;               // the canvas or image; sized here
  size: () => Size;                   // bitmap size; may change when the paper does
  box: () => Size;                    // room available for the whole picture, in CSS pixels
  changed?: () => void;
};
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 1.25;
// Fit may enlarge a small picture on a big screen, but not past this; beyond it strokes turn visibly soft.
const MAX_FIT = 2;
export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
export function fitZoom(bitmap: Size, box: Size): number {
  if (!(bitmap.width > 0 && bitmap.height > 0 && box.width > 0 && box.height > 0)) return 1;
  return clampZoom(Math.min(box.width / bitmap.width, box.height / bitmap.height, MAX_FIT));
}

export function createStage({ stage, content, size, box, changed }: StageOptions) {
  let zoom = 1, fitting = true;
  function apply() {
    const bitmap = size();
    content.style.width = `${Math.round(bitmap.width * zoom)}px`;
    content.style.height = `${Math.round(bitmap.height * zoom)}px`;
    changed?.();
  }
  function fit() {
    fitting = true; zoom = fitZoom(size(), box()); apply();
    stage.scrollLeft = 0; stage.scrollTop = 0;
  }
  // Keep the point of the picture under `anchor` (client coordinates; default the middle of the view) where it is.
  function zoomTo(next: number, anchor?: { x: number; y: number }) {
    next = clampZoom(next);
    if (next === zoom && !fitting) return;
    const view = stage.getBoundingClientRect();
    const ax = anchor?.x ?? view.left + stage.clientWidth / 2, ay = anchor?.y ?? view.top + stage.clientHeight / 2;
    const before = content.getBoundingClientRect();
    const bx = (ax - before.left) / zoom, by = (ay - before.top) / zoom;
    fitting = false; zoom = next; apply();
    const after = content.getBoundingClientRect();
    stage.scrollLeft += after.left + bx * zoom - ax; stage.scrollTop += after.top + by * zoom - ay;
  }
  // Ctrl/Cmd + wheel (also what a trackpad pinch sends) zooms around the pointer.
  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomTo(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX, y: event.clientY });
  }
  stage.addEventListener('wheel', onWheel, { passive: false });
  return {
    get zoom() { return zoom; },
    get fitting() { return fitting; },
    label: () => `${Math.round(zoom * 100)}%`,
    fit,
    // Re-fit after the room changes (resize, Expand), but never undo a zoom the user chose.
    refit() { if (fitting) fit(); },
    // The paper changed size: keep the current mode, but re-apply so the picture matches the new bitmap.
    resized() { if (fitting) fit(); else apply(); },
    actual() { zoomTo(1); },
    zoomIn() { zoomTo(zoom * ZOOM_STEP); },
    zoomOut() { zoomTo(zoom / ZOOM_STEP); },
    panBy(dx: number, dy: number) { stage.scrollLeft += dx; stage.scrollTop += dy; },
    dispose() { stage.removeEventListener('wheel', onWheel); }
  };
}
export type Stage = ReturnType<typeof createStage>;
