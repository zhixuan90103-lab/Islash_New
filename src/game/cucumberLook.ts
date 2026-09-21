import * as THREE from 'three';

/** 可环绕的黄瓜皮：纵棱、小刺、蒂深、花端浅。 */
export function createCucumberSkinTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) return new THREE.CanvasTexture(c);

  const img = g.createImageData(w, h);
  const d = img.data;
  const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    const stem = Math.max(0, 1 - v * 8);
    const blossom = Math.max(0, (v - 0.88) / 0.12);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const ridge = 0.55 + 0.45 * Math.cos(u * Math.PI * 16);
      const n1 = hash(x * 0.12, y * 0.08);
      const n2 = hash(x * 0.4 + 9, y * 0.35);
      const wart = n2 > 0.92 ? 0.22 : 0;
      let r = 62 + ridge * 38 + n1 * 22 - wart * 40;
      let gch = 118 + ridge * 42 + n1 * 18 - wart * 30;
      let b = 36 + ridge * 12 + n1 * 8;
      r = r * (1 - stem * 0.45) + 48 * stem;
      gch = gch * (1 - stem * 0.55) + 52 * stem;
      b = b * (1 - stem * 0.4) + 28 * stem;
      r = r * (1 - blossom) + 196 * blossom;
      gch = gch * (1 - blossom) + 188 * blossom;
      b = b * (1 - blossom) + 92 * blossom;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, gch));
      d[i + 2] = Math.max(0, Math.min(255, b));
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
