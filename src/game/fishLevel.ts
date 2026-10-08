import { pointInConvex, splitConvexPolygon, type Poly2 } from './woodProfile';
import { TURTLE } from './turtleLevel';

/** 第三关。斜放的正方形切成七块，拼成鱼。 */
export const FISH = {
  paper: 0xb4b3dc,
  shadow: 0x8b8fc1,
};

/** 菱形尖到中心比前两关圆纸半径再大一截。 */
const S = (TURTLE.r / 2) * 1.12;

/** 裁切前，菱形尖到纸心的距离。 */
export function fishSheetReach(): number {
  return 2 * S;
}

function v(x: number, y: number): Poly2 {
  return { x: x * S, y: y * S };
}

export type FishPart = {
  id: string;
  poly: Poly2[];
  dark: null;
  /** 外影相对这块轮廓中心的放大倍数。 */
  outer: number;
};

/** 编辑器坐标：菱形半对角线 150，对应这里 v() 之前的 2。 */
function e(x: number, y: number): Poly2 {
  return v(x / 75, y / 75);
}

/**
 * 笔记本上的鱼。轮廓是编辑器导出的世界坐标，粉色在上，外影是同一轮廓放大。
 * 左边大三角是尾，右边大三角是头，中间正方形是身子，上下各两块小三角是鳍。
 */
export function fishParts(): FishPart[] {
  return [
    { id: 'tail', poly: [e(-166.8, 74.7), e(-91.8, -0.3), e(-166.8, -75.3)], dark: null, outer: 1.2 },
    { id: 'head', poly: [e(88.3, 76.2), e(163.3, 1.2), e(88.3, -73.8)], dark: null, outer: 1.2 },
    { id: 'body', poly: [e(75, 75), e(75, -75), e(-75, -75), e(-75, 75)], dark: null, outer: 1.15 },
    { id: 'finBL', poly: [e(14, -143.5), e(-92, -143.5), e(-39, -90.4)], dark: null, outer: 1.2 },
    { id: 'finBR', poly: [e(-28.6, -87.4), e(77.4, -87.4), e(24.4, -140.5)], dark: null, outer: 1.2 },
    { id: 'finTR', poly: [e(80.5, 87.2), e(-25.6, 87.2), e(27.5, 140.2)], dark: null, outer: 1.2 },
    { id: 'finTL', poly: [e(16.5, 143.7), e(-36.5, 90.7), e(-89.6, 143.7)], dark: null, outer: 1.2 },
  ];
}

/** 菱形上的 6 刀：中间方块四条边，再加上、下两个尖被竖直切开。 */
export function fishHint(): Poly2[][] {
  return [
    [v(-1, 1), v(1, 1)],
    [v(1, 1), v(1, -1)],
    [v(1, -1), v(-1, -1)],
    [v(-1, -1), v(-1, 1)],
    [v(0, 1), v(0, 2)],
    [v(0, -1), v(0, -2)],
  ];
}

function reach(): number {
  return fishSheetReach();
}

function edgeLengths(poly: Poly2[]): number[] {
  const lens: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > reach() * 0.08) lens.push(len);
  }
  lens.sort((p, q) => p - q);
  return lens;
}

/** 七块成品的边长。转角不影响，只比形状。 */
function targetSignatures(): number[][] {
  const R = reach();
  const h = R * 0.5;
  const side = Math.hypot(h, h);
  return [
    [R, R, R, R],
    [side, side, R],
    [h, h, side],
  ];
}

function shapeFit(poly: Poly2[]): { kind: 'square' | 'large' | 'fin' | 'other'; score: number } {
  const lens = edgeLengths(poly);
  const kinds = ['square', 'large', 'fin'] as const;
  let best = 0;
  let kind: 'square' | 'large' | 'fin' | 'other' = 'other';
  targetSignatures().forEach((target, i) => {
    if (target.length !== lens.length) return;
    let err = 0;
    let scale = 0;
    for (let k = 0; k < target.length; k++) {
      err += Math.abs(target[k]! - lens[k]!);
      scale += target[k]!;
    }
    const score = 1 - err / Math.max(1e-6, scale);
    if (score > best) {
      best = score;
      kind = kinds[i]!;
    }
  });
  if (best < 0.85) return { kind: 'other', score: best };
  return { kind, score: best };
}

function shapeScore(poly: Poly2[]): number {
  return shapeFit(poly).score;
}

/** 离纸心最远的角更靠近上下尖，而不是左右尖。 */
function isVerticalTip(poly: Poly2[]): boolean {
  let far = poly[0];
  if (!far) return false;
  for (const p of poly) {
    if (p.x * p.x + p.y * p.y > far.x * far.x + far.y * far.y) far = p;
  }
  return Math.abs(far.y) > Math.abs(far.x) * 1.15;
}

