import * as THREE from 'three';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../adapt/design';
import { BACKDROP_GRID, VIEW } from './design';

const CELL_A = 0xafc4d9;
const CELL_B = 0xabc0d5;

function checkerTexture(): THREE.DataTexture {
  const bytes = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
  const data = new Uint8Array([...bytes(CELL_A), ...bytes(CELL_B), ...bytes(CELL_B), ...bytes(CELL_A)]);
  const tex = new THREE.DataTexture(data, 2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** 四角压暗，中间留空。盖在背景上，不压本子和料。 */
function cornerShadeTexture(): THREE.CanvasTexture {
  const width = 390;
  const height = 844;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const corners: Array<[number, number]> = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ];
    for (const [x, y] of corners) {
      const shade = ctx.createRadialGradient(x, y, 24, x, y, 430);
      shade.addColorStop(0, 'rgba(16, 36, 64, 0.72)');
      shade.addColorStop(0.45, 'rgba(16, 36, 64, 0.28)');
      shade.addColorStop(1, 'rgba(16, 36, 64, 0)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type Backdrop = {
  /** 四角压暗跟着镜头，格子钉在世界里。 */
  sync: (camera: THREE.Camera) => void;
  /** 换棋盘格的浅色和深色。 */
  setGrid: (light: number, dark: number) => void;
};

/**
 * 背景是钉在世界里的棋盘格：#afc4d9 和 #abc0d5。
 * 一屏正好横 4 格、竖 9 格，镜头停住时边落在格子线上。
 * 四角压暗仍贴着镜头。
 */
export function mountBackdropPlane(scene: THREE.Scene): Backdrop {
  const zArt = BACKDROP_GRID.z;
  const dist = VIEW.cameraZ - zArt;
  const h = 2 * dist * Math.tan((VIEW.fov * Math.PI) / 360);
  const viewW = h * (DESIGN_WIDTH / DESIGN_HEIGHT);
  const cellW = viewW / BACKDROP_GRID.cols;
  const span = cellW * BACKDROP_GRID.cols * 6;
  const geom = new THREE.PlaneGeometry(span, h);
  const tex = checkerTexture();
  tex.repeat.set(span / cellW, BACKDROP_GRID.rows);

  const art = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({
      map: tex,
      toneMapped: false,
    }),
  );
  art.position.set(viewW, 0, zArt);
  art.renderOrder = -2;
  scene.add(art);

  const catcher = new THREE.Mesh(
    geom,
    new THREE.ShadowMaterial({
      color: 0x1a4a78,
      opacity: VIEW.shadowOpacity * 0.55,
      transparent: true,
      depthWrite: false,
    }),
  );
  catcher.position.set(viewW, 0, VIEW.bgZ);
  catcher.receiveShadow = true;
  catcher.renderOrder = -1;
  scene.add(catcher);

  const shadeDist = VIEW.cameraZ - (VIEW.bgZ + 0.04);
  const shadeH = 2 * shadeDist * Math.tan((VIEW.fov * Math.PI) / 360);
  const shadeW = shadeH * (DESIGN_WIDTH / DESIGN_HEIGHT);
  const vignette = new THREE.Mesh(
    new THREE.PlaneGeometry(shadeW, shadeH),
    new THREE.MeshBasicMaterial({
      map: cornerShadeTexture(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  vignette.position.z = VIEW.bgZ + 0.04;
  vignette.renderOrder = 0;
  scene.add(vignette);

  return {
    sync: (camera) => {
      vignette.position.set(camera.position.x, camera.position.y, VIEW.bgZ + 0.04);
    },
    setGrid: (light, dark) => {
      const bytes = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
      const data = tex.image.data as Uint8Array;
      data.set([...bytes(light), ...bytes(dark), ...bytes(dark), ...bytes(light)]);
      tex.needsUpdate = true;
      scene.background = new THREE.Color(light);
    },
  };
}
