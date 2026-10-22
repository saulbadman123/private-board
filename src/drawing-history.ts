// Stroke-level undo/redo for a drawing draft. Strokes are kept as their points, not as bitmaps, and
// replayed over a baseline. When the history grows past its budget the oldest strokes are painted into
// the baseline (a single extra canvas), so artwork is never lost, only the ability to undo that far back.
export type Stroke = { color: string; size: number; points: number[] };   // x0,y0,x1,y1,... in bitmap pixels; the eraser paints white
export type Op = Stroke | 'clear';
export type Renderer = { blank(): HTMLCanvasElement; paint(target: HTMLCanvasElement, op: Op): void };
export const MAX_OPS = 120;
export const MAX_POINTS = 60_000;
const weight = (op: Op) => op === 'clear' ? 1 : op.points.length / 2;

export class DrawingHistory {
  ops: Op[] = [];
  redone: Op[] = [];
  // Artwork as it was before ops[0]; null means blank paper.
  baseline: HTMLCanvasElement | null = null;
  baselineInk = false;
  private points = 0;
  canUndo(): boolean { return this.ops.length > 0; }
  canRedo(): boolean { return this.redone.length > 0; }
  push(op: Op) { this.ops.push(op); this.redone = []; this.points += weight(op); }
  undo(): boolean {
    const op = this.ops.pop();
    if (op === undefined) return false;
    this.points -= weight(op); this.redone.push(op);
    return true;
  }
  redo(): boolean {
    const op = this.redone.pop();
    if (op === undefined) return false;
    this.ops.push(op); this.points += weight(op);
    return true;
  }
  // Anything drawn since the last Clear, including erasing, counts as ink: it can be posted.
  hasInk(): boolean {
    const last = this.ops.at(-1);
    return last === undefined ? this.baselineInk : last !== 'clear';
  }
  overBudget(): boolean { return this.ops.length > MAX_OPS || this.points > MAX_POINTS; }
  // Bake the oldest operations into the baseline until the history fits again.
  trim(renderer: Renderer) {
    while (this.overBudget() && this.ops.length) {
      const op = this.ops.shift()!;
      this.baseline ??= renderer.blank();
      renderer.paint(this.baseline, op);
      this.points -= weight(op);
      this.baselineInk = op !== 'clear';
    }
  }
  reset() { this.ops = []; this.redone = []; this.baseline = null; this.baselineInk = false; this.points = 0; }
}
