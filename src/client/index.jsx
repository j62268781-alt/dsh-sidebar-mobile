/**
 * dsh-sidebar-mobile — 客户端半边：右侧边栏的「移动设备」tab。
 *
 * ── 这是源码，不是产物 ────────────────────────────────────────────────
 *   本文件（src/client/index.jsx）与 src/client/styles.css 是手写的源码；
 *   仓库里的 lib/client.js 是它们经 `npm run build` 产出的**构建产物**，
 *   也是安装方实际加载的那份。不要直接改 lib/client.js（会被覆盖）。
 *
 * ── 为什么可以写 JSX 了 ──────────────────────────────────────────────
 *   早先这里手写 `h(...)`，因为 DSH 把 client bundle 当**经典脚本**求值：
 *   它只做 `window.__ModuleLoader__` 注册，不做任何转译，运行时解析器
 *   只有「seed word → memoized record → graph row → registered factory」
 *   四条分支，其余一律抛错（原文称其为 build-time bundle purity gate 的
 *   运行时镜像）。所以 JSX 与多文件都必须先经构建 —— 现在就是这么做的。
 *
 *   产物刻意保留 `h(...)` 形态（构建时设 jsxFactory=h），一是与改造前
 *   同构、回归面最小，二是既有的源码断言测试继续有效。
 *
 * ── 两条渲染路径，因为两端给的流格式不同（实测）────────────────────────
 *   Android        → AVC/H.264（104fps）→ 必须用 WebCodecs 解码
 *   iOS 模拟器     → MJPEG（131fps）    → 一个 <img> 就够
 *
 *   iOS 上请求 --format avc 会被 mobilecli 静默降级成 MJPEG，所以**不能靠
 *   请求参数决定用什么渲染器** —— 必须由 Host 从首块字节嗅探出的格式来选。
 *   Host 把结论放在响应头的 content-type 里，这里照着分派。
 *
 *   这也是为什么 MJPEG 那条路用 <img> 而不是 fetch+canvas：multipart/
 *   x-mixed-replace 是浏览器原生支持的格式，<img> 直接渲染，零解码代码、
 *   自动处理分帧、自动跟随重连。自己解 MJPEG 只会更慢更脆。
 *
 * ── 坐标换算 ──────────────────────────────────────────────────────────
 *   面板显示尺寸与设备物理分辨率不同，点击必须先按比例换算回设备坐标。
 *   用 <img>/<canvas> 的实际渲染尺寸而不是 CSS 声明值 —— 对象适应
 *   （object-fit）会让画面留黑边，用声明值算出来的坐标会系统性偏移。
 *
 * @module dsh-sidebar-mobile/client
 */

