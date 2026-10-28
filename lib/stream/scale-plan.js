/**
 * 取流分辨率的"选档"逻辑：**按画布精确反算 scale**。
 *
 * 单独成模块的理由：这段是纯函数、又是画质与解码量的关键取舍点，值得被
 * test-harness 直接 import 断言，而不是只能读 index.js 的源码文本。
 *
 * ── 为什么必须"精确命中画布"，而不是取个整齐的档位 ─────────────────────
 *
 * 真机实测（静态 Settings 页、`mobilecli screencapture --format avc`，
 * 同一条参考窗口内背靠背采集；理想缩略图 = 真机 screenshot 1080×2376 经
 * Pillow LANCZOS 缩到画布尺寸；指标 Sobel 边缘能量比，1.0 = 与理想同锐，
 * 这才是用户说的"糊不糊"）：
 *
 * | 取流 | 画布 | 编码→画布 | 边缘能量比 |
 * |---|---|---|---|
 * | 精确 0.4926 | 532×1170 | **恒等 1.00×** | **1.023** |
 * | 1.000 | 532×1170 | 2.03× 缩小 | 0.994 |
 * | 0.750 | 532×1170 | 1.52× 缩小 | 0.947 |
 * | 0.500 | 532×1170 | 1.02× 缩小 | 0.862 |
 *
 * 机制实验（同一张栅格图走 canvas，隔离编码因素）：恒等绘制 0.967、
 * 1.01× 缩小 **0.854**、1.52× 缩小 0.924。**差的不是编码，是重采样**：
 * 编码端几乎无损（把 540 编码帧按原生尺寸导出与 LANCZOS 比 0.998 边缘比），
 * 而浏览器在"只缩一点点"（1.0–1.1×）时用双线性两抽头，正好把笔画边缘抹成灰。
 *
 * 所以画质最优解是**让编码宽度等于画布后备宽度**：`drawImage` 恒等、一次
 * 重采样都不做。差 1.5% 就掉到 0.862，精确命中反而比原生还锐（1.023）。
 *
 * ── 代价 ────────────────────────────────────────────────────────────────
 *
 * scale 随画布连续变化，客户端拖面板后要重新 grant（仍走既有的 1% 死区 +
 * 稳定 600ms + 5s 冷却 + Host 3 秒节流那套）。稳态下是恒等映射，没有重采样。
 *
 * 收益：画布 532 物理像素时解码量降到 (532/1080)² ≈ **1/4**（0.62 Mpx vs
 * 2.57 Mpx），GPU 每帧纹理上传同比例下降。宽面板（画布 1080）仍是原生 1:1。
 *
 * @module
 */

/** 编码宽度的下限比例（mobilecli `--scale` 的可用范围内；再小就没法读了）。 */
export const MIN_SCALE = 0.35;

/** `--scale` 的精度：mobilecli 按浮点收，4 位小数足够让编码宽度四舍五入到画布宽。 */
const SCALE_PRECISION = 10_000;

/**
 * 按画布需要的物理像素宽度，反算让编码宽度**恰好等于画布**的 scale。
 *
 * 拿不到设备宽度、或客户端没报宽度时一律返回 1（原生）：宁可多解码，也不要
 * 因为信息缺失把画面缩小再放大。
 *
 * 结果夹在 `[MIN_SCALE, 1]`：不放大（画布比设备还宽时最多原生），也留一个
 * 下限避免超窄面板把字压成一团。夹取后就不再是精确命中了，那种情况下
 * 客户端仍会得到"帧 ≥ 画布"或"帧 < 画布"，由既有机制去补救。
 *
 * @param {number|null} wanted 画布物理像素宽度（0/负数/NaN 视为未知）
 * @param {number|null} deviceWidth 设备原生像素宽度
 * @returns {number} 要传给 `mobilecli --scale` 的比例
 */
export function exactScale(wanted, deviceWidth) {
  if (typeof wanted !== "number" || !Number.isFinite(wanted) || wanted <= 0) return 1;
  if (typeof deviceWidth !== "number" || !Number.isFinite(deviceWidth) || deviceWidth <= 0) return 1;
  const raw = wanted / deviceWidth;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const clamped = Math.min(1, Math.max(MIN_SCALE, raw));
  const rounded = Math.round(clamped * SCALE_PRECISION) / SCALE_PRECISION;
  return rounded > 0 ? rounded : MIN_SCALE;
}
