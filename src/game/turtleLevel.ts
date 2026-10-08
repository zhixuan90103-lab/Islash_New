import * as THREE from 'three';
import { WOOD } from './design';
import type { Poly2 } from './woodProfile';

/** 乌龟关零件。壳是上半圆，左右腿和头各是一个四分之一圆，眼睛是小圆。 */
export const TURTLE = {
  r: 0.92,
  dark: 0x93af48,
  light: 0xcee2ab,
  shadow: 0xc5cec6,
  eye: 0x1a1a1a,
  /** 第一次亮按钮：平移加转动后的轮廓重合。再切不再关掉。 */
  showIou: 0.55,
  showRatioMin: 0.45,
  showRatioMax: 1.55,
};

export type TurtlePartId = 'shell' | 'legL' | 'legR';

export type TurtlePart = {
  id: TurtlePartId;
  poly: Poly2[];
  /** 这块在料上应带走的颜色。y >= 0 为深绿。 */
  dark: boolean;
};

function arc(r: number, a0: number, a1: number, n: number): Poly2[] {
  const pts: Poly2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return pts;
}

/** 圆弧加圆心，得到扇形。半圆、四分之一圆都走这里。 */
function sector(r: number, a0: number, a1: number, n = 16): Poly2[] {
  return [{ x: 0, y: 0 }, ...arc(r, a0, a1, n)];
}

function shiftX(poly: Poly2[], dx: number): Poly2[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y }));
}

function turtleBaseParts(r = TURTLE.r): TurtlePart[] {
  const shell = sector(r, Math.PI, 0, 20);
  const legL = shiftX(sector(r, Math.PI, Math.PI * 1.5, 12), r);
  const legR = shiftX(sector(r, Math.PI * 1.5, Math.PI * 2, 12), -r);
  return [
    { id: 'shell', poly: shell, dark: true },
    { id: 'legL', poly: legL, dark: false },
    { id: 'legR', poly: legR, dark: false },
  ];
}

/** 绕扇形自己的圆心放大，当作底下那层色影。 */
function enlargeAbout(poly: Poly2[], origin: Poly2, scale = 1.2): Poly2[] {
  return poly.map((p) => ({
    x: origin.x + (p.x - origin.x) * scale,
    y: origin.y + (p.y - origin.y) * scale,
  }));
}

export function turtleParts(r = TURTLE.r): TurtlePart[] {
  return turtleBaseParts(r).map((part) => {
    const origin = part.id === 'legL' ? { x: r, y: 0 }
      : part.id === 'legR' ? { x: -r, y: 0 }
      : { x: 0, y: 0 };
    return { ...part, poly: enlargeAbout(part.poly, origin) };
  });
}

/** 和零件一样大的一层，盖在放大色影上面。 */
export function turtleShadeCaps(r = TURTLE.r): Poly2[][] {
  return turtleBaseParts(r).map((part) => part.poly);
}

export function turtleHeadPoly(r = TURTLE.r): Poly2[] {
  const cx = r + r;
  const cy = 0;
  // 与腿相同半径，绕直角逆时针 90°。再右移，使左缘贴住龟壳右缘 x = r。
  return [{ x: cx, y: cy }, ...arc(r, Math.PI / 2, Math.PI, 12).map((p) => ({ x: p.x + cx, y: p.y + cy }))];
}

export function turtleEyeCenter(r = TURTLE.r): Poly2 {
  return { x: r * 1.72, y: r * 0.32 };
}

/** 直线 origin + t·dir 穿过多边形的那一段。凸多边形最多两个交点。 */
function lineChord(poly: Poly2[], dirX: number, dirY: number): [Poly2, Poly2] | null {
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = dirX * ey - dirY * ex;
    if (Math.abs(den) < 1e-8) continue;
    const t = (a.x * ey - a.y * ex) / den;
    const u = (a.x * dirY - a.y * dirX) / den;
    if (u >= -1e-4 && u <= 1 + 1e-4) ts.push(t);
  }
  if (ts.length < 2) return null;
  ts.sort((p, q) => p - q);
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  if (t1 - t0 < 0.05) return null;
  return [
    { x: dirX * t0, y: dirY * t0 },
    { x: dirX * t1, y: dirY * t1 },
  ];
}

type CutEdge = { ax: number; ay: number; bx: number; by: number; mx: number; my: number; len: number };

