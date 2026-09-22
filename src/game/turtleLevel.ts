import * as THREE from 'three';
import { WOOD } from './design';
import type { Poly2 } from './woodProfile';

/** 乌龟关零件。壳是上半圆，左右腿和头各是一个四分之一圆，眼睛是小圆。 */
export const TURTLE = {
  r: 0.92,
  dark: 0x1f8a3a,
  light: 0x8ed84a,
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

export function turtleParts(r = TURTLE.r): TurtlePart[] {
  const shell = sector(r, Math.PI, 0, 20);
  // 朝向不动：左下那块原样平移到右侧，右下那块原样平移到左侧。
  const legL = shiftX(sector(r, Math.PI, Math.PI * 1.5, 12), r);
  const legR = shiftX(sector(r, Math.PI * 1.5, Math.PI * 2, 12), -r);
  return [
    { id: 'shell', poly: shell, dark: true },
    { id: 'legL', poly: legL, dark: false },
    { id: 'legR', poly: legR, dark: false },
  ];
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

/** 料的本地 Y：上半深绿、下半浅绿。子块继承同一局部坐标。 */
export function turtleInkTexture(): THREE.CanvasTexture {
  const n = 256;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('turtle ink');
  const dark = '#1f8a3a';
  const light = '#8ed84a';
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, n, n / 2);
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
