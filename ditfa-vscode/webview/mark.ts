/**
 * The Ditfa mark as live SVG, built from the same geometry as the website's
 * `DitfaMark`: a sphere whose left half is cut into curved stripes and whose
 * right half is the letter D. Every stripe is its own group, so the mark can
 * assemble stripe by stripe and ripple while the agent works.
 */

type Point = [number, number];

const SPHERE = { cx: 957, cy: 987, r: 548 };
const STRIPES_END = 818;
const D_START = 845;
const GAP_WIDTH = 42;
const VIEWBOX = "395 425 1125 1125";

const CUTS: { left: Point; rightY: number }[] = [
  { left: [633.4, 544.8], rightY: 690 },
  { left: [580.7, 588.6], rightY: 787 },
  { left: [522.7, 652.9], rightY: 885 },
  { left: [476.8, 722.8], rightY: 987 },
  { left: [442, 799.6], rightY: 1085 },
  { left: [416.7, 895.2], rightY: 1179 },
  { left: [410, 1019.4], rightY: 1277 },
  { left: [446.2, 1185.3], rightY: 1370 },
];

const f = (n: number) => Math.round(n * 10) / 10;

interface Cut {
  start: Point;
  left: Point;
  control: Point;
  right: Point;
}

function cut({ left, rightY }: (typeof CUTS)[number]): Cut {
  const [lx, ly] = left;
  const control: Point = [lx + 0.35 * (STRIPES_END - lx), rightY];
  const dx = control[0] - lx;
  const dy = control[1] - ly;
  const length = Math.hypot(dx, dy) || 1;
  const start: Point = [lx - (dx / length) * 70, ly - (dy / length) * 70];
  return { start, left, control, right: [STRIPES_END, rightY] };
}

const CUT_PATHS = CUTS.map(cut);

const cutD = (c: Cut) =>
  `M${f(c.start[0])} ${f(c.start[1])}L${f(c.left[0])} ${f(c.left[1])}Q${f(c.control[0])} ${f(c.control[1])} ${c.right[0]} ${c.right[1]}L${D_START} ${c.right[1]}`;

function bandD(index: number): string {
  const upper = CUT_PATHS[index - 1];
  const lower = CUT_PATHS[index];
  const forward = (c: Cut) =>
    `L${f(c.left[0])} ${f(c.left[1])}Q${f(c.control[0])} ${f(c.control[1])} ${c.right[0]} ${c.right[1]}`;
  const backward = (c: Cut) =>
    `Q${f(c.control[0])} ${f(c.control[1])} ${f(c.left[0])} ${f(c.left[1])}L${f(c.start[0])} ${f(c.start[1])}`;
  if (!upper && lower) {
    return `M300 300L${D_START} 300L${D_START} ${lower.right[1]}L${lower.right[0]} ${lower.right[1]}${backward(lower)}L300 ${f(lower.start[1])}Z`;
  }
  if (upper && !lower) {
    return `M${f(upper.start[0])} ${f(upper.start[1])}${forward(upper)}L${D_START} ${upper.right[1]}L${D_START} 1600L300 1600Z`;
  }
  return `M${f(upper!.start[0])} ${f(upper!.start[1])}${forward(upper!)}L${D_START} ${upper!.right[1]}L${D_START} ${lower!.right[1]}L${lower!.right[0]} ${lower!.right[1]}${backward(lower!)}Z`;
}

const BAND_PATHS = Array.from({ length: CUTS.length + 1 }, (_, index) => bandD(index));

const halfY = (x: number) => Math.sqrt(SPHERE.r ** 2 - (x - SPHERE.cx) ** 2);
const STRIPED_HALF = `M${STRIPES_END} ${f(SPHERE.cy - halfY(STRIPES_END))}A${SPHERE.r} ${SPHERE.r} 0 0 0 ${STRIPES_END} ${f(SPHERE.cy + halfY(STRIPES_END))}Z`;
const LETTER_D = `M${D_START} ${f(SPHERE.cy - halfY(D_START))}A${SPHERE.r} ${SPHERE.r} 0 1 1 ${D_START} ${f(SPHERE.cy + halfY(D_START))}ZM972 592A395 395 0 0 1 972 1382Z`;

export type MarkMotion = "none" | "assemble" | "ripple";

let instances = 0;

export function markSvg(motion: MarkMotion = "none", className = ""): string {
  const id = `dm${++instances}`;
  const bands = BAND_PATHS.map(
    (_, index) =>
      `<g class="ditfa-band" style="--i:${index}"><path d="${STRIPED_HALF}" fill="url(#${id}g)" clip-path="url(#${id}c${index})" mask="url(#${id}m)"/></g>`,
  ).join("");
  const clips = BAND_PATHS.map(
    (d, index) => `<clipPath id="${id}c${index}" clipPathUnits="userSpaceOnUse"><path d="${d}"/></clipPath>`,
  ).join("");
  const cuts = CUT_PATHS.map((c) => `<path d="${cutD(c)}"/>`).join("");

  return `<svg viewBox="${VIEWBOX}" class="ditfa-mark ${className}" data-motion="${motion}" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="800" y1="440" x2="1080" y2="1535"><stop offset="0" stop-color="#7cc0ec"/><stop offset="0.42" stop-color="#4f94c5"/><stop offset="1" stop-color="#1d3a73"/></linearGradient><mask id="${id}m" maskUnits="userSpaceOnUse" x="300" y="300" width="700" height="1400"><path d="${STRIPED_HALF}" fill="#fff"/><g fill="none" stroke="#000" stroke-width="${GAP_WIDTH}" stroke-linejoin="round">${cuts}</g></mask>${clips}</defs>${bands}<path class="ditfa-d" d="${LETTER_D}" fill="url(#${id}g)" fill-rule="evenodd"/></svg>`;
}