function insideConvex(poly: Poly2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(c) < 1e-8) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 切出来的直边：比圆弧碎边长，而且中点不在圆周上。 */
function cutEdges(poly: Poly2[], r: number): CutEdge[] {
  const edges: CutEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = (a.x + b.x) * 0.5;
    const my = (a.y + b.y) * 0.5;
    if (len < r * 0.35 || Math.hypot(mx, my) > r * 0.96) continue;
    edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, mx, my, len });
  }
  return edges;
}

function polyAreaAbs(poly: Poly2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) * 0.5;
}

/** 一条直边几乎是直径：这块已经是半圆，转多少度都算。 */
function isSemicircle(poly: Poly2[], r: number): boolean {
  const edges = cutEdges(poly, r);
  if (edges.length !== 1) return false;
  const e = edges[0]!;
  return Math.hypot(e.mx, e.my) < r * 0.18 && e.len > r * 1.55;
}

/** 从这条切边的中点，沿它的中垂线走进这块，直到对面的轮廓。 */
function inwardSpan(poly: Poly2[], edge: CutEdge): { a: Poly2; b: Poly2 } | null {
  const len = edge.len || 1;
  let px = -(edge.by - edge.ay) / len;
  let py = (edge.bx - edge.ax) / len;
  const eps = 0.03;
  if (!insideConvex(poly, edge.mx + px * eps, edge.my + py * eps)) {
    px = -px;
    py = -py;
  }
  if (!insideConvex(poly, edge.mx + px * eps, edge.my + py * eps)) return null;
  let bestT = Infinity;
  let hit: Poly2 | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const den = px * ey - py * ex;
    if (Math.abs(den) < 1e-8) continue;
    const t = ((a.x - edge.mx) * ey - (a.y - edge.my) * ex) / den;
    const u = ((a.x - edge.mx) * py - (a.y - edge.my) * px) / den;
    if (t < 0.04 || u < -1e-3 || u > 1 + 1e-3) continue;
    if (t < bestT) {
      bestT = t;
      hit = { x: edge.mx + px * t, y: edge.my + py * t };
    }
  }
  if (!hit) return null;
  return { a: { x: edge.mx, y: edge.my }, b: hit };
}

/**
 * 乌龟下一刀。没切过：整块上的水平直径。
 * 切过：不看颜色，也不锁在横竖方向。沿着玩家这条切边的中垂线，
 * 在还不是半圆的那一块上画到对面轮廓。已经是半圆就改切另一块。
 */
export function turtleGuide(
  pieces: Poly2[][],
  cuts: number,
): { index: number; a: Poly2; b: Poly2 } | null {
  if (!pieces.length) return null;
  const r = TURTLE.r;
  const horizontal = () => {
    const chord = lineChord(pieces[0] ?? [], 1, 0);
    if (!chord) return null;
    const [p, q] = chord;
    const a = p.x <= q.x ? p : q;
    const b = p.x <= q.x ? q : p;
    return { index: 0, a, b };
  };
  if (cuts <= 0 || pieces.length < 2) return horizontal();
  const ranked = pieces.map((poly, index) => ({
    index,
    poly,
    area: polyAreaAbs(poly),
    semi: isSemicircle(poly, r),
    edge: cutEdges(poly, r).sort((p, q) => q.len - p.len)[0] ?? null,
  }));
  const open = ranked.filter((item) => !item.semi && item.edge);
  const pool = open.length ? open : ranked.filter((item) => item.edge);
  pool.sort((p, q) => q.area - p.area);
  const host = pool[0];
  if (!host?.edge) return horizontal();
  const span = inwardSpan(host.poly, host.edge);
  if (!span) return horizontal();
  return { index: host.index, a: span.a, b: span.b };
}

/** 料的本地 Y：上半深绿、下半浅绿。子块继承同一局部坐标。 */
export function turtleInkTexture(): THREE.CanvasTexture {
  const n = 256;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('turtle ink');
  const dark = '#93af48';
  const light = '#cee2ab';
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, n, n / 2);
  specklePaper(ctx, n);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function specklePaper(ctx: CanvasRenderingContext2D, n: number): void {
  const img = ctx.getImageData(0, 0, n, n);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const j = ((i * 17) % 11) - 5;
    d[i] = Math.min(255, Math.max(0, d[i] + j));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + j));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + j));
  }
  ctx.putImageData(img, 0, 0);
}

export function paperFaceTexture(hex: number): THREE.CanvasTexture {
  const n = 256;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('paper face');
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, n, n);
  specklePaper(ctx, n);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 轮廓点的本地 y 是否落在深绿半边。UV 与倒角网格一致：y * uvScale + 0.5。 */
export function localIsDark(y: number): boolean {
  return y >= -1e-4;
}

export const turtleUvScale = WOOD.uvScale;
