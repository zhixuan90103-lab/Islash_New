import { DESIGN_HEIGHT, DESIGN_WIDTH } from '../adapt/design';

type Pt = { x: number; y: number };
type Outer = {
  color: string;
  x: number;
  y: number;
  size: number;
  opacity: number;
};

type Piece = {
  id: number;
  poly: Pt[];
  x: number;
  y: number;
  rot: number;
  scale: number;
  color: string;
  outer: Outer | null;
};

type Tool = 'cut' | 'move' | 'rotate';

const COLORS = ['#fbcad6', '#c98496', '#cee2ab', '#93af48', '#5f7828', '#b4b3dc', '#8a88b0', '#6b7280'];

let nextId = 1;

function circle(r: number, n = 40): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

function rect(w: number, h: number): Pt[] {
  return [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
}

function shapePoly(kind: string): Pt[] {
  if (kind === 'square') return rect(220, 220);
  if (kind === 'diamond') return [{ x: 0, y: 150 }, { x: 150, y: 0 }, { x: 0, y: -150 }, { x: -150, y: 0 }];
  if (kind === 'rect') return rect(260, 160);
  return circle(120);
}

function bake(poly: Pt[], color: string): Piece {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  x /= poly.length;
  y /= poly.length;
  return {
    id: nextId++,
    poly: poly.map((p) => ({ x: p.x - x, y: p.y - y })),
    x,
    y,
    rot: 0,
    scale: 1,
    color,
    outer: null,
  };
}

function parseHex(raw: string): string | null {
  const text = raw.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(text);
  return match ? `#${match[1].toLowerCase()}` : null;
}

function worldOf(piece: Piece): Pt[] {
  const co = Math.cos(piece.rot);
  const si = Math.sin(piece.rot);
  return piece.poly.map((p) => ({
    x: piece.x + (p.x * co - p.y * si) * piece.scale,
    y: piece.y + (p.x * si + p.y * co) * piece.scale,
  }));
}

function pointIn(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function side(a: Pt, b: Pt, p: Pt): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** 接近水平、竖直或 45 度时，吸成那一个方向的纯直线。 */
function snapEnd(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return b;
  let ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const nearest = Math.round(ang / step) * step;
  if (Math.abs(ang - nearest) < (12 * Math.PI) / 180) ang = nearest;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

function edgeMid(poly: Pt[], i: number): Pt {
  const a = poly[i];
  const b = poly[(i + 1) % poly.length];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** 四边形连对边中点。三角形从每个角连到对边中点。 */
function oppositeMidLines(poly: Pt[]): Array<[Pt, Pt]> {
  const n = poly.length;
  const lines: Array<[Pt, Pt]> = [];
  if (n === 3) {
    for (let i = 0; i < 3; i++) lines.push([poly[i], edgeMid(poly, (i + 1) % 3)]);
    return lines;
  }
  if (n === 4) {
    for (let i = 0; i < n / 2; i++) lines.push([edgeMid(poly, i), edgeMid(poly, i + n / 2)]);
  }
  return lines;
}

function polyArea(poly: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    sum += cur.x * nxt.y - nxt.x * cur.y;
  }
  return sum / 2;
}

function cleanPoly(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of poly) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.4) continue;
    out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 0.4) out.pop();
  return out;
}

/** 无限直线把多边形分成两块。线段太短、或两块面积加起来不等于原块时，不算切开。 */
function splitPoly(poly: Pt[], a: Pt, b: Pt): [Pt[], Pt[]] | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 4) return null;
  const eps = 0.4 * len;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const sc = side(a, b, cur);
    const sn = side(a, b, nxt);
    if (sc >= -eps) left.push(cur);
    if (sc <= eps) right.push(cur);
    if ((sc > eps && sn < -eps) || (sc < -eps && sn > eps)) {
      const d = sc / (sc - sn);
      const hit = { x: cur.x + (nxt.x - cur.x) * d, y: cur.y + (nxt.y - cur.y) * d };
      left.push(hit);
      right.push(hit);
    }
  }
  const parts = [cleanPoly(left), cleanPoly(right)];
  if (parts[0].length < 3 || parts[1].length < 3) return null;
  const orig = polyArea(poly);
  const sum = polyArea(parts[0]) + polyArea(parts[1]);
  if (Math.abs(sum - orig) > Math.max(1, Math.abs(orig) * 0.01)) return null;
  if (Math.abs(polyArea(parts[0])) < 1 || Math.abs(polyArea(parts[1])) < 1) return null;
  return [parts[0], parts[1]];
}

