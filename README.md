# Islash Cut

竖屏 WebGPU 壳上的 **切割拼图**：用一张有限的料把指定零件裁出来，装进完成图案。准了爽，不准也好看；都能过关，星有高低。规范：[docs/CUT-PUZZLE.md](./docs/CUT-PUZZLE.md)。

壳来自 **niantu** 适配/TS/设备预览 + **three-webgpu-cap-shell** 打包。玩法：[docs/CUT-PUZZLE.md](./docs/CUT-PUZZLE.md)；刀法：[docs/SLASH-DESIGN.md](./docs/SLASH-DESIGN.md)。

| 文档 | 用途 |
|------|------|
| [AGENTS.md](./AGENTS.md) | AI / 新窗口第一入口 |
| [docs/CUT-PUZZLE.md](./docs/CUT-PUZZLE.md) | **玩法真源**（已锁规则 + 验证关 + 画面方向） |
| [docs/SLASH-DESIGN.md](./docs/SLASH-DESIGN.md) | 划切规则、参数表、模块 |
| [docs/SLASH-INTENT.md](./docs/SLASH-INTENT.md) | 入点 A、补切、余势、夹缝、乱划、有效刀 |
| [docs/SLASH-FEEL.md](./docs/SLASH-FEEL.md) | 顿帧、震屏、划痕、刀震 |
| [docs/SLASH-RESEARCH.md](./docs/SLASH-RESEARCH.md) | iSlash Masters / 切开几何调研 |
| [docs/SLASH-TECH.md](./docs/SLASH-TECH.md) | 连续滑动切割的技术检索 |
| [docs/SLASH-TRAIL.md](./docs/SLASH-TRAIL.md) | 常规刀痕拖尾 |
| [docs/ENGINEERING.md](./docs/ENGINEERING.md) | 壳的设计决策与踩坑 |
| [docs/ENTRYPOINTS.md](./docs/ENTRYPOINTS.md) | 入口与调用链 |
| [docs/MERGE.md](./docs/MERGE.md) | 双工程合并说明 |
| [docs/AUDIO.md](./docs/AUDIO.md) | 音效（已接 `gameAudio`；批处理为方案） |
| [docs/HAPTICS.md](./docs/HAPTICS.md) | 震动接线（玩法走 `slashHaptics.ts`） |

## 30 秒上手

```bash
npm install
npm run dev
# → http://127.0.0.1:5200/
```

应看到：棋盘格背景，左边是程序画的厚笔记本。第一关是粉色圆纸，接着是两色圆的乌龟，然后是淡紫菱形的鱼。切的时候左上有 Moves，右上有齿轮。轮廓齐了，下方出现「装上」。拼的时候出现「完成」。摆关用 `?edit=1`。规范 [CUT-PUZZLE.md](./docs/CUT-PUZZLE.md)、[UI.md](./docs/UI.md)。

## 合并了什么

| 来自 niantu | 来自 three-webgpu-cap-shell |
|-------------|----------------------------|
| TS strict | `base: './'` |
| 390×844 stage + contain | `contentInset: never` + scroll 关 |
| Phone / Pad 预览 | `--safe-*` HUD + debug |
| `clientToDesign` | `ios:bootstrap` 插件真源 |
| | 可验证 3D demo + 震动按钮 |
| AdvancedHaptics 宽 API | ENGINEERING / ENTRYPOINTS 文档结构 |
| Capacitor 8 + Three 0.178 + Vite 6 | |

## iOS 真机

包名 **`com.wangzhixuan.islash.notebook`**，显示名 **Islash Note**。不要改回 `com.wangzhixuan.islash.cut`，那是手机上已经装好的旧包。

```bash
npm run ios             # 日常：build + sync + 开 Xcode
npm run ios:bootstrap   # 仅首次或改 Swift 插件
```

Xcode：Signing Team → **真机**（不要 Simulator）→ Run。  
改 Swift 必须 bootstrap，否则 Capacitor 8 默认 `CAPBridgeViewController` 不注册插件。

## 复用到新游戏

1. 复制本目录  
2. 改 `capacitor.config.ts` 的 `appId` / `appName`  
3. 在 `src/main.ts` 或 `src/game/*` 写玩法  
4. **保留** adapt / create-renderer / haptics / plugins / `base: './'`  
