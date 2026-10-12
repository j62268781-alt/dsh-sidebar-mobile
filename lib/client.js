/**
 * dsh-sidebar-mobile — 客户端半边：右侧边栏的「移动设备」tab。
 *
 * ── 为什么不用 JSX / 不用构建步骤 ──────────────────────────────────────
 * DSH 把 client bundle 当**经典脚本**求值（官方产物 0 个顶层 import），
 * 所以不能用 ES import，JSX 也必须走全局工厂。别的插件靠 esbuild 预先转译，
 * 那会引入构建步骤与 devDependencies。本插件承诺零运行时依赖，也不想让
 * 使用者为了改一行样式就得装工具链，所以直接用 `React.createElement`
 * （别名 `h`），单文件、无需构建、改完刷新即生效。
 *
 * ── 两条渲染路径，因为两端给的流格式不同（实测）────────────────────────
 *   Android        → AVC/H.264（104fps）→ 必须用 WebCodecs 解码
 *   iOS 模拟器     → MJPEG（131fps）    → 一个 <img> 就够
 *
 * iOS 上请求 --format avc 会被 mobilecli 静默降级成 MJPEG，所以**不能靠
 * 请求参数决定用什么渲染器**——必须由 Host 从首块字节嗅探出的格式来选。
 * Host 把结论放在响应头的 content-type 里，这里照着分派。
 *
 * 这也是为什么 MJPEG 那条路用 <img> 而不是 fetch+canvas：multipart/
 * x-mixed-replace 是浏览器原生支持的格式，<img> 直接渲染，零解码代码、
 * 自动处理分帧、自动跟随重连。自己解 MJPEG 只会更慢更脆。
 *
 * ── 坐标换算 ────────────────────────────────────────────────────────────
 * 面板显示尺寸与设备物理分辨率不同，点击必须先按比例换算回设备坐标。
 * 用 <img>/<canvas> 的实际渲染尺寸而不是 CSS 声明值——对象适应（object-fit）
 * 会让画面留黑边，用声明值算出来的坐标会系统性偏移。
 *
 * @module dsh-sidebar-mobile/client
 */