export function mountLevelEditor(root: HTMLElement): void {
  root.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'lv-edit';
  const canvas = document.createElement('canvas');
  canvas.className = 'lv-edit-canvas';
  canvas.width = DESIGN_WIDTH;
  canvas.height = DESIGN_HEIGHT;
  const bar = document.createElement('div');
  bar.className = 'lv-edit-bar';
  const panel = document.createElement('div');
  panel.className = 'lv-edit-panel';
  wrap.append(canvas);
  root.append(wrap);
  const dock = document.createElement('aside');
  dock.className = 'lv-edit-dock';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lv-edit-toggle';
  toggle.textContent = '收起';
  toggle.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    const hidden = dock.classList.toggle('is-hidden');
    toggle.textContent = hidden ? '参数' : '收起';
  });
  dock.append(toggle, panel, bar);
  document.body.append(dock);

  const ctx = canvas.getContext('2d')!;
  let pieces: Piece[] = [bake(shapePoly('circle'), COLORS[0])];
  let tool: Tool = 'cut';
  let selected = pieces[0].id;
  let drag: { id: number; x: number; y: number; px: number; py: number; rot: number } | null = null;
  let cutLine: { a: Pt; b: Pt } | null = null;
  const undoStack: Array<{ pieces: Piece[]; selected: number }> = [];
  const clonePieces = (): Piece[] => pieces.map((piece) => ({
    ...piece,
    poly: piece.poly.map((p) => ({ ...p })),
    outer: piece.outer ? { ...piece.outer } : null,
  }));
  const remember = () => {
    undoStack.push({ pieces: clonePieces(), selected });
    if (undoStack.length > 40) undoStack.shift();
  };
  const undo = () => {
    const prev = undoStack.pop();
    if (!prev) return;
    pieces = prev.pieces;
    selected = prev.selected;
    syncPanel();
    draw();
  };

  const toWorld = (e: PointerEvent): Pt => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * DESIGN_WIDTH - DESIGN_WIDTH / 2;
    const y = DESIGN_HEIGHT / 2 - ((e.clientY - r.top) / r.height) * DESIGN_HEIGHT;
    return { x, y };
  };

  const snapPoint = (p: Pt): Pt => {
    let best = p;
    let bestD = 18;
    for (const piece of pieces) {
      const poly = worldOf(piece);
      const marks = [...poly];
      for (let i = 0; i < poly.length; i++) marks.push(edgeMid(poly, i));
      for (const mark of marks) {
        const d = Math.hypot(mark.x - p.x, mark.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = mark;
        }
      }
    }
    return best;
  };

  const hitPiece = (p: Pt): Piece | null => {
    for (let i = pieces.length - 1; i >= 0; i--) {
      if (pointIn(p.x, p.y, worldOf(pieces[i]))) return pieces[i];
    }
    return null;
  };

  const draw = () => {
    ctx.clearRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.save();
    ctx.translate(DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
    ctx.scale(1, -1);
    ctx.fillStyle = '#e7eef5';
    ctx.fillRect(-DESIGN_WIDTH / 2, -DESIGN_HEIGHT / 2, DESIGN_WIDTH, DESIGN_HEIGHT);
    const fillPoly = (poly: Pt[], color: string, opacity = 1) => {
      ctx.beginPath();
      poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    for (const piece of pieces) {
      if (piece.outer) {
        const outer = piece.outer;
        fillPoly(worldOf({ ...piece, x: piece.x + outer.x, y: piece.y + outer.y, scale: piece.scale * outer.size }), outer.color, outer.opacity);
      }
      const poly = worldOf(piece);
      fillPoly(poly, piece.color);
      ctx.lineWidth = piece.id === selected ? 3 : 1.5;
      ctx.strokeStyle = piece.id === selected ? '#3b82c4' : '#6b7280';
      ctx.stroke();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#3b82c4';
      for (const [a, b] of oppositeMidLines(poly)) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const selectedPiece = pieces.find((item) => item.id === selected);
    if (selectedPiece) {
      ctx.beginPath();
      ctx.moveTo(selectedPiece.x - 400, selectedPiece.y);
      ctx.lineTo(selectedPiece.x + 400, selectedPiece.y);
      ctx.moveTo(selectedPiece.x, selectedPiece.y - 400);
      ctx.lineTo(selectedPiece.x, selectedPiece.y + 400);
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (cutLine) {
      ctx.beginPath();
      ctx.moveTo(cutLine.a.x, cutLine.a.y);
      ctx.lineTo(cutLine.b.x, cutLine.b.y);
      ctx.strokeStyle = '#db96a8';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  };

  const syncPanel = () => {
    const piece = pieces.find((item) => item.id === selected);
    panel.replaceChildren();
    if (!piece) {
      panel.textContent = '点一块料';
      return;
    }
    const add = (
      label: string,
      value: number,
      step: number,
      write: (n: number) => void,
      range = label === '角度' ? [-180, 180] : label === '大小' ? [0.3, 2.5] : [-220, 220],
    ) => {
      const row = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = label;
      const num = document.createElement('span');
      num.textContent = value.toFixed(2);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(range[0]);
      input.max = String(range[1]);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('pointerdown', () => remember());
      input.addEventListener('input', () => {
        write(Number(input.value));
        num.textContent = Number(input.value).toFixed(2);
        draw();
      });
      row.append(name, input, num);
      panel.append(row);
    };
    add('左右', piece.x, 1, (n) => { piece.x = n; });
    add('上下', piece.y, 1, (n) => { piece.y = n; });
    add('角度', (piece.rot * 180) / Math.PI, 1, (n) => { piece.rot = (n * Math.PI) / 180; });
    add('大小', piece.scale, 0.01, (n) => { piece.scale = n; });
    const addHex = (label: string, read: () => string, write: (hex: string) => void) => {
      const row = document.createElement('label');
      row.className = 'lv-edit-hex-row';
      const name = document.createElement('span');
      name.textContent = label;
      const input = document.createElement('input');
      input.className = 'lv-edit-hex';
      input.type = 'text';
      input.spellcheck = false;
      input.value = read();
      input.placeholder = '#rrggbb';
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      input.addEventListener('focus', () => remember());
      input.addEventListener('input', () => {
        const hex = parseHex(input.value);
        if (!hex) return;
        write(hex);
        draw();
      });
      row.append(name, input);
      panel.append(row);
    };
    const addSwatches = (write: (hex: string) => void) => {
      const colors = document.createElement('div');
      colors.className = 'lv-edit-colors';
      for (const color of COLORS) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.style.background = color;
        swatch.addEventListener('pointerdown', (ev) => {
          ev.stopPropagation();
          remember();
          write(color);
          syncPanel();
          draw();
        });
        colors.append(swatch);
      }
      panel.append(colors);
    };
    addHex('颜色', () => piece.color, (hex) => { piece.color = hex; });
    addSwatches((hex) => { piece.color = hex; });
    const outerBtn = document.createElement('button');
    outerBtn.type = 'button';
    outerBtn.className = 'lv-edit-outer';
    outerBtn.textContent = piece.outer ? '去掉外影' : '加外影';
    outerBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      remember();
      piece.outer = piece.outer ? null : { color: '#8a88b0', x: 0, y: 0, size: 1.2, opacity: 1 };
      syncPanel();
      draw();
    });
    panel.append(outerBtn);
    if (piece.outer) {
      const outer = piece.outer;
      addHex('外影色', () => outer.color, (hex) => { outer.color = hex; });
      add('外影左右', outer.x, 1, (n) => { outer.x = n; }, [-80, 80]);
      add('外影上下', outer.y, 1, (n) => { outer.y = n; }, [-80, 80]);
      add('外影大小', outer.size, 0.01, (n) => { outer.size = n; }, [0.4, 2]);
      add('外影透明', outer.opacity, 0.01, (n) => { outer.opacity = n; }, [0, 1]);
    }
  };

  const setTool = (next: Tool) => {
    tool = next;
    for (const button of bar.querySelectorAll('button[data-tool]')) {
      button.classList.toggle('is-on', button.getAttribute('data-tool') === next);
    }
  };

  const addButton = (label: string, on: () => void, toolName?: Tool) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (toolName) button.dataset.tool = toolName;
    button.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      on();
    });
    bar.append(button);
    return button;
  };

  addButton('撤销', () => undo());
  addButton('切', () => setTool('cut'), 'cut');
  addButton('拖', () => setTool('move'), 'move');
  addButton('转', () => setTool('rotate'), 'rotate');
  for (const [label, kind] of [['圆', 'circle'], ['方', 'square'], ['菱', 'diamond'], ['长', 'rect']] as const) {
    addButton(label, () => {
      remember();
      pieces = [bake(shapePoly(kind), COLORS[0])];
      selected = pieces[0].id;
      syncPanel();
      draw();
    });
  }
  addButton('复制', () => {
    const data = pieces.map((piece) => ({
      color: piece.color,
      x: Number(piece.x.toFixed(2)),
      y: Number(piece.y.toFixed(2)),
      rot: Number(((piece.rot * 180) / Math.PI).toFixed(1)),
      scale: Number(piece.scale.toFixed(2)),
      poly: worldOf(piece).map((p) => [Number(p.x.toFixed(1)), Number(p.y.toFixed(1))]),
      outer: piece.outer ? {
        color: piece.outer.color,
        x: Number(piece.outer.x.toFixed(2)),
        y: Number(piece.outer.y.toFixed(2)),
        size: Number(piece.outer.size.toFixed(2)),
        opacity: Number(piece.outer.opacity.toFixed(2)),
      } : null,
    }));
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  });
  setTool('cut');

  canvas.addEventListener('pointerdown', (ev) => {
    const p = toWorld(ev);
    const piece = hitPiece(p);
    if (piece) {
      selected = piece.id;
      syncPanel();
    }
    if (tool === 'cut') {
      const a = snapPoint(p);
      cutLine = { a, b: a };
    }
    else if (piece && tool === 'move') {
      remember();
      drag = { id: piece.id, x: piece.x, y: piece.y, px: p.x, py: p.y, rot: piece.rot };
    }
    else if (piece && tool === 'rotate') {
      remember();
      drag = { id: piece.id, x: piece.x, y: piece.y, px: p.x, py: p.y, rot: piece.rot };
    }
    draw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag && !cutLine) return;
    const p = toWorld(ev);
    if (cutLine) {
      const snapped = snapPoint(p);
      cutLine.b = Math.hypot(snapped.x - p.x, snapped.y - p.y) < 18 ? snapped : snapEnd(cutLine.a, p);
    }
    const piece = pieces.find((item) => item.id === drag?.id);
    if (drag && piece && tool === 'move') {
      piece.x = drag.x + (p.x - drag.px);
      piece.y = drag.y + (p.y - drag.py);
      syncPanel();
    }
    if (drag && piece && tool === 'rotate') {
      const a0 = Math.atan2(drag.py - piece.y, drag.px - piece.x);
      const a1 = Math.atan2(p.y - piece.y, p.x - piece.x);
      piece.rot = drag.rot + (a1 - a0);
      syncPanel();
    }
    draw();
  });
  const endCut = () => {
    if (tool === 'cut' && cutLine) {
      const piece = pieces.find((item) => item.id === selected) ?? hitPiece(cutLine.a);
      if (piece) {
        const parts = splitPoly(worldOf(piece), cutLine.a, cutLine.b);
        if (parts) {
          remember();
          const made = parts.map((poly) => bake(poly, piece.color));
          if (piece.outer) {
            for (const part of made) part.outer = { ...piece.outer };
          }
          pieces = pieces.filter((item) => item.id !== piece.id).concat(made);
          selected = made[0].id;
          syncPanel();
        }
      }
    }
    cutLine = null;
    drag = null;
    draw();
  };
  canvas.addEventListener('pointerup', endCut);
  canvas.addEventListener('pointercancel', endCut);
  window.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undo();
    }
  });
  syncPanel();
  draw();
}
