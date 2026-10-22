import { createStage } from './stage.ts';
import { setOthersInert } from './inert.ts';

type Options = { container: HTMLElement; image: HTMLImageElement; width: number; height: number; label: string; closed: () => void };
// Full-screen view of a posted drawing with Fit, 100%, and zoom. The picture moves into the viewer and back, so it is
// not downloaded again. The viewer lives inside the board container, so concealing the board conceals it too.
export function openDrawingViewer({ container, image, width, height, label, closed }: Options): () => void {
  const doc = container.ownerDocument, home = image.parentElement!, next = image.nextSibling;
  const viewer = doc.createElement('div');
  viewer.className = 'viewer'; viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', 'Drawing viewer');
  viewer.innerHTML = '<div class="viewer-bar"><span class="viewer-title"></span><div class="draw-zoom" role="group" aria-label="Zoom"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="fit">Fit</button><button type="button" data-zoom="actual">100%</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button><output class="zoom-level" aria-label="Zoom level"></output></div><button type="button" class="viewer-close">Close</button></div><div class="viewer-stage canvas-stage"></div>';
  viewer.querySelector<HTMLElement>('.viewer-title')!.textContent = label;
  const stageElement = viewer.querySelector<HTMLElement>('.viewer-stage')!, level = viewer.querySelector<HTMLOutputElement>('.zoom-level')!, closeButton = viewer.querySelector<HTMLButtonElement>('.viewer-close')!;
  stageElement.append(image);
  container.append(viewer);
  const stage = createStage({
    stage: stageElement, content: image, size: () => ({ width, height }),
    box: () => ({ width: stageElement.clientWidth, height: stageElement.clientHeight }),
    changed: () => { level.textContent = stage.label(); }
  });
  viewer.querySelector('[data-zoom=out]')!.addEventListener('click', () => stage.zoomOut());
  viewer.querySelector('[data-zoom=in]')!.addEventListener('click', () => stage.zoomIn());
  viewer.querySelector('[data-zoom=fit]')!.addEventListener('click', () => stage.fit());
  viewer.querySelector('[data-zoom=actual]')!.addEventListener('click', () => stage.actual());
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
  const onResize = () => stage.refit();
  doc.addEventListener('keydown', onKey); doc.defaultView?.addEventListener('resize', onResize);
  doc.documentElement.classList.add('drawing-expanded');
  setOthersInert(viewer, true);
  stage.fit(); closeButton.focus();
  let open = true;
  function close() {
    if (!open) return;
    open = false;
    doc.removeEventListener('keydown', onKey); doc.defaultView?.removeEventListener('resize', onResize);
    stage.dispose();
    image.style.width = ''; image.style.height = '';
    home.insertBefore(image, next && next.parentNode === home ? next : null);
    doc.documentElement.classList.remove('drawing-expanded');
    setOthersInert(viewer, false); viewer.remove();
    closed();
  }
  closeButton.addEventListener('click', close);
  return close;
}