window.__ModuleLoader__.load({
  id: "@j62268781-alt/dsh-sidebar-mobile",
  factory(require) {
    const React = require("react");
    // JSX 在构建时被编译成 `h(...)` 调用（jsxFactory=h，见 scripts/build-client.mjs），
    // 所以下面这行 h 就是本文件所有 JSX 的运行时落点。
    globalThis.__dshReact = React;
    const h = React.createElement;
    // JSX 片段（<>...</>）编译成 h(Fragment, ...)，Fragment 必须在作用域里。
    const Fragment = React.Fragment;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    // 官方组件库。`@deepseek-ai/dsh-client-ui-primitives` 是**平台 seed 模块**
    // （见 web shell 的 `staticModules`），永远可 require，**不需要**在
    // package.json 的 dsh.client.inject 里声明 —— 官方 terminal 插件就是
    // 直接用它的。用它而不是手搓样式，才能拿到与产品一致的高度、圆角、
    // hover 填充和无障碍语义。
    const { Button, Tooltip, IconChevronDownOutlineRegular } =
      require("@deepseek-ai/dsh-client-ui-primitives");

    /** tab 类型身份，也是 keyed slot 的 key。必须全局唯一。 */
    const TAB_ID = "@j62268781-alt/dsh-sidebar-mobile";
    /** 与 cordis.patch.yml 的 routePrefix 一致。 */
    const PREFIX = "/_dsh/dsh-sidebar-mobile";

    /**
     * 滑动手势的时长夹取范围（毫秒）。
     *
     * 上位由"手指实际按住多久"决定（见 sendPointer），但必须夹住两头：
     *   - 下限：太快会被系统当成点击/抛掷过猛，反而滑不动
     *   - 上限：mobilecli 自身的默认值是 1000ms，实测明显"慢动作"；
     *           600ms 已足够表达"缓慢拖拽"，再长就只是在拖时间
     */
    const MIN_SWIPE_DURATION_MS = 80;
    const MAX_SWIPE_DURATION_MS = 600;
    /**
     * 打开本面板的快捷键命令 id。
     *
     * 形状必须匹配 DSH 的 `commandPattern`（`点分两段`），且全局唯一——
     * 重复注册会直接 throw。guide 入口的 `commandId` 必须与它逐字一致，
     * 胶囊上的快捷键徽标才显示得出来。
     */
    const SHORTCUT_ID = "sidebar.mobile";

    // ── 网络 ────────────────────────────────────────────────────────────

    /**
     * 调 Host 的 POST 路由。
     *
     * 统一处理两件事：非 2xx 时把响应体里的 error 提出来（Host 的报错都是
     * 给人看的，直接抛 "HTTP 500" 会丢掉关键信息）；以及网络失败时给出
     * 可读的中文说明而不是 "Failed to fetch"。
     */
    async function api(route, body) {
      let response;
      try {
        response = await fetch(`${PREFIX}/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch (error) {
        throw new Error(`连不上插件路由（${route}）：${error?.message ?? error}`);
      }

      const text = await response.text();
      let payload;
      try {
        payload = text === "" ? {} : JSON.parse(text);
      } catch {
        throw new Error(`路由 ${route} 返回了非 JSON：${text.slice(0, 200)}`);
      }

      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `路由 ${route} 失败（HTTP ${response.status}）`);
      }
      return payload;
    }

    // ── 样式 ────────────────────────────────────────────────────────────
    //
    // 用 DSH 的设计 token（--dsw-*），跟随主题明暗；没有 token 时回落到
    // 一套中性值，保证在旧版本上也不会白底白字。

    // 样式在 src/client/styles.css，构建时经此占位符内联（见 scripts/build-client.mjs）。
    const CSS = __CLIENT_CSS__;

    // ── H.264 解码 ──────────────────────────────────────────────────────
    //
    // mobilecli 的 AVC 输出是裸 Annex B 码流（带起始码，无容器）。WebCodecs
    // 吃这种格式需要两件事：告诉它 avc.format='annexb'，以及一个正确的
    // codec 字符串（avc1.PPCCLL）。后者只能从 SPS 里读——写死一个会在
    // 不同设备/分辨率上失败。

    /**
     * 从 SPS 推出 WebCodecs 需要的 codec 字符串。
     *
     * ⚠️ 必须**先跳过起始码**。`splitAnnexB` 是有意保留起始码的（WebCodecs 在
     * annexb 模式下要的正是带起始码的完整 NAL），所以这里拿到的 nal 形如：
     *
     *     00 00 00 01 | 67 | 64 00 32 | ...
     *     └─起始码──┘  │    └─PPCCLL─┘
     *                  └─ NAL 头（低 5 位 = 7，即 SPS）
     *
     * 于是 profile_idc 在 `offset + 1`，不是 `nal[1]`。
     * 曾经写成 `nal[1..3]`，读到的是**起始码本身**，得到 "avc1.000001" ——
     * Chrome 判为 "Unknown or ambiguous codec name." 并立刻把解码器置为 closed，
     * 之后每次 decode() 都抛 "Cannot call 'decode' on a closed codec"。
     * 复现：Android 一加 12 实测，SPS = 00 00 00 01 67 64 00 32 → 应为 avc1.640032。
     *
     * @param {Uint8Array} nal 含起始码与 NAL 头的完整 SPS
     * @returns {string}
     */
    function codecStringFromSps(nal) {
      // 起始码：3 字节（00 00 01）或 4 字节（00 00 00 01）
      let offset = 0;
      if (nal[2] === 1) offset = 3;
      else if (nal[2] === 0 && nal[3] === 1) offset = 4;

      // offset 是 NAL 头；profile_idc 紧随其后
      const profile = offset + 1;
      if (profile + 3 > nal.length) return "avc1.42E01F";
      const hex = (value) => value.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[profile])}${hex(nal[profile + 1])}${hex(nal[profile + 2])}`;
    }

    /**
     * 把 Annex B 字节流切成访问单元。
     *
     * 起始码是 00 00 01（3 字节）或 00 00 00 01（4 字节）。这里按起始码切分，
     * 保留每段各自的起始码——WebCodecs 在 annexb 模式下期望的正是带起始码的
     * 完整 NAL。
     *
     * 跨 chunk 的半个 NAL 必须留住：TCP 分片不会体贴地在 NAL 边界断开，
     * 直接丢弃残段会导致解码器持续报错或花屏。
     *
     * @param {Uint8Array} carry 上次未消费完的尾部
     * @param {Uint8Array} chunk 新到的字节
     * @returns {{units: Uint8Array[], rest: Uint8Array}}
     */
    function splitAnnexB(carry, chunk) {
      const buffer = new Uint8Array(carry.length + chunk.length);
      buffer.set(carry, 0);
      buffer.set(chunk, carry.length);

      /** 找出所有起始码的位置 */
      const starts = [];
      for (let i = 0; i + 3 <= buffer.length; i++) {
        if (buffer[i] === 0 && buffer[i + 1] === 0) {
          if (buffer[i + 2] === 1) {
            starts.push(i);
            i += 2;
          } else if (buffer[i + 2] === 0 && i + 4 <= buffer.length && buffer[i + 3] === 1) {
            starts.push(i);
            i += 3;
          }
        }
      }

      // 第一个起始码之前的字节是无效前缀，丢掉
      if (starts.length === 0) {
        // 全是要留的尾巴？只有可能是末尾的 00 00 00 —— 留着等下一块
        const keep = Math.min(buffer.length, 3);
        return { units: [], rest: buffer.subarray(buffer.length - keep) };
      }

      const units = [];
      for (let i = 0; i < starts.length - 1; i++) {
        units.push(buffer.subarray(starts[i], starts[i + 1]));
      }
      // 最后一段可能还没收完，留到下一轮
      const rest = buffer.subarray(starts[starts.length - 1]);
      return { units, rest };
    }

    /** 从 NAL 取出类型（低 5 位）。7=SPS，5=IDR（关键帧），1=非 IDR 片。 */
    function nalType(unit) {
      // 跳过起始码
      let offset = 0;
      if (unit[2] === 1) offset = 3;
      else if (unit[2] === 0 && unit[3] === 1) offset = 4;
      return offset < unit.length ? unit[offset] & 0x1f : 0;
    }

    /**
     * 渲染帧率上限（帧/秒）。
     *
     * ⚠️ 为什么必须在这里限，而不是让 mobilecli 限：
     * **mobilecli 的 `--fps` 是无效的**。实测（Xiaomi 15 Pro / 1080×2400）：
     *
     *     不传 --fps        → 120.6 fps
     *     --fps 30          → 105.5 fps
     *     --fps 15          → 100.7 fps
     *
     * 即：传什么都是 ~120fps。所以限流只能自己做。
     *
     * ⚠️ 而且**只能丢渲染，不能丢解码**：
     * H.264 的 P 帧依赖前面的帧做参考。从解码队列里丢弃一个 P 帧，后续帧
     * 就失去了参考 → 解出破损画面（大面积色块/拖影），或者直接报错进入
     * "等下一个关键帧"状态 —— 而实测 IDR 间隔在静止时可达 **3–4 秒**。
     * 那正是"滑动时屏幕花了"的成因。所以解码必须完整，只对**绘制**限流。
     *
     * 解码本身是硬件加速的、很便宜；贵的是主线程上的 drawImage。
     * 丢掉多余的绘制既能保住码流完整，又直接把主线程负担降下来。
     */
    const TARGET_RENDER_FPS = 30;

    /**
     * 把若干 NAL 拼成一个缓冲区，用于"关键帧自带参数集"。
     *
     * 不能直接 `sps + pps + unit`：这几个是同一个大 buffer 上的 subarray，
     * 各段仍带着自己的起始码，但拼字符串/数组会把 Uint8Array 变成逗号串。
     * 每段都自带起始码，所以顺序拼接即是合法的 Annex B 访问单元。
     *
     * @param {...Uint8Array} parts
     * @returns {Uint8Array}
     */
    function concatBytes(...parts) {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }

    /**
     * 把 canvas 对齐到「容器内按真实宽高比 contain 后的尺寸 × devicePixelRatio」。
     *
     * ── 为什么不能读 canvas 自己的 getBoundingClientRect ────────────────
     *
     * 曾经这么写过，结果是**画面被压成一条横向小条**（真机截图确认）。
     * 原因是循环依赖：
     *
     *   <canvas> 没设 CSS 尺寸时，默认是 **300×150**（宽高比 2.0）；
     *   `.mbm-media` 只有 max-width/max-height，元素就按这个内在尺寸排版；
     *   于是 getBoundingClientRect 读到 300×150 → 后备存储设成 600×300 →
     *   显示尺寸依然是 300×150（max-* 限制下不变）→ 自洽地卡在 2.0，
     *   与设备的 1080×2376（宽高比 0.45）毫无关系。
     *
     * 实测复现：连续 6 帧都停在 330×165（=2.0），而正确值应是 ~318×700。
     *
     * 所以尺寸必须由**帧的真实宽高比**和**父容器的可用空间**推出，
     * 再把结果写回 CSS 尺寸与后备存储 —— 两者一起定，才是收敛的。
     *
     * ── 两个尺寸的分工 ──────────────────────────────────────────────
     *
     *   CSS 尺寸（style.width/height）决定**显示多大**：按 contain 缩放，
     *   保证不变形、不溢出容器。
     *   后备存储（canvas.width/height）决定**画多少像素**：= CSS × DPR，
     *   1:1 映射到物理像素，最清晰且不浪费。
     *
     * ⚠️ 改 canvas.width/height 会清空画布并重置 2D 上下文状态，所以只在
     * 尺寸真的变了才写 —— 否则每帧都在清屏。
     *
     * @param {HTMLCanvasElement} canvas
     * @param {number} frameWidth 真实帧宽（设备像素）
     * @param {number} frameHeight 真实帧高（设备像素）
     * @returns {{width: number, height: number}|null} 设置后的 CSS 尺寸；算不出时为 null
     */
    function fitCanvasToFrame(canvas, frameWidth, frameHeight) {
      if (!(frameWidth > 0) || !(frameHeight > 0)) return null;

      // 可用空间取父容器（.mbm-stage）的内容盒。不能用 canvas 自己的矩形：
      // 那正是上面说的循环依赖。
      const parent = canvas.parentElement;
      if (parent === null) return null;
      const style = getComputedStyle(parent);
      const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availWidth = parent.clientWidth - (Number.isFinite(paddingX) ? paddingX : 0);
      const availHeight = parent.clientHeight - (Number.isFinite(paddingY) ? paddingY : 0);
      if (availWidth <= 0 || availHeight <= 0) return null; // 还没布局出来，等下一帧

      // contain：等比缩放到刚好装进容器
      const scale = Math.min(availWidth / frameWidth, availHeight / frameHeight);
      const cssWidth = Math.max(1, Math.round(frameWidth * scale));
      const cssHeight = Math.max(1, Math.round(frameHeight * scale));

      if (canvas.style.width !== `${cssWidth}px`) canvas.style.width = `${cssWidth}px`;
      if (canvas.style.height !== `${cssHeight}px`) canvas.style.height = `${cssHeight}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2); // 2 以上收益极小，白白费算力
      const bufferWidth = Math.max(1, Math.round(cssWidth * dpr));
      const bufferHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
      }
      return { width: cssWidth, height: cssHeight };
    }

    /**
     * 用 WebCodecs 把 H.264 流画到 canvas 上。
     *
     * 关键取舍：
     * - optimizeForLatency: true —— 实时画面要的是低延迟，不是压缩率。
     *   不开这个，解码器会缓冲若干帧再吐，体感延迟明显。
     * - 解码器报错后**不重建**在同一个实例上硬撑，而是整体复位重来：
     *   一旦码流错位（丢包、中途接入），继续喂只会持续报错。
     * - 首帧到达前不显示 canvas，避免一块黑框闪一下。
     *
     * @param {string|null} streamUrl
     * @param {object} canvasRef canvas 的 ref
     * @param {Function} onState 状态回调
     * @param {object} frameSizeRef 输出参数，写入**真实帧尺寸**（设备像素）。
     *   ⚠️ 坐标换算必须用它，不能用 canvas.width —— 后备存储是
     *   "显示尺寸 × DPR"，与设备分辨率无关（见 fitCanvasToFrame）。
     */
    function useH264Canvas(streamUrl, canvasRef, onState, frameSizeRef) {
      useEffect(() => {
        if (streamUrl === null) return undefined;

        let cancelled = false;
        let decoder = null;
        let reader = null;
        /** 停流看门狗计时器（见 run() 里的 STALL_TIMEOUT_MS）。 */
        let stallTimer = null;
        /**
         * 累计收到的字节数。
         *
         * 用来判断"这一轮 run() 到底有没有工作过"：大于本轮开始时，
         * 说明流是健康的 → 重连退避复位（见 runWithReconnect）。
         */
        let bytesReceived = 0;
        let carry = new Uint8Array(0);
        let timestamp = 0;
        let configured = false;
        /** 最近一次从 SPS 解出的 codec 字符串；复位解码器时要用它。 */
        let activeCodec = null;
        /**
         * 缓存的参数集（SPS / PPS）。
         *
         * 关键帧必须与它们拼在一起喂 —— 实测参数集单独成 chunk 会导致
         * 整段流一帧都解不出来（详见下面关键帧处的注释）。
         */
        let sps = null;
        let pps = null;
        /**
         * 是否必须等下一个关键帧才能继续喂。
         *
         * 解码器刚建好、或刚解出一个 chunk 失败时置 true —— 这两种情况下
         * 立刻喂非关键帧会让解码器报错（实测）。
         */
        let needsKeyframe = true;
        let frames = 0;
        /** 上次真正绘制的时间戳，用于渲染限流（见 output 回调）。 */
        let lastDrawAt = 0;

        const report = (state, detail) => {
          if (!cancelled) onState(state, detail);
        };

        /**
         * 建（或重建）解码器。
         *
         * ⚠️ `configure()` 对**无效 codec 不抛同步异常**：它先把 state 报成
         * "configured"，随后异步触发 error 回调并把 state 置为 "closed"。
         * 所以不能靠 try/catch 判断成败，也不能建完就当它可用 ——
         * 主循环每轮都会检查 `decoder.state === "closed"` 并据此重建。
         *
         * @param {string} codec avc1.PPCCLL，由 codecStringFromSps 从真实 SPS 解出
         */
        const buildDecoder = (codec) => {
          if (decoder !== null) {
            try {
              decoder.close();
            } catch {
              // 已关闭
            }
          }
          decoder = new VideoDecoder({
            output: (frame) => {
              const canvas = canvasRef.current;
              // 记下真实帧尺寸（设备像素）供坐标换算用 —— 后备存储已经不等于它了
              if (frameSizeRef !== undefined) {
                frameSizeRef.current = {
                  width: frame.displayWidth,
                  height: frame.displayHeight,
                };
              }

              /**
               * ── 渲染限流（不是解码限流）──────────────────────────────
               *
               * mobilecli 的 `--fps` 无效，实测恒定 ~120fps。解码本身很便宜
               * （硬件加速），贵的是主线程上的 drawImage：120fps × 后备存储
               * 会把主线程占满，点击事件只能排队。
               *
               * 所以这里**每一帧都解码**（保住 H.264 参考链完整，不会花屏），
               * 但只按 TARGET_RENDER_FPS 绘制。多余的直接 close 掉。
               *
               * ⚠️ frame 必须 close，否则解码器很快会因为拿不到输出缓冲而卡死。
               */
              const now = performance.now();
              if (canvas !== null && now - lastDrawAt >= 1000 / TARGET_RENDER_FPS) {
                lastDrawAt = now;
                // 按帧的真实宽高比定尺寸（不能读 canvas 自己的矩形 —— 那是循环依赖）
                fitCanvasToFrame(canvas, frame.displayWidth, frame.displayHeight);
                const ctx2d = canvas.getContext("2d");
                if (ctx2d !== null) {
                  ctx2d.drawImage(frame, 0, 0, canvas.width, canvas.height);
                }
              }

              frames += 1;
              if (frames === 1) report("playing");
              else if (frames % 30 === 0) report("playing", { frames });
              frame.close();
            },
            error: (error) => {
              // 不在这里重建：交给下面的循环统一复位。
              // 报错本身要显示出来，否则"黑屏但不报错"极难定位。
              report("error", `解码器错误：${error?.message ?? String(error)}`);
            },
          });
          decoder.configure({
            codec,
            avc: { format: "annexb" },
            optimizeForLatency: true,
          });
          // 新解码器必须先见到关键帧（否则立刻报错），所以复位这个标记
          needsKeyframe = true;
          configured = true;
          activeCodec = codec;
        };

        const run = async () => {
          report("connecting");
          let response;
          try {
            response = await fetch(streamUrl, { cache: "no-store" });
          } catch (error) {
            report("error", `取流失败：${error?.message ?? error}`);
            return;
          }
          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            report("error", `取流失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 160)}` : ""}`);
            return;
          }
          if (response.body === null) {
            report("error", "响应没有可读的流");
            return;
          }

          reader = response.body.getReader();

          /**
           * ── 停流看门狗 ────────────────────────────────────────────────
           *
           * ⚠️ **少了它，流一旦停住，画面就永久死在那儿**（用户实测报告：
           * "滚动的时候解码器发生错误了，然后画面直接死了"）。
           *
           * 机制：Host 侧的流进程崩溃后会自己重启（StreamSession 的
           * `#scheduleRestart`），但**浏览器这条 HTTP 响应不会被关闭** ——
           * 它只是不再有新数据。于是 `reader.read()` 永远挂着，
           * 既不 done 也不 error，客户端毫无察觉。
           *
           * 所以这里自己数"多久没收到字节"，超时就主动断开重连。
           * 阈值取 3000ms：正常流实测 ~120fps（每帧 8ms 级），
           * 即使设备卡顿，3 秒没有任何字节也一定是出问题了。
           *
           * 注意只监控**有没有数据**，不监控帧率 —— 静止画面时编码器
           * 可能只发很稀疏的帧，按帧率判断会误杀。
           */
          const STALL_TIMEOUT_MS = 3000;
          let lastByteAt = performance.now();
          stallTimer = setInterval(() => {
            if (cancelled) return;
            if (performance.now() - lastByteAt > STALL_TIMEOUT_MS) {
              report("connecting", "画面卡住了，正在重连…");
              // 断开读取循环 → 下面的 finally 收尾 → 外层循环会重连
              void reader?.cancel().catch(() => {});
            }
          }, 500);

          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (cancelled || done) break;
              lastByteAt = performance.now();
              bytesReceived += value?.byteLength ?? 0;

              const { units, rest } = splitAnnexB(carry, value);
              carry = rest;

              for (const unit of units) {
                const type = nalType(unit);

                // SPS：解出 codec 字符串，并缓存原始字节（下面拼关键帧要用）。
                if (type === 7) {
                  const codec = codecStringFromSps(
                    new Uint8Array(unit.buffer, unit.byteOffset, unit.length),
                  );
                  if (!configured || decoder.state === "closed") {
                    try {
                      buildDecoder(codec);
                    } catch (error) {
                      report("error", `解码器初始化失败：${error?.message ?? error}`);
                      return;
                    }
                  }
                  // 记下 codec 字符串：解码器崩了之后要靠它重建，而整段流可能
                  // 只有一个 SPS（实测 Android 8 秒流里 SPS 只出现 1 次）。
                  activeCodec = codec;
                  sps = unit;
                  continue;
                }

                // PPS：同样只缓存，不单独喂（原因见下面关键帧那段）。
                if (type === 8) {
                  pps = unit;
                  continue;
                }

                // 还没拿到参数集，片数据没法解
                if (!configured || activeCodec === null) continue;
                if (type !== 1 && type !== 5) continue;

                // 解码器已 closed（丢包/抖动/中途接入）→ 用已知的 codec 重建。
                // 不能傻等下一个 SPS：它只在流开头出现一次，等不到。
                if (decoder.state === "closed") {
                  try {
                    buildDecoder(activeCodec);
                  } catch {
                    continue;
                  }
                }

                const isKey = type === 5;
                // 重建之后必须从关键帧起解，否则会报
                // "A key frame is required after configure() or flush()"。
                // 关键帧之前的非关键帧直接丢掉（实测 IDR 间隔在静止时可达
                // 3–4 秒、滑动中约 1 秒，所以最多丢几秒）。
                if (needsKeyframe && !isKey) continue;
                if (isKey) needsKeyframe = false;

                timestamp += 33_333; // ~30fps 的时间基，仅用于排序

                // ⚠️ 关键帧必须**把 SPS+PPS 拼在自己前面**一起喂。
                //
                // 实测（真实 Android 流 369KB / 331 个 NAL，逐个策略跑 WebCodecs）：
                //   SPS/PPS 当独立 chunk 喂（或完全跳过）→ 解码 0 帧
                //   SPS+PPS 拼进关键帧 chunk            → 解码 1338 帧，零报错
                //
                // 原因是解码器需要的是"一个自带参数集的关键帧访问单元"；
                // 参数集单独成一个 chunk 时，它要么被当成无效帧丢掉，要么让
                // 解码器进入等待关键帧的状态，于是整段流一帧都出不来 ——
                // 表现为**黑屏但不报错**，比报错更难查。
                const payload = isKey && sps !== null && pps !== null
                  ? concatBytes(sps, pps, unit)
                  : unit;

                try {
                  decoder.decode(
                    new EncodedVideoChunk({
                      type: isKey ? "key" : "delta",
                      timestamp,
                      data: payload,
                    }),
                  );
                } catch (error) {
                  // 单个 chunk 失败不致命：标记等关键帧，从下一个 IDR 恢复
                  needsKeyframe = true;
                  report("error", `解码失败：${error?.message ?? error}`);
                }
              }
            }
          } catch (error) {
            if (!cancelled) report("error", `读取流失败：${error?.message ?? error}`);
          } finally {
            if (stallTimer !== null) {
              clearInterval(stallTimer);
              stallTimer = null;
            }
            try {
              await reader?.cancel();
            } catch {
              // 已关闭
            }
            reader = null;
          }
        };

        /**
         * ── 断流自动重连 ────────────────────────────────────────────────
         *
         * 一次 `run()` 结束（流被关掉 / 卡住被看门狗掐断 / 读取出错）后，
         * 隔一会儿重来，而不是把画面永久留在"流已结束"。
         *
         * ⚠️ 为什么必须有：Host 侧流进程崩溃时**不会关闭**浏览器这条响应，
         * 所以 `reader.read()` 会一直挂着；即使响应真的结束了，
         * 老代码也只是 `report("ended")` 就返回 —— useEffect 的依赖
         * （streamUrl）没变，于是**再也不会重新取流**。
         *
         * 退避：1s 起，每次失败翻倍，上限 8s。不做无限快重试 ——
         * 设备真的离线时，快重试只会把日志刷满、并让设备端不断启停 agent。
         * 首次成功收到字节后（下面重置）退避归 1s，所以偶发抖动能立刻恢复。
         */
        const RECONNECT_BASE_MS = 1000;
        const RECONNECT_MAX_MS = 8000;
        let reconnectDelay = RECONNECT_BASE_MS;

        const runWithReconnect = async () => {
          for (;;) {
            const before = bytesReceived;
            await run();
            if (cancelled) return;

            // 这一轮收到过数据 → 视为健康，退避重置（抖动后能快速恢复）
            if (bytesReceived > before) reconnectDelay = RECONNECT_BASE_MS;

            report("connecting", "画面中断，正在重连…");
            await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
            if (cancelled) return;
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          }
        };

        // WebCodecs 不可用（旧浏览器、非安全上下文）时明确说出来，
        // 而不是留一块空白让用户猜。
        if (typeof VideoDecoder === "undefined") {
          report(
            "error",
            "此浏览器不支持 WebCodecs，无法解码 H.264 画面。"
              + " 用较新的 Chrome/Edge，或从 HTTPS 或 localhost 打开。",
          );
          return undefined;
        }

        void runWithReconnect();

        return () => {
          cancelled = true;
          if (stallTimer !== null) {
            clearInterval(stallTimer);
            stallTimer = null;
          }
          try {
            reader?.cancel();
          } catch {
            // 已关闭
          }
          try {
            if (decoder !== null && decoder.state !== "closed") decoder.close();
          } catch {
            // 已关闭
          }
        };
      }, [streamUrl]);
    }

    // ── 画面组件 ────────────────────────────────────────────────────────

    /**
     * 实时画面。按 Host 嗅探出的格式选渲染路径。
     *
     * 点击/拖拽都换算成设备坐标再发给 Host。
     */
    function StreamView({ deviceId, streamToken, format, frame, onError }) {
      const [state, setState] = useState("idle");
      const [detail, setDetail] = useState(null);
      const canvasRef = useRef(null);
      const mediaRef = useRef(null);
      /**
       * 手势起点（设备坐标）。
       *
       * ⚠️ 用 ref 而不是 state：`pointerdown` 里的 setState 是异步的，
       * 如果用户在**同一批**里就抬手（快速点按），`pointerup` 读到的
       * `size` 还是上一次手势的起点 —— 判定的位移完全是错的，会把一次
       * 点击判成滑动（或反之）。ref 是同步写入的，没有这个窗口。
       */
      const gestureRef = useRef(null);
      /** H.264 的真实帧尺寸（设备像素）。canvas 后备存储已不等于它。 */
      const frameSizeRef = useRef({ width: 0, height: 0 });

      const streamUrl = streamToken === null ? null : `${PREFIX}/stream/${encodeURIComponent(streamToken)}`;

      // MJPEG 走 <img>；H.264 走 canvas + WebCodecs
      const isMjpeg = format === "mjpeg";
      useH264Canvas(
        isMjpeg || streamUrl === null ? null : streamUrl,
        canvasRef,
        (next, info) => {
          setState(next);
          if (info !== undefined) setDetail(info);
          if (next === "error" && typeof info === "string") onError?.(info);
        },
        frameSizeRef,
      );

      // MJPEG 的加载状态由 <img> 事件驱动
      useEffect(() => {
        if (!isMjpeg) return undefined;
        setState(streamUrl === null ? "idle" : "connecting");
        return undefined;
      }, [isMjpeg, streamUrl]);

      /**
       * 把一次指针事件换算成设备坐标并发给 Host。
       *
       * 用元素的 getBoundingClientRect 而不是 CSS 声明尺寸：object-fit
       * 会在画面比例与容器不一致时留黑边，用声明值算出来的坐标会系统性偏移。
       * 这里按"画面在容器内实际占用的矩形"换算。
       *
       * ⚠️ H.264 路径的"画面固有尺寸"来自 frameSizeRef（真实帧尺寸），
       * **不是** canvas.width —— 后备存储现在是"显示尺寸 × DPR"，把它当设备
       * 分辨率会让所有坐标系统性偏移。
       */
      const sendPointer = useCallback(
        async (event, phase) => {
          const element = isMjpeg ? mediaRef.current : canvasRef.current;
          if (element === null || deviceId === null) return;

          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          // 画面固有尺寸：<img> 用 naturalWidth；canvas 用真实帧尺寸
          const naturalWidth = isMjpeg ? element.naturalWidth : frameSizeRef.current.width;
          const naturalHeight = isMjpeg ? element.naturalHeight : frameSizeRef.current.height;
          if (!naturalWidth || !naturalHeight) return;

          // object-fit: contain —— 算出画面在容器里的实际显示矩形
          const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
          const shownWidth = naturalWidth * scale;
          const shownHeight = naturalHeight * scale;
          const offsetX = (rect.width - shownWidth) / 2;
          const offsetY = (rect.height - shownHeight) / 2;

          const localX = event.clientX - rect.left - offsetX;
          const localY = event.clientY - rect.top - offsetY;

          // 落在黑边上：不是对设备的操作，忽略
          if (localX < 0 || localY < 0 || localX > shownWidth || localY > shownHeight) return;

          const x = Math.round((localX / shownWidth) * naturalWidth);
          const y = Math.round((localY / shownHeight) * naturalHeight);

          if (phase === "down") {
            // 同步写 ref：同批内的 pointerup 立刻能读到正确起点
            gestureRef.current = { x, y, at: event.timeStamp };
            return;
          }
          if (phase === "up") {
            const start = gestureRef.current;
            gestureRef.current = null;
            // 没有起点（例如从黑边按下）就没法判定，忽略这次抬手
            if (start === null) return;

            const dx = Math.abs(x - start.x);
            const dy = Math.abs(y - start.y);
            // 位移够大算滑动，否则算点击。阈值按设备坐标给（约 2% 屏幕宽），
            // 太小会把手指抖动误判成滑动。
            const threshold = Math.max(12, Math.round(naturalWidth * 0.02));
            try {
              if (dx > threshold || dy > threshold) {
                /**
                 * 滑动的 `--duration` 取"手指实际按住的时间"，并夹在
                 * [MIN, MAX] 之间 —— 这样慢拖和快甩的手感不同，跟手指一致。
                 *
                 * ⚠️ 为什么不做 pointermove 逐点跟随：每个手势都是一次
                 * mobilecli 进程调用。实测一次 `io swipe`（含 --duration）
                 * 要 175–370ms，逐点发（每秒 8 次以上）只会把进程和 adb
                 * 排成一队，反而更卡。CLI 这条路径下"一次手势一条命令"是
                 * 唯一能保持跟手的做法；真要逐点跟随得走 mobilecli 的
                 * JSON-RPC `device.io.gesture`（可链式发指针事件）。
                 */
                const heldMs = Math.max(0, event.timeStamp - start.at);
                const duration = Math.min(
                  MAX_SWIPE_DURATION_MS,
                  Math.max(MIN_SWIPE_DURATION_MS, Math.round(heldMs)),
                );
                await api("control", {
                  action: "swipe",
                  x1: start.x, y1: start.y, x2: x, y2: y,
                  duration,
                });
              } else {
                await api("control", { action: "tap", x, y });
              }
            } catch (error) {
              onError?.(error?.message ?? String(error));
            }
          }
        },
        [deviceId, isMjpeg, onError],
      );

      const interactive = deviceId !== null && (state === "playing" || isMjpeg);

      /**
       * ── 物理键盘透传 ────────────────────────────────────────────────
       *
       * 目标：在设备里点开一个输入框，然后用电脑键盘直接打字 —— 手机输入法
       * 在侧边栏里没法用，这是唯一的输入途径。
       *
       * 三个约束决定了实现形状：
       *
       * ① **作用域必须限定在画面区域**。面板嵌在 DSH 网页里，全局监听
       *    keydown 会吞掉 DSH 自己的快捷键（⌘⇧M 等）和对话输入框的按键。
       *    所以键盘事件只挂在**获得焦点的 canvas/img** 上（靠 tabIndex 聚焦），
       *    失焦即停止捕获。
       *
       * ② **按键必须合批**。每条 mobilecli 命令实测约 100ms（62ms 进程启动
       *    + 41ms daemon/adb 往返），逐字符发根本没法打字。`io keys` 接受
       *    多个键，所以这里攒一小段时间（KEY_BATCH_MS）再一次性发出去。
       *    实测一次发 3 个键与发 1 个键耗时相同。
       *
       * ③ **ASCII 与 Unicode 走不同通道**。ASCII 可打印字符走 `keys`
       *    （真按键，能看到输入法响应）；非 ASCII 用 `io text`（实测中文、
       *    emoji、日文、韩文、带音标的拉丁文都能送达，不需要 ADBKeyboard）。
       *
       * ⚠️ 不处理 `keydown` 的修饰键本身（Shift/Ctrl/Alt/Meta 单独按下时
       * `key` 是 "Shift" 这类名字），它们在组合键里通过 event.shiftKey 等
       * 参与，不能作为独立按键发出去。
       */
      const KEY_BATCH_MS = 40;

      /**
       * 把一次按键翻译成"要发什么"。
       *
       * ASCII 走真按键（设备输入法能看到响应）；非 ASCII 走 `io text`
       * —— 实测中文/emoji/日文/韩文/带音标拉丁文都能送达，无需 ADBKeyboard。
       *
       * @returns {{kind: "key"|"text", value: string}|null} null = 不发送
       */
      function translateKey(event) {
        const { key } = event;
        if (typeof key !== "string" || key === "") return null;

        // 修饰键本身不是要发给设备的"按键"（它们通过 event.shiftKey 等参与组合）
        if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;

        const named = {
          Enter: "enter",
          Backspace: "backspace",
          Delete: "forwarddelete",
          Escape: "escape",
          Tab: "tab",
          " ": "space",
          ArrowUp: "up",
          ArrowDown: "down",
          ArrowLeft: "left",
          ArrowRight: "right",
          Home: "home",
          End: "end",
          PageUp: "pageup",
          PageDown: "pagedown",
        };
        const name = named[key];
        if (name !== undefined) return { kind: "key", value: name };

        /**
         * 长度判断用 Array.from 而不是 key.length：emoji 这类补充平面字符
         * 在 JS 里是**代理对**（"🎉".length === 2），用 length 会被当成
         * "不是单字符"而丢掉。同理 charCodeAt 只取到半个代理对，要用
         * codePointAt 才能拿到真实码点。
         */
        const chars = Array.from(key);
        if (chars.length !== 1) return null; // F1 / Insert / Dead 之类，不猜

        const codePoint = key.codePointAt(0);
        if (codePoint >= 32 && codePoint < 127) {
          return { kind: "key", value: withModifiers(key.toLowerCase(), event) };
        }
        return { kind: "text", value: key };
      }

      /** 把当前修饰键状态拼成组合键，例如 ctrl+shift+a。 */
      function withModifiers(base, event) {
        // 修饰键组合只对单字符有意义；enter/backspace 这类直接发
        if (base.length !== 1) return base;
        const parts = [];
        if (event.ctrlKey) parts.push("ctrl");
        if (event.metaKey) parts.push("cmd");
        if (event.altKey) parts.push("alt");
        if (event.shiftKey) parts.push("shift");
        if (parts.length === 0) return base;
        return [...parts, base].join("+");
      }

      const keyQueueRef = useRef([]);
      const keyTimerRef = useRef(null);

      /** 把攒下的按键一次性发出去。 */
      const flushKeys = useCallback(async () => {
        keyTimerRef.current = null;
        const pending = keyQueueRef.current;
        keyQueueRef.current = [];
        if (pending.length === 0) return;

        // ASCII 按键走 keys；非 ASCII（中文等）走 text
        const asciiKeys = pending.filter((item) => item.kind === "key").map((item) => item.value);
        const texts = pending.filter((item) => item.kind === "text").map((item) => item.value);
        try {
          if (asciiKeys.length > 0) await api("control", { action: "keys", keys: asciiKeys });
          for (const text of texts) await api("control", { action: "text", text });
        } catch (error) {
          onError?.(error?.message ?? String(error));
        }
      }, [onError]);

      /** 入队并安排一次合批发送。 */
      const enqueueKey = useCallback(
        (item) => {
          // 非 ASCII 必须保持顺序，且不能和按键混在一批里（通道不同）
          const queue = keyQueueRef.current;
          queue.push(item);
          if (keyTimerRef.current === null) {
            keyTimerRef.current = setTimeout(() => void flushKeys(), KEY_BATCH_MS);
          }
        },
        [flushKeys],
      );

      // 卸载时清掉待发计时器，否则会对已失效的组件调用 api
      useEffect(
        () => () => {
          if (keyTimerRef.current !== null) {
            clearTimeout(keyTimerRef.current);
            keyTimerRef.current = null;
          }
          keyQueueRef.current = [];
        },
        [],
      );

      const keyboardHandlers = interactive
        ? {
            onKeyDown: (event) => {
              /**
               * Ctrl/Cmd 组合大多留给浏览器与 DSH（⌘R 刷新、⌘⇧M 打开面板、
               * ⌘C 复制…）。只有几个明确要送给设备的**编辑类**组合键才接管，
               * 其余一律放行 —— 面板里按 ⌘R 却刷新不了页面会很困惑。
               */
              if (event.metaKey || event.ctrlKey) {
                const probe = translateKey(event);
                const EDIT_KEYS = new Set(["a", "c", "v", "x", "z", "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z", "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z"]);
                if (probe === null || !EDIT_KEYS.has(probe.value)) return;
              }

              const item = translateKey(event);
              if (item === null) return;

              /**
               * 阻止默认行为：否则 Tab 会移动焦点、空格会滚动页面、
               * 方向键会滚动面板 —— 用户是在操作设备，不是在操作网页。
               */
              event.preventDefault();
              enqueueKey(item);
            },
            /**
             * 输入法合成（macOS 拼音、日文假名等）。
             *
             * ⚠️ **少了这个，中文就打不进来** —— 而中文场景恰恰是最需要
             * 物理键盘的（侧边栏里没法用手机输入法）。合成过程中浏览器发的
             * keydown 里 `key` 是 "Process"，`translateKey` 认不出（这是对的，
             * 那时还没定下要输入什么）；真正的文本只在 `compositionend`
             * 的 `data` 里。
             *
             * 所以：合成期间不处理按键，提交时把整段文本交给 `io text`。
             * 实测 `io text` 能送中文/emoji/日文/韩文（不需要 ADBKeyboard）。
             */
            onCompositionEnd: (event) => {
              const text = event.data;
              if (typeof text !== "string" || text === "") return;
              enqueueKey({ kind: "text", value: text });
            },
            onPaste: (event) => {
              // 剪贴板里的任意文本走 io text（ASCII 与中文都行）
              const text = event.clipboardData?.getData("text");
              if (typeof text !== "string" || text === "") return;
              event.preventDefault();
              enqueueKey({ kind: "text", value: text });
            },
          }
        : {};

      /**
       * 指针事件绑定。
       *
       * `onPointerCancel` 必须有：指针被系统取消（触摸变成滚动、Alt+Tab、
       * 元素被卸载）时浏览器**不会**补发 pointerup。少了它，
       * `gestureRef` 会一直留着上一次的起点，下一次抬手就会拿着一个
       * 早已过期的起点算位移 —— 表现为"偶尔莫名其妙地滑一下"。
       */
      const pointerHandlers = {
        onPointerDown: (e) => void sendPointer(e, "down"),
        onPointerUp: (e) => void sendPointer(e, "up"),
        onPointerCancel: () => {
          gestureRef.current = null;
        },
      };

      // tabIndex 让画面可聚焦 —— 键盘只在聚焦时被捕获（见 keyboardHandlers）
      const media = isMjpeg ? (
        <img
          ref={mediaRef}
          className="mbm-media"
          src={streamUrl ?? undefined}
          alt="设备画面"
          draggable={false}
          tabIndex={interactive ? 0 : undefined}
          onLoad={() => setState("playing")}
          onError={() => {
            const message = "MJPEG 流加载失败，检查设备是否仍在线。";
            setState("error");
            onError?.(message);
          }}
          {...pointerHandlers}
          {...keyboardHandlers}
          style={{ cursor: interactive ? "crosshair" : "default", touchAction: "none" }}
        />
      ) : (
        <canvas
          ref={canvasRef}
          className="mbm-media"
          tabIndex={interactive ? 0 : undefined}
          {...pointerHandlers}
          {...keyboardHandlers}
          style={{
            cursor: interactive ? "crosshair" : "default",
            touchAction: "none",
            display: state === "playing" ? "block" : "none",
          }}
        />
      );

      return (
        <div className="mbm-stage" data-frame={frame}>
          {media}
          {state === "playing" ? null : (
            <div className="mbm-hint" data-overlay={state === "error" ? "1" : "0"}>
              <span>{hintText(state, detail)}</span>
            </div>
          )}
        </div>
      );
    }

    /**
     * 设备类型的中文名。
     *
     * 设备下拉与状态栏都用它，**不要在别处再写一份映射** —— 两处不一致
     * 会让"下拉里说是模拟器、状态栏说是 real"这种矛盾出现。
     *
     * mobilecli 的 `--type` 帮助原文是 `real or simulator/emulator`，
     * 所以三种值都要认；Android 的模拟器上报 emulator，iOS 的报 simulator。
     * 认不出的值**原样返回**而不是猜一个 —— 猜错会误导用户。
     *
     * @param {string|undefined} type 设备对象里的 type 字段
     * @returns {string} 「真机」/「模拟器」/ 未知时原样
     */
    function deviceKindLabel(type) {
      if (type === "real") return "真机";
      if (type === "simulator" || type === "emulator") return "模拟器";
      return typeof type === "string" && type !== "" ? type : "未知";
    }

    /**
     * 下拉选项里跟在设备名后面的类型后缀。
     *
     * ⚠️ 必须加：实测同时插着「一加 12」（real）与「iPhone 17 Pro」
     * （simulator）时，只显示名字的话**完全分不出哪个是模拟器** ——
     * 用户反馈过这一点。
     *
     * 用 `·` 而不是括号套括号：离线时还要再跟一个「（离线）」，
     * `一加 12（真机）（离线）` 读起来很挤。
     *
     * @param {{type?: string}} device
     * @returns {string} 形如 ` · 真机`；没有 type 时返回空串
     */
    function deviceKindSuffix(device) {
      const label = deviceKindLabel(device?.type);
      return label === "" ? "" : ` · ${label}`;
    }

    /**
     * 一个下拉选项的文字。
     *
     * @param {{name: string, type?: string, state?: string}} device
     * @param {boolean} withKind 是否带类型后缀。**分组渲染时传 false** ——
     *   分组标题已经写了「真机 / 模拟器」，选项里再写一遍是冗余。
     */
    function deviceOptionText(device, withKind = true) {
      const kind = withKind ? deviceKindSuffix(device) : "";
      const offline = device.state === "online" ? "" : "（离线）";
      return `${device.name}${kind}${offline}`;
    }

    /**
     * 渲染设备下拉的选项，按类型分组。
     *
     * 用 `<optgroup>` 把「真机」与「模拟器」分成两个视觉区块 ——
     * 名字后缀在设备少时够用，设备一多就不好扫，分组让用户一眼能定位。
     *
     * ⚠️ 两条规则：
     *   · 只有**一种**类型时不加分组标题（那时它只是多余的层级），
     *     改由选项自带类型后缀，保证照样能分辨。
     *   · 分组时选项**不再重复**类型后缀，否则「真机 / 一加 12 · 真机」很啰嗦。
     *
     * @param {Array<{id: string, name: string, type?: string, state?: string}>} devices
     * @returns {Array} React 子节点
     */
    function renderDeviceOptions(devices) {
      const groups = new Map();
      for (const device of devices) {
        const kind = deviceKindLabel(device.type);
        if (!groups.has(kind)) groups.set(kind, []);
        groups.get(kind).push(device);
      }

      const entries = [...groups.entries()];
      // 单一类型：不分组，但每个选项自带类型后缀（否则无从分辨）
      if (entries.length <= 1) {
        return devices.map((d) => (
          <option key={d.id} value={d.id}>
            {deviceOptionText(d, true)}
          </option>
        ));
      }

      return entries.map(([kind, list]) => (
        <optgroup key={kind} label={kind}>
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {deviceOptionText(d, false)}
            </option>
          ))}
        </optgroup>
      ));
    }

    /** 把内部状态翻成给人看的一句话。 */
    function hintText(state, detail) {
      switch (state) {
        case "idle":
          return "选一台设备开始";
        case "connecting":
          return "正在连接设备…（首次可能要等 on-device agent 启动）";
        case "playing":
          return "";
        /**
         * 保留 `ended` 文案但**当前已无代码会产生它** —— 加了自动重连之后，
         * 流结束只会转成 `connecting`（"正在重连"）而不是终态。
         * 留着它是因为 `state` 是字符串状态机，日后若增加"用户主动断开"
         * 之类真的终态，这里就有现成的落点；删掉反而容易漏改。
         */
        case "ended":
          return "流已结束";
        case "error":
          return typeof detail === "string" ? detail : "画面出错了";
        default:
          return "";
      }
    }

    // ── 手机图标 ────────────────────────────────────────────────────────
    //
    // 官方只导出了 GuideArtworkBrowser / GuideArtworkFiles 两幅「开始」页 artwork，
    // 没有手机图标；primitives 的 378 个 Icon* 里也没有 phone/mobile/tablet。
    // 所以自绘一幅，两处复用：「开始」页胶囊 + tab 标签。

    /**
     * 「开始」页 artwork 的固定蓝（GuideArtworkBrowser 用的就是这个值）。
     *
     * 注意官方有**两套**配色约定，别混：
     *   - guide artwork（本插件的入口胶囊）：固定色，浏览器 #539CFA / 文件 #FFBC4D
     *   - tab 标签图标（IconGlobeOutlineRegular 等）：currentColor，跟随标签前景色
     * 所以这个组件收一个 `color`，两处各传各的。
     */
    const ARTWORK_BLUE = "#539CFA";

    /**
     * 手机图标。
     *
     * ⚠️ 官方对**同一个图形**在两种场合用两套留白，别照搬其中一个：
     *
     *   guide 胶囊 artwork（GuideArtworkBrowser, viewBox 36）
     *     圆形占 7.85→28.15，即 viewBox 的 **56.4%** —— 留白多，呼吸感
     *   tab 标签图标（IconGlobeOutlineRegular, viewBox 16）
     *     圆形占 1.91→14.09，即 viewBox 的 **76.1%** —— 填得满，小尺寸才看得清
     *
     * 曾经两处都用 56.4%，于是标签里同样 size=16 只画出 9px，
     * 而旁边的文件夹/地球是 12.2px —— 肉眼一眼能看出一圈。
     * 所以这个组件按场合切换填充比例（`dense`），描边也按官方各自的比例走。
     *
     * @param {{size?: number, className?: string, color?: string, dense?: boolean}} props
     *   size  由调用方给（guide 传 26/22，标签行传 16）
     *   color 默认固定蓝；标签行传 "currentColor"
     *   dense 标签行专用：填满 viewBox（与官方 tab 图标同比例）
     */
    function MobileArtwork({ size = 36, className, color = ARTWORK_BLUE, dense = false }) {
      const BOX = 36;
      // 图形高度占 viewBox 的比例：对齐官方对应场合的那个图形
      const fill = dense ? 0.761 : 0.564;
      // 描边同样按官方比例：guide 是 2/36，tab 图标是 1/16
      const strokeWidth = BOX * (dense ? 1 / 16 : 2 / 36);

      const bodyHeight = BOX * fill;
      const bodyWidth = bodyHeight * 0.47; // 真机宽高比（一加 12 ≈ 0.46）
      const center = BOX / 2;
      const top = center - bodyHeight / 2;

      return (
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${BOX} ${BOX}`}
          fill="none"
          className={className}
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* 机身 */}
          <rect
            x={center - bodyWidth / 2}
            y={top}
            width={bodyWidth}
            height={bodyHeight}
            rx={bodyWidth * 0.22}
            stroke={color}
            strokeWidth={strokeWidth}
          />
          {/* 底部指示条：小尺寸下比一个圆点更容易认出是手机 */}
          <path
            d={`M${center - bodyWidth * 0.22} ${top + bodyHeight * 0.86}`
              + `H${center + bodyWidth * 0.22}`}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        </svg>
      );
    }

    // ── 工具栏图标 ──────────────────────────────────────────────────────
    //
    // 官方 primitives 有 94 个 Regular 图标，但**没有** home / rotate / back /
    // frame 这几个（搜过全部导出）。工具栏又必须用图形而不是 "⌂" "▢" 这类
    // 字符——字符的字重与基线跟旁边的图标对不齐，正是"看起来不像按钮"的原因之一。
    //
    // 所以自绘，规格照抄官方 Regular 图标：viewBox 0 0 16 16、
    // stroke currentColor、strokeWidth 1、fill none、aria-hidden。
    // 用下面这个工厂生成，避免五份重复的 SVG 属性。

    /**
     * 造一个官方规格的线性图标。
     *
     * @param {string} name 组件名（便于 React 区分与调试）
     * @param {Array<[string, object]>} children [标签名, 属性] 列表
     * @returns {Function} 收 `{size, className}` 的组件
     */
    function makeIcon(name, children) {
      // 子元素是动态标签（"path" / "rect"…）。JSX 里大写开头的名字会被当作
      // **变量**而不是标签名，所以这里把标签解构成 `Tag` 就能直接用 JSX 写，
      // 不必退回 h(tag, ...)。
      const Icon = ({ size = 16, className }) => (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill="none"
          className={className}
          aria-hidden="true"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
          xmlns="http://www.w3.org/2000/svg"
        >
          {children.map(([Tag, attributes], index) => (
            <Tag key={index} {...attributes} />
          ))}
        </svg>
      );
      Icon.displayName = name;
      return Icon;
    }

    /** 主屏幕：一栋房子。 */
    const IconHome = makeIcon("IconHome", [
      ["path", { d: "M2.6 6.9 8 2.6l5.4 4.3" }],
      ["path", { d: "M3.7 6.5v6.1c0 .5.4.9.9.9h6.8c.5 0 .9-.4.9-.9V6.5" }],
    ]);

    /** Android 返回：向左的箭头。 */
    const IconBack = makeIcon("IconBack", [
      ["path", { d: "M13 8H3.5" }],
      ["path", { d: "M6.9 4.6 3.5 8l3.4 3.4" }],
    ]);

    /** 旋转：带箭头的圆弧。 */
    const IconRotate = makeIcon("IconRotate", [
      ["path", { d: "M13.1 8A5.1 5.1 0 1 1 11.5 4.2" }],
      ["path", { d: "M13.3 2.7v3.2h-3.2" }],
    ]);

    /** 重新连接：刷新箭头。 */
    const IconRefresh = makeIcon("IconRefresh", [
      ["path", { d: "M2.9 8a5.1 5.1 0 1 1 1.6 3.8" }],
      ["path", { d: "M2.7 13.3v-3.2h3.2" }],
    ]);

    /** 外观：带边框的手机轮廓。 */
    const IconFrame = makeIcon("IconFrame", [
      ["rect", { x: 4.5, y: 1.9, width: 7, height: 12.2, rx: 1.5 }],
      ["path", { d: "M6.9 12.2h2.2" }],
    ]);

    /** 外观·无框：虚线框表示无边框模式。 */
    const IconFrameNone = makeIcon("IconFrameNone", [
      ["rect", { x: 4.5, y: 1.9, width: 7, height: 12.2, rx: 1.5, strokeDasharray: "2 1.5" }],
      ["path", { d: "M6.9 12.2h2.2" }],
    ]);

    // ── 主面板 ──────────────────────────────────────────────────────────

    function MobilePanel() {
      const [devices, setDevices] = useState([]);
      /**
       * devices 的 ref 副本。
       *
       * `grant` 是 useCallback([])，闭包里拿不到最新的 devices；而"这台是不是
       * 离线模拟器"必须在**发请求前**就知道（用来决定要不要显示"正在启动"）。
       * 用 ref 同步保留一份，而不是把 devices 塞进依赖 —— 那会让 grant 每次
       * devices 变化都重建，进而触发重新取流。
       */
      const devicesRef = useRef([]);
      /** 同步写 ref，保证 grant 闭包读到的是最新列表。 */
      const rememberDevices = useCallback((list) => {
        devicesRef.current = Array.isArray(list) ? list : [];
        setDevices(devicesRef.current);
      }, []);
      const [activeId, setActiveId] = useState(null);
      const [token, setToken] = useState(null);
      const [format, setFormat] = useState("unknown");
      const [frame, setFrame] = useState("bezel");
      const [busy, setBusy] = useState(false);
      /**
       * 是否正在启动一台离线设备。
       *
       * 与 `busy` 分开是因为**文案要不一样**：普通切换只是"忙一下"，而启动
       * 模拟器冷启动可达数分钟，用户需要知道"它在开机，不是卡死了"。
       */
      const [booting, setBooting] = useState(false);
      const [error, setError] = useState(null);
      const [streaming, setStreaming] = useState(false);
      /**
       * adb 健康状态（Host 在看不到设备时才会去体检）。
       *
       * 为什么客户端要拿这个：adb 缺失时 mobilecli **静默返回空列表**，
       * 面板只会显示"未发现设备"，用户完全不知道要装 adb。把诊断显示出来，
       * 是这条信息唯一能到达用户的路径。
       */
      const [adb, setAdb] = useState(null);

      /** 申请 token 并选定设备。token 决定设备，所以换设备必须重新申请。 */
      const grant = useCallback(
        async (deviceId) => {
          setBusy(true);
          setError(null);
          try {
            /**
             * ⚠️ 选中**离线模拟器**时这条请求会很慢（Host 会先把它启动起来，
             * 冷启动可达数分钟）。所以先给一句提示，否则界面看起来像卡死了。
             * 只有候选设备是离线模拟器/模拟机时才提示 —— 普通切换不该闪这句。
             */
            const target = devicesRef.current.find((d) => d.id === deviceId);
            const willBoot = target !== undefined
              && target.state !== "online"
              && (target.type === "simulator" || target.type === "emulator");
            if (willBoot) setBooting(true);

            const result = await api("grant", deviceId === undefined ? {} : { deviceId });
            rememberDevices(result.devices ?? []);
            setActiveId(result.device?.id ?? null);
            setToken(result.streamToken ?? null);
            // 启动失败不影响选中，但要如实告诉用户（否则画面一直是黑的却无解释）
            if (typeof result.bootError === "string" && result.bootError !== "") {
              setError(`设备已选中，但启动失败：${result.bootError}`);
            }
          } catch (err) {
            setError(err?.message ?? String(err));
            setToken(null);
          } finally {
            setBooting(false);
            setBusy(false);
          }
        },
        [rememberDevices],
      );

      // 挂载时自动选一台（Host 会优先沿用上次选的）
      useEffect(() => {
        void grant();
      }, [grant]);

      // 面板打开期间轮询状态：拿流格式（决定用哪个渲染器）与设备在线情况。
      //
      // ⚠️ 不再以 `activeId !== null` 为前提。原来的写法在"一台设备都没有"时
      // **完全不轮询** —— 而那恰恰是最需要诊断的时候（adb 缺失、手机没授权）。
      // 现在无论有没有设备都轮询：没设备时 Host 会回带 adb 体检结果。
      // 5 秒一次：够及时发现设备掉线，又不会把设备端问烦。
      useEffect(() => {
        let stopped = false;

        const poll = async () => {
          try {
            const status = await api("status");
            if (stopped) return;
            setStreaming(status.streaming === true);
            setFormat(status.format ?? "unknown");
            if (Array.isArray(status.devices)) rememberDevices(status.devices);
            setAdb(status.adb ?? null);
          } catch {
            // 状态查询失败不该打断画面，静默重试
          }
        };

        void poll();
        const timer = setInterval(() => void poll(), 5000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
        // 不依赖 activeId：没设备时也要轮询，否则拿不到 adb 诊断
      }, []);

      /** 设备级动作。 */
      const act = useCallback(
        async (action) => {
          setError(null);
          try {
            await api("device-action", { action });
          } catch (err) {
            setError(err?.message ?? String(err));
          }
        },
        [],
      );

      const active = useMemo(
        () => devices.find((d) => d.id === activeId) ?? null,
        [devices, activeId],
      );

      /**
       * 工具栏按钮：官方 Button（sm = 28px 高）+ Tooltip。
       *
       * 用官方组件而不是自绘的 26px 小方块，理由不只是尺寸：
       * Button 自带 `variant="ghost"` 的 hover 填充、focus ring、
       * `:disabled` 的 0.4 透明度和正确的 button 语义；Tooltip 复用产品的
       * 气泡样式。之前那套 1px 边框 + 无填充的写法，看起来不像按钮。
       *
       * @param {{label: string, icon: Function, onClick: Function, disabled?: boolean}} spec
       */
      // ⚠️ `icon` 改名成 `Icon` 是必须的：JSX 里小写开头的名字会被当成
      // 内置标签（`<icon>` 会去找 HTML 的 icon 元素），只有大写开头才当变量。
      const BarButton = ({ label, icon: Icon, onClick, disabled = false }) => (
        <Tooltip label={label} side="bottom" delayMs={400}>
          <Button
            size="sm"
            variant="ghost"
            className="mbm-tool"
            disabled={disabled}
            aria-label={label}
            onClick={onClick}
            icon={<Icon size={16} />}
          />
        </Tooltip>
      );

      /**
       * 设备选择器。
       *
       * 用原生 `<select>` 是刻意的：它自带键盘、无障碍和移动端选择器，
       * 自己用 Menu 重造反而丢这些。但原生下拉箭头会**占掉右侧内边距**，
       * 导致左 8px、右 0 的不对称 —— 这正是之前看起来歪的原因。
       *
       * 所以：`appearance: none` 关掉原生箭头，自己画一个官方 chevron，
       * 并用等宽的 padding 让左右对称。
       */
      const select = (
        <div className="mbm-selectWrap">
          <select
            className="mbm-select"
            value={activeId ?? ""}
            disabled={busy}
            onChange={(e) => void grant(e.target.value)}
            aria-label="选择设备"
          >
            {devices.length === 0 ? (
              <option value="">未发现设备</option>
            ) : (
              renderDeviceOptions(devices)
            )}
          </select>
          <IconChevronDownOutlineRegular className="mbm-selectCaret" size={16} />
        </div>
      );

      const toolbar = (
        <div className="mbm-bar">
          {select}
          {/* 右侧动作区：与下拉框留出间隔，并把它们推到右端，避免和下拉框挤在一起 */}
          <div className="mbm-actions">
            <BarButton
              key="home"
              label="主屏幕"
              icon={IconHome}
              disabled={activeId === null}
              onClick={() => void act("home")}
            />
            {active?.platform === "android" ? (
              <BarButton
                key="back"
                label="返回"
                icon={IconBack}
                disabled={activeId === null}
                onClick={() => void act("back")}
              />
            ) : null}
            <BarButton
              key="rotate"
              label="旋转"
              icon={IconRotate}
              disabled={activeId === null}
              onClick={() => void act("rotate")}
            />
            <BarButton
              key="reconnect"
              label="重新连接"
              icon={IconRefresh}
              disabled={busy}
              onClick={() => void grant(activeId ?? undefined)}
            />
            <BarButton
              key="frame"
              label="切换外观"
              icon={frame === "frameless" ? IconFrameNone : IconFrame}
              onClick={() => setFrame(frame === "bezel" ? "device" : frame === "device" ? "frameless" : "bezel")}
            />
          </div>
        </div>
      );

      const status = (
        <div className="mbm-status">
          {/*
            启动中要盖过"未串流"：此时设备确实还没画面，但原因不是故障，
            而是正在开机 —— 冷启动可达数分钟，不说明的话用户会以为卡死了。
          */}
          {booting ? (
            <span>
              <i className="mbm-dot" data-on="2" />
              正在启动设备…（首次可能要几分钟）
            </span>
          ) : (
            <span>
              <i className="mbm-dot" data-on={streaming ? "1" : "0"} />
              {streaming ? "实时" : "未串流"}
            </span>
          )}
          {active === null ? null : (
            <span>{`${active.platform} · ${deviceKindLabel(active.type)} · ${active.version ?? "?"}`}</span>
          )}
          {format === "unknown" ? null : (
            <span>{format === "h264" ? "H.264" : format === "mjpeg" ? "MJPEG" : format}</span>
          )}
          {error === null ? null : <span className="mbm-err">{error}</span>}
        </div>
      );

      /**
       * adb 诊断横幅。
       *
       * ⚠️ 只在"一台设备都看不到、且 adb 有问题"时出现。
       *
       * 这条信息必须显式呈现：adb 缺失时 mobilecli 静默返回空列表，面板
       * 只会显示"未发现设备"，用户看到的是"手机明明插着" —— 于是去折腾
       * 数据线和开发者选项，而真正要做的是装 adb。Host 已经查清了原因，
       * 这里负责把它送到眼前。
       */
      const adbWarning =
        devices.length === 0 && adb !== null && adb.reason !== "ok" && adb.message ? (
          <div className="mbm-adb">
            <strong>无法发现 Android 设备</strong>
            <span>{adb.message}</span>
            {adb.hint ? <span className="mbm-adbHint">{adb.hint}</span> : null}
            {adb.path ? <code className="mbm-adbPath">{`adb: ${adb.path}`}</code> : null}
          </div>
        ) : null;

      return (
        <div className="mbm-root">
          {/*
            样式以 React 子节点的形式注入 <style>（而不是命令式 appendChild）：
            DSH 会给插件注入的 <style> 打上 data-plugin 并在卸载时一并清理，
            走这条路才能被它纳管。
          */}
          <style>{CSS}</style>
          {toolbar}
          {adbWarning}
          <StreamView
            key={`${activeId ?? "none"}:${token ?? "none"}`}
            deviceId={activeId}
            streamToken={token}
            format={format}
            frame={frame}
            onError={(message) => setError(message)}
          />
          {status}
        </div>
      );
    }

    // ── tab 标题 ────────────────────────────────────────────────────────

    /**
     * tab 标签上的标题：图标 + 文字。
     *
     * 官方 files/browser 都在 `sidebar.right.pane.tab.title` 里这么干 ——
     * 不注册这个 keyed slot 的话，标签只显示纯文字。
     *
     * 图标跟随标签前景色（currentColor），与 IconGlobeOutlineRegular 那类官方
     * 标签图标一致；**不要**用入口胶囊那个固定蓝，否则暗色主题下会突兀。
     *
     * @param {{useTabInfo?: Function}} props 框架注入的 tab 信息 hook
     */
    function MobileTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      // 标签行要填满 viewBox：官方 tab 图标占 76%，guide artwork 只占 56%。
      // 少了 dense，图标就会比旁边的文件夹/地球小一圈。
      return (
        <>
          <MobileArtwork
            size={16}
            className="mbm-title-icon"
            color="currentColor"
            dense
          />
          {tab.title}
        </>
      );
    }

    // ── 注册 ────────────────────────────────────────────────────────────

    return {
      /**
       * 需要 slots（注册 tab 正文）、sidebarRightTabs（注册 tab 类型）、
       * sidebarRight（打开 tab）、shortcuts（注册快捷键）。
       *
       * `shortcuts` / `sidebarRight` 都是可选注入：缺失时下面的 ctx.inject
       * 回调不执行，插件其余部分照常工作（面板仍能从「开始」页胶囊打开）。
       */
      inject: ["slots", "sidebarRightTabs"],

      /**
       * @param {object} ctx 客户端插件上下文
       */
      apply(ctx) {
        // 快捷键：和官方 files/browser 一样，一个命令 + 一个 guide 胶囊徽标。
        //
        // 只有「打开面板」这一个动作走快捷键；面板里的操作（主屏/返回/旋转）
        // 不做全局键——它们只在面板有焦点时才有意义，占用全局键会误伤。
        ctx.inject(["shortcuts", "sidebarRight"], (scope) => {
          scope.effect(
            () =>
              scope.shortcuts.register({
                id: SHORTCUT_ID,
                label: () => "移动设备",
                aliases: ["mobile", "device", "android", "ios", "手机", "移动设备"],
                defaults: {
                  // 桌面端：⌘⇧M / Ctrl+Shift+M。
                  // 不能只用 ⌘M —— macOS 的 windowMenu 把 ⌘M 绑给了「最小化」，
                  // 原生菜单会先吃掉这个键，插件收不到。
                  "desktop:macos": { code: "KeyM", modifiers: ["primary", "shift"] },
                  "desktop:windows": { code: "KeyM", modifiers: ["primary", "shift"] },
                  "desktop:linux": { code: "KeyM", modifiers: ["primary", "shift"] },
                  // 浏览器：⌘⌥M / Ctrl+Alt+M，与同族的 browser.new(⌘⌥T)、
                  // workspace.files(⌘⌥P) 保持一致（web 上大量 primary+shift
                  // 组合被浏览器自己占用）。
                  "web:macos": { code: "KeyM", modifiers: ["primary", "alt"] },
                  "web:windows": { code: "KeyM", modifiers: ["primary", "alt"] },
                },
                regions: ["page", "editable", "terminal"],
                modals: [],
                resolve: ({ target: element }) => {
                  const target = scope.sidebarRight.commandTarget(element);
                  if (target === undefined) {
                    return { status: "blocked", reason: "先打开一个会话，再打开移动设备" };
                  }
                  return {
                    status: "handled",
                    run: () => {
                      // openTabFromTarget：落在当前活动面板，且若那里正开着
                      // 「开始」页就替换掉它——这正是官方 files/browser 的用法。
                      scope.sidebarRight.openTabFromTarget("mobile", target);
                    },
                  };
                },
              }),
            "dsh-sidebar-mobile:shortcut",
          );
        });

        // 类型：静态声明，告诉 tab 系统"有这么一种 tab"
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: "mobile",
              // 页类型不给 patterns：它不认领资源地址，只能被显式打开
              multiple: false,
              title: () => "移动设备",
              /**
               * 切换会话时保留已挂载的 tab body。
               *
               * ⚠️ 少了这一行，切走会话再切回来，画面流会**从头重连**
               * （用户实测报告"切换会话后侧边栏画面流变成重新加载了"）。
               *
               * 机制在 sidebar-right 里：每个会话一个 SidebarSessionView，切换时
               *
               *     prune(view) {
               *       if (view.sessionId === this.selected || view.hasRetainedTabs || …) return;
               *       this.views.delete(view.sessionId);
               *       view.retire();      // ← 释放 session 引用 → React 子树卸载
               *     }
               *
               * 而 `hasRetainedTabs` 就是 `this.tabs.size > 0`，那个 map **只有**
               * `retainTab` 会填，`retainTab` 又只在类型声明了 keepMounted 时才被调用：
               *
               *     const retained = seat === "sidebar.right.pane.tab" && definition?.keepMounted === true;
               *
               * 后果对本插件尤其明显：面板持有一条长命的设备流（H.264 解码器状态
               * 或 MJPEG 的 <img>），卸载会丢掉解码器、并要重新等一个关键帧
               * —— 真机实测 IDR 间隔可达 3–4 秒。而 Host 侧的流会话其实还活着
               * （由 idleStop 管理），只是没人看了。
               *
               * 官方 README 的原文：
               *   "A type's keepMounted: true retains visited bodies across tab and
               *    Session changes, collapse, and docking."
               *
               * 注意这是**每个类型自行声明**的，不是默认值：官方只有
               * ui-sidebar-browser 设了（且带 desktop 条件），terminal 和 files
               * 都没设 —— 所以终端切会话也会重连。官方另有说明"未访问过的 body
               * 不会被预先挂载"，也就是说这不会带来额外启动开销。
               */
              keepMounted: true,
              // guide：右侧边栏「开始」页上的入口胶囊。**这不是装饰，是唯一的入口**——
              // 页类型不认领资源地址，`openTab` 又只认 kind，所以没有这条胶囊，
              // 这个 tab 就永远打不开（官方 files/terminal/browser 三个 tab 都靠它）。
              //
              // ⚠️ 已知副作用：DSH 的「开始」页有条硬规则
              //     const MAX_DESCRIBED_ENTRIES = 4;
              //     const described = entries.length <= MAX_DESCRIBED_ENTRIES;
              // 胶囊超过 4 个就关掉**所有**胶囊的副标题（不是只关第 5 个）。
              // 本插件是第 5 个（官方 3 个 + dsh-context 1 个），所以装上之后
              // 「工作区文件/上下文/新建终端/浏览器」的副标题会一起消失。
              //
              // 这是上游的取舍，插件侧无法只为自己豁免；已确认接受（副标题换一个
              // 可见入口）。**不要把它当成本插件的 bug 去修**——真要恢复副标题，
              // 只能挪走入口（例如改挂 conversation.session.header.utilities），
              // 而不是给 description 加什么开关。
              guide: [
                {
                  id: "mobile",
                  order: 40, // files 10 / terminal 20 / browser 30，dsh-context 20
                  // commandId 让胶囊右侧显示快捷键徽标。它必须与下面
                  // shortcuts.register 的 id 逐字一致，否则查不到、徽标不显示
                  // （官方 files/browser 也是这么连的）。
                  commandId: SHORTCUT_ID,
                  title: () => "移动设备",
                  description: () => "实时画面 + 直接操作 iOS / Android 设备",
                  icon: MobileArtwork,
                },
              ],
            }),
          "dsh-sidebar-mobile:tab-type",
        );

        // 正文：keyed slot，键是类型 id
        ctx.effect(
          () =>
            ctx.slots.register(
              {
                name: "sidebar.right.pane.tab",
                key: TAB_ID,
              },
              MobilePanel,
            ),
          "dsh-sidebar-mobile:tab-body",
        );

        // 标签：keyed slot，键同样是类型 id。注册它，标签上才有图标
        // （官方 files/browser/terminal 都注册了这个 seat）。
        ctx.effect(
          () =>
            ctx.slots.register(
              {
                name: "sidebar.right.pane.tab.title",
                key: TAB_ID,
              },
              MobileTitle,
            ),
          "dsh-sidebar-mobile:tab-title",
        );
      },
    };
  },
});
