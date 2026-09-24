import type { Poly2 } from './woodProfile';
import { TURTLE } from './turtleLevel';

/** 蝴蝶：两个半圆左右对调，朝向不变。两只眼睛是已经画上的小圆。 */
export const BUTTERFLY = {
  r: TURTLE.r,
  pink: 0xfbcad6,
  edge: 0xfbcad6,
  eye: 0x1a1a1a,
};

export type ButterflyPart = {
  id: 'wingL' | 'wingR';
  poly: Poly2[];
  /** 整张料是同一个颜色，不按深浅计。 */
  dark: null;
};

function arc(r: number, a0: number, a1: number, n: number): Poly2[] {
  const pts: Poly2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: Math.cos(t) * r, y: Math.sin(t) * r });
  }
  return pts;
}

function semicircle(r: number, a0: number, a1: number): Poly2[] {
  return [{ x: 0, y: 0 }, ...arc(r, a0, a1, 20)];
}

function shiftX(poly: Poly2[], dx: number): Poly2[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y }));
}

/**
 * 半圆绕自己的圆心放大 20%，再往外平移。
 * 平移距离让弧线最靠里的点落回原来的圆心，两边在这一点相接。
 */
function biggerWing(r: number, side: 1 | -1): Poly2[] {
  const radius = r * 1.2;
  const a0 = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  const a1 = side > 0 ? Math.PI * 1.5 : Math.PI / 2;
  return shiftX(semicircle(radius, a0, a1), side * radius);
}

export function butterflyParts(r = BUTTERFLY.r): ButterflyPart[] {
  return [
    { id: 'wingL', poly: biggerWing(r, 1), dark: null },
    { id: 'wingR', poly: biggerWing(r, -1), dark: null },
  ];
}

/** 和裁切纸一样大的两片半圆，圆心与放大后的两片重合。 */
export function butterflyBody(r = BUTTERFLY.r): Poly2[][] {
  const center = r * 1.1;
  return [
    shiftX(semicircle(r, Math.PI / 2, Math.PI * 1.5), center),
    shiftX(semicircle(r, -Math.PI / 2, Math.PI / 2), -center),
  ];
}

export function butterflyEyes(r = BUTTERFLY.r): { x: number; y: number }[] {
  return [
    { x: -r * 0.12, y: r + r * 0.06 },
    { x: r * 0.12, y: r + r * 0.06 },
  ];
}