function onBoundary(poly: Poly2[], p: Poly2): boolean {
  const R = reach();
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    let u = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    u = Math.max(0, Math.min(1, u));
    const dx = a.x + abx * u - p.x;
    const dy = a.y + aby * u - p.y;
    best = Math.min(best, Math.hypot(dx, dy));
  }
  return best < R * 0.06;
}

/** 直线在这块里的整段。两端都在轮廓上才算能一刀切开。 */
function throughChord(poly: Poly2[], ax: number, ay: number, bx: number, by: number): [Poly2, Poly2] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-8) continue;
    const t = ((p.x - ax) * ey - (p.y - ay) * ex) / den;
    const u = ((p.x - ax) * uy - (p.y - ay) * ux) / den;
    if (u >= -1e-3 && u <= 1 + 1e-3) ts.push(t);
  }
  if (ts.length < 2) return null;
  ts.sort((p, q) => p - q);
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  if (t1 - t0 < reach() * 0.12) return null;
  return [
    { x: ax + ux * t0, y: ay + uy * t0 },
    { x: ax + ux * t1, y: ay + uy * t1 },
  ];
}

function cutEdges(poly: Poly2[]): Array<{ mx: number; my: number; dx: number; dy: number; len: number }> {
  const sheet = fishSheet();
  const R = reach();
  const edges = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    if (len < R * 0.2) continue;
    if (!pointInConvex({ x: mx, y: my }, sheet, R * 0.05)) continue;
    edges.push({ mx, my, dx: b.x - a.x, dy: b.y - a.y, len });
  }
  return edges;
}

function candidates(poly: Poly2[]): Array<{ a: Poly2; b: Poly2 }> {
  const found: Array<{ a: Poly2; b: Poly2 }> = [];
  for (const [a, b] of fishHint()) {
    const chord = throughChord(poly, a.x, a.y, b.x, b.y);
    if (!chord) continue;
    const [p, q] = chord;
    const planLen = Math.hypot(b.x - a.x, b.y - a.y);
    const got = Math.hypot(q.x - p.x, q.y - p.y);
    if (got > planLen * 1.2) continue;
    if (!onBoundary(poly, p) || !onBoundary(poly, q)) continue;
    found.push({ a: p, b: q });
  }
  for (const edge of cutEdges(poly)) {
    const px = -edge.dy / edge.len;
    const py = edge.dx / edge.len;
    const chord = throughChord(poly, edge.mx - px, edge.my - py, edge.mx + px, edge.my + py);
    if (!chord) continue;
    found.push({ a: chord[0], b: chord[1] });
  }
  return found;
}

function splitScore(poly: Poly2[], a: Poly2, b: Poly2): number {
  const parts = splitConvexPolygon(poly, a, b);
  if (!parts) return -1;
  const s1 = shapeScore(parts.pos);
  const s2 = shapeScore(parts.neg);
  return Math.max(s1, s2) + 0.2 * Math.min(s1, s2);
}

/**
 * 鱼的下一刀。一次一条。
 * 没切过：方块靠上的那条边，把上尖整块切下来。
 * 切过：在当前各块里找一刀，切完最接近成品的三角或方块。颜色和转角不算。
 * 尖上的竖线只有上尖或下尖已经被切下来时才画得出来。
 */
export function fishGuide(
  pieces: Poly2[][],
  cuts: number,
): { index: number; a: Poly2; b: Poly2 } | null {
  if (!pieces.length) return null;
  if (cuts <= 0 || pieces.length < 2) {
    const poly = pieces[0] ?? [];
    const [a, b] = fishHint()[0]!;
    const chord = throughChord(poly, a.x, a.y, b.x, b.y);
    if (!chord) return null;
    return { index: 0, a: chord[0], b: chord[1] };
  }
  const fits = pieces.map((poly) => shapeFit(poly));
  const largeCount = fits.filter((fit) => fit.kind === 'large').length;
  const finCount = fits.filter((fit) => fit.kind === 'fin').length;
  const splitLarge = finCount < 4 && largeCount > 2;
  let best: { index: number; a: Poly2; b: Poly2 } | null = null;
  let bestScore = 0.2;
  for (let i = 0; i < pieces.length; i++) {
    const poly = pieces[i] ?? [];
    const fit = fits[i]!;
    if (fit.kind === 'square' || fit.kind === 'fin') continue;
    if (fit.kind === 'large' && !splitLarge) continue;
    for (const seg of candidates(poly)) {
      let score = splitScore(poly, seg.a, seg.b);
      if (fit.kind === 'large' && score > 0.8 && isVerticalTip(poly)) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { index: i, a: seg.a, b: seg.b };
      }
    }
  }
  return best;
}

/** 裁切前的纸：尖朝上、下、左、右的正方形。 */
export function fishSheet(): Poly2[] {
  return [v(-2, 0), v(0, 2), v(2, 0), v(0, -2)];
}