window.__ModuleLoader__.load({
  id: "@j62268781-alt/dsh-sidebar-mobile",
  factory(require) {
    const React = require("react");
    // JSX 走这个全局工厂（本文件不用 JSX，但保持一致以防将来引入）
    globalThis.__dshReact = React;
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    /** tab 类型身份，也是 keyed slot 的 key。必须全局唯一。 */
    const TAB_ID = "@j62268781-alt/dsh-sidebar-mobile";
    /** 与 cordis.patch.yml 的 routePrefix 一致。 */
    const PREFIX = "/_dsh/dsh-sidebar-mobile";

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

    const CSS = `
.mbm-root { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; padding: 8px;
  font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329); }
.mbm-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mbm-select { font: inherit; height: 26px; max-width: 190px; padding: 0 6px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit; }
.mbm-btn { font: inherit; cursor: pointer; height: 26px; min-width: 26px; padding: 0 8px;
  display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); background: var(--dsw-alias-bg-layer-1, #fff);
  color: inherit; }
.mbm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4f6ef7); }
.mbm-btn:disabled { opacity: .45; cursor: not-allowed; }
.mbm-btn[data-primary="1"] { background: var(--dsw-alias-brand-primary, #4f6ef7); color: #fff;
  border-color: transparent; }
.mbm-stage { position: relative; flex: 1; min-height: 120px; display: flex; align-items: center;
  justify-content: center; overflow: hidden; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, #f4f5f7);
  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); }
.mbm-stage[data-frame="device"] { padding: 10px; background: #101114; }
.mbm-stage[data-frame="frameless"] { border: none; background: transparent; }
.mbm-media { max-width: 100%; max-height: 100%; display: block; }
.mbm-stage[data-frame="device"] .mbm-media { border-radius: 18px; }
.mbm-stage[data-frame="bezel"] .mbm-media { border-radius: 10px; }
.mbm-hint { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px;
  align-items: center; justify-content: center; text-align: center; padding: 16px;
  color: var(--dsw-alias-label-tertiary, #667085); line-height: 1.6; }
.mbm-hint[data-overlay="1"] { background: rgba(16,17,20,.72); color: #fff; }
.mbm-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 5px; }
.mbm-dot[data-on="1"] { background: #22c55e; }
.mbm-dot[data-on="0"] { background: #9aa4b2; }
.mbm-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--dsw-alias-label-tertiary, #667085); font-size: 11px; }
.mbm-err { color: var(--dsw-alias-state-error-primary, #d92d20); line-height: 1.6; }
`;

    // ── H.264 解码 ──────────────────────────────────────────────────────
    //
    // mobilecli 的 AVC 输出是裸 Annex B 码流（带起始码，无容器）。WebCodecs
    // 吃这种格式需要两件事：告诉它 avc.format='annexb'，以及一个正确的
    // codec 字符串（avc1.PPCCLL）。后者只能从 SPS 里读——写死一个会在
    // 不同设备/分辨率上失败。

    /**
     * 从 SPS 推出 WebCodecs 需要的 codec 字符串。
     *
     * SPS 的 NAL 头后紧跟三个字节：profile_idc、constraint flags、level_idc。
     * 拼成 avc1.PPCCLL 即可。拿不到 SPS 时回落到一个保守值（Baseline 3.1），
     * 它几乎一定能让解码器起来，之后真实 SPS 到达时再重配。
     *
     * @param {Uint8Array} nal 含 NAL 头的完整 SPS
     * @returns {string}
     */
    function codecStringFromSps(nal) {
      if (nal.length < 4) return "avc1.42E01F";
      const hex = (value) => value.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[1])}${hex(nal[2])}${hex(nal[3])}`;
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
     * 用 WebCodecs 把 H.264 流画到 canvas 上。
     *
     * 关键取舍：
     * - optimizeForLatency: true —— 实时画面要的是低延迟，不是压缩率。
     *   不开这个，解码器会缓冲若干帧再吐，体感延迟明显。
     * - 解码器报错后**不重建**在同一个实例上硬撑，而是整体复位重来：
     *   一旦码流错位（丢包、中途接入），继续喂只会持续报错。
     * - 首帧到达前不显示 canvas，避免一块黑框闪一下。
     */
    function useH264Canvas(streamUrl, canvasRef, onState) {
      useEffect(() => {
        if (streamUrl === null) return undefined;

        let cancelled = false;
        let decoder = null;
        let reader = null;
        let carry = new Uint8Array(0);
        let timestamp = 0;
        let configured = false;
        let pendingSps = null;
        let frames = 0;

        const report = (state, detail) => {
          if (!cancelled) onState(state, detail);
        };

        /** 建（或重建）解码器。 */
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
              if (canvas !== null) {
                // 尺寸跟随真实帧，而不是猜一个
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                  canvas.width = frame.displayWidth;
                  canvas.height = frame.displayHeight;
                }
                const ctx2d = canvas.getContext("2d");
                if (ctx2d !== null) ctx2d.drawImage(frame, 0, 0);
              }
              frames += 1;
              if (frames === 1) report("playing");
              else if (frames % 30 === 0) report("playing", { frames });
              frame.close();
            },
            error: (error) => {
              // 不在这里重建：交给下面的循环统一复位
              report("error", error?.message ?? String(error));
            },
          });
          decoder.configure({
            codec,
            avc: { format: "annexb" },
            optimizeForLatency: true,
          });
          configured = true;
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
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (cancelled || done) break;

              const { units, rest } = splitAnnexB(carry, value);
              carry = rest;

              for (const unit of units) {
                const type = nalType(unit);

                // SPS：解出 codec 字符串。首帧必须先见到它才能配置解码器。
                if (type === 7) {
                  pendingSps = unit;
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
                  continue;
                }

                // SPS/PPS 之前来的片数据没法解，丢掉
                if (!configured) continue;
                if (type !== 1 && type !== 5 && type !== 8) continue;

                // 关键帧才能起解；非关键帧在前，解码器会报错
                const isKey = type === 5;
                timestamp += 33_333; // ~30fps 的时间基，仅用于排序

                try {
                  decoder.decode(
                    new EncodedVideoChunk({
                      type: isKey ? "key" : "delta",
                      timestamp,
                      data: unit,
                    }),
                  );
                } catch (error) {
                  // 单个 chunk 失败不致命；解码器状态机会在关键帧到达时恢复
                  report("error", `解码失败：${error?.message ?? error}`);
                }
              }
            }
          } catch (error) {
            if (!cancelled) report("error", `读取流失败：${error?.message ?? error}`);
          } finally {
            try {
              await reader?.cancel();
            } catch {
              // 已关闭
            }
          }
          if (!cancelled) report("ended");
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

        void run();

        return () => {
          cancelled = true;
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
      const [size, setSize] = useState({ width: 0, height: 0 });

      const streamUrl = streamToken === null ? null : `${PREFIX}/stream/${encodeURIComponent(streamToken)}`;

      // MJPEG 走 <img>；H.264 走 canvas + WebCodecs
      const isMjpeg = format === "mjpeg";
      useH264Canvas(isMjpeg || streamUrl === null ? null : streamUrl, canvasRef, (next, info) => {
        setState(next);
        if (info !== undefined) setDetail(info);
        if (next === "error" && typeof info === "string") onError?.(info);
      });

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
       */
      const sendPointer = useCallback(
        async (event, phase) => {
          const element = isMjpeg ? mediaRef.current : canvasRef.current;
          if (element === null || deviceId === null) return;

          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          // 画面的固有尺寸：<img> 用 naturalWidth，canvas 用 width
          const naturalWidth = isMjpeg ? element.naturalWidth : element.width;
          const naturalHeight = isMjpeg ? element.naturalHeight : element.height;
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
            setSize({ width: x, height: y });
            return;
          }
          if (phase === "up") {
            const dx = Math.abs(x - size.width);
            const dy = Math.abs(y - size.height);
            // 位移够大算滑动，否则算点击。阈值按设备坐标给（约 2% 屏幕宽），
            // 太小会把手指抖动误判成滑动。
            const threshold = Math.max(12, Math.round(naturalWidth * 0.02));
            try {
              if (dx > threshold || dy > threshold) {
                await api("control", { action: "swipe", x1: size.width, y1: size.height, x2: x, y2: y });
              } else {
                await api("control", { action: "tap", x, y });
              }
            } catch (error) {
              onError?.(error?.message ?? String(error));
            }
          }
        },
        [deviceId, isMjpeg, size.width, size.height, onError],
      );

      const interactive = deviceId !== null && (state === "playing" || isMjpeg);

      const media = isMjpeg
        ? h("img", {
            ref: mediaRef,
            className: "mbm-media",
            src: streamUrl ?? undefined,
            alt: "设备画面",
            draggable: false,
            onLoad: () => setState("playing"),
            onError: () => {
              const message = "MJPEG 流加载失败，检查设备是否仍在线。";
              setState("error");
              onError?.(message);
            },
            onPointerDown: (e) => void sendPointer(e, "down"),
            onPointerUp: (e) => void sendPointer(e, "up"),
            style: { cursor: interactive ? "crosshair" : "default", touchAction: "none" },
          })
        : h("canvas", {
            ref: canvasRef,
            className: "mbm-media",
            onPointerDown: (e) => void sendPointer(e, "down"),
            onPointerUp: (e) => void sendPointer(e, "up"),
            style: {
              cursor: interactive ? "crosshair" : "default",
              touchAction: "none",
              display: state === "playing" ? "block" : "none",
            },
          });

      return h(
        "div",
        { className: "mbm-stage", "data-frame": frame },
        media,
        state === "playing"
          ? null
          : h(
              "div",
              { className: "mbm-hint", "data-overlay": state === "error" ? "1" : "0" },
              h("span", null, hintText(state, detail)),
            ),
      );
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
        case "ended":
          return "流已结束";
        case "error":
          return typeof detail === "string" ? detail : "画面出错了";
        default:
          return "";
      }
    }

    // ── 主面板 ──────────────────────────────────────────────────────────

    function MobilePanel() {
      const [devices, setDevices] = useState([]);
      const [activeId, setActiveId] = useState(null);
      const [token, setToken] = useState(null);
      const [format, setFormat] = useState("unknown");
      const [frame, setFrame] = useState("bezel");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [streaming, setStreaming] = useState(false);

      /** 申请 token 并选定设备。token 决定设备，所以换设备必须重新申请。 */
      const grant = useCallback(
        async (deviceId) => {
          setBusy(true);
          setError(null);
          try {
            const result = await api("grant", deviceId === undefined ? {} : { deviceId });
            setDevices(result.devices ?? []);
            setActiveId(result.device?.id ?? null);
            setToken(result.streamToken ?? null);
          } catch (err) {
            setError(err?.message ?? String(err));
            setToken(null);
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      // 挂载时自动选一台（Host 会优先沿用上次选的）
      useEffect(() => {
        void grant();
      }, [grant]);

      // 面板打开期间轮询状态：拿流格式（决定用哪个渲染器）与设备在线情况。
      // 5 秒一次：够及时发现设备掉线，又不会把设备端问烦。
      useEffect(() => {
        if (activeId === null) return undefined;
        let stopped = false;

        const poll = async () => {
          try {
            const status = await api("status");
            if (stopped) return;
            setStreaming(status.streaming === true);
            setFormat(status.format ?? "unknown");
            if (Array.isArray(status.devices)) setDevices(status.devices);
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
      }, [activeId]);

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

      const toolbar = h(
        "div",
        { className: "mbm-bar" },
        h(
          "select",
          {
            className: "mbm-select",
            value: activeId ?? "",
            disabled: busy,
            onChange: (e) => void grant(e.target.value),
            title: "选择设备",
          },
          devices.length === 0
            ? h("option", { value: "" }, "未发现设备")
            : devices.map((d) =>
                h(
                  "option",
                  { key: d.id, value: d.id },
                  `${d.name}${d.state === "online" ? "" : "（离线）"}`,
                ),
              ),
        ),
        h(
          "button",
          {
            className: "mbm-btn",
            disabled: activeId === null,
            onClick: () => void act("home"),
            title: "主屏幕",
          },
          "⌂",
        ),
        active?.platform === "android"
          ? h(
              "button",
              {
                className: "mbm-btn",
                disabled: activeId === null,
                onClick: () => void act("back"),
                title: "返回",
              },
              "◁",
            )
          : null,
        h(
          "button",
          {
            className: "mbm-btn",
            disabled: activeId === null,
            onClick: () => void act("rotate"),
            title: "旋转",
          },
          "⟳",
        ),
        h(
          "button",
          {
            className: "mbm-btn",
            disabled: busy,
            onClick: () => void grant(activeId ?? undefined),
            title: "重新申请令牌并重连（画面卡住时用）",
          },
          "⟲",
        ),
        h(
          "button",
          {
            className: "mbm-btn",
            onClick: () => setFrame(frame === "bezel" ? "device" : frame === "device" ? "frameless" : "bezel"),
            title: "切换外观（边框 / 真机 / 无框）",
          },
          frame === "bezel" ? "▢" : frame === "device" ? "▣" : "▤",
        ),
      );

      const status = h(
        "div",
        { className: "mbm-status" },
        h("span", null, h("i", { className: "mbm-dot", "data-on": streaming ? "1" : "0" }), streaming ? "实时" : "未串流"),
        active === null ? null : h("span", null, `${active.platform} · ${active.type} · ${active.version ?? "?"}`),
        format === "unknown" ? null : h("span", null, format === "h264" ? "H.264" : format === "mjpeg" ? "MJPEG" : format),
        error === null ? null : h("span", { className: "mbm-err" }, error),
      );

      return h(
        "div",
        { className: "mbm-root" },
        h("style", { key: "css" }, CSS),
        toolbar,
        h(StreamView, {
          key: `${activeId ?? "none"}:${token ?? "none"}`,
          deviceId: activeId,
          streamToken: token,
          format,
          frame,
          onError: (message) => setError(message),
        }),
        status,
      );
    }

    // ── 注册 ────────────────────────────────────────────────────────────

    return {
      /** 需要 slots（注册 tab 正文）与 sidebarRightTabs（注册 tab 类型）。 */
      inject: ["slots", "sidebarRightTabs"],

      /**
       * @param {object} ctx 客户端插件上下文
       */
      apply(ctx) {
        // 类型：静态声明，告诉 tab 系统"有这么一种 tab"
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: "mobile",
              // 页类型不给 patterns：它不认领资源地址，只能被显式打开
              multiple: false,
              title: () => "移动设备",
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
      },
    };
  },
});
