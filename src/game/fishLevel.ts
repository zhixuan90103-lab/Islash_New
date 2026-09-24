import type { Poly2 } from './woodProfile';

/** 第三关。斜放的正方形切成七块，拼成鱼。 */
export const FISH = {
  paper: 0xb4b3dc,
  shadow: 0x8a88b0,
};

const S = 0.62;

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

/** 裁切前的纸：尖朝上、下、左、右的正方形。 */
export function fishSheet(): Poly2[] {
  return [v(-2, 0), v(0, 2), v(2, 0), v(0, -2)];
}
