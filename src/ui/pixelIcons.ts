// The rhythms as small pixel drawings, in the same style as the app icon (scripts/make-icons.py):
// notes on a 13-row grid, standing on the same baseline, drawn at 2 px a pixel.

type Cell = [number, number];

const stem = (x: number, y0: number, y1: number): Cell[] => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i]);
const rows = (x: number, y: number, pattern: string[]): Cell[] => pattern.flatMap((r, j) => [...r].flatMap((c, i): Cell[] => (c === "#" ? [[x + i, y + j]] : [])));
const beam = (x0: number, x1: number, y: number): Cell[] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);

const HEAD = [".####", "#####", "####."];
const HOLLOW = [".####", "#...#", "####."];
/** Notes stand 4 rows down, leaving room above for a triplet's 3. */
const TOP = 4;
const quarter = (x: number): Cell[] => [...stem(x + 4, TOP, TOP + 5), ...rows(x, TOP + 6, HEAD)];
const half = (x: number): Cell[] => [...stem(x + 4, TOP, TOP + 5), ...rows(x, TOP + 6, HOLLOW)];
const flag = (x: number): Cell[] => [[x + 5, TOP + 1], [x + 6, TOP + 2], [x + 6, TOP + 3], [x + 5, TOP + 4]];
const flags = (x: number): Cell[] => [[x + 5, TOP], [x + 6, TOP + 1], [x + 5, TOP + 2], [x + 6, TOP + 3], [x + 6, TOP + 4]];
const quarterRest = (x: number): Cell[] => rows(x, TOP, [".#..", "..#.", ".##.", "##..", ".#..", "..#.", ".##.", "#...", ".#.."]);
const eighthRest = (x: number): Cell[] => rows(x, TOP + 2, ["##.#", "##.#", "...#", "..#.", "..#.", ".#..", ".#.."]);

const GLYPHS: Record<string, () => Cell[]> = {
  quarters: () => quarter(0),
  halves: () => half(0),
  rests: () => quarterRest(0),
  eighths: () => [...quarter(0), ...quarter(7), ...beam(4, 11, TOP), ...beam(4, 11, TOP + 1)],
  dotted: () => [...quarter(0), [6, TOP + 7]],
  ties: () => [...rows(0, TOP + 6, HEAD), ...rows(8, TOP + 6, HEAD), ...beam(3, 9, TOP + 4), [2, TOP + 5], [10, TOP + 5]],
  sixteenths: () => [...quarter(0), ...flags(0)],
  syncopation: () => [...quarter(0), ...flag(0), ...quarter(8), ...quarter(16), ...flag(16)],
  dottedEighths: () => [...quarter(0), ...quarter(8), ...beam(4, 12, TOP), ...beam(4, 12, TOP + 1), ...beam(10, 12, TOP + 3), [6, TOP + 7]],
  offbeatRests: () => [...eighthRest(0), ...quarter(6), ...flag(6)],
  triplets: () => [...rows(9, 0, ["###", ".##", "###"]), ...quarter(0), ...quarter(6), ...quarter(12), ...beam(4, 16, TOP), ...beam(4, 16, TOP + 1)],
  cross: () => [...rows(0, TOP + 2, ["###", "..#", ".##", "..#", "###"]), [4, TOP + 3], [4, TOP + 5], ...rows(6, TOP + 2, ["###", "..#", "###", "#..", "###"])],
};

/** The pixel drawing for a rhythm (an ingredient key, or "cross" for 3 against 2), as SVG markup. */
export function rhythmIcon(key: string): string {
  const cells = GLYPHS[key]?.() ?? [];
  if (cells.length === 0) return "";
  const width = Math.max(...cells.map(([x]) => x)) + 1;
  const path = cells.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("");
  return `<svg class="px-icon" viewBox="0 0 ${width} 13" width="${width * 2}" height="26" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="${path}"/></svg>`;
}
