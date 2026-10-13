/**
 * ⚠️ 本文件是**构建产物**，不要直接编辑 —— 改动会在下次构建时被覆盖。
 *
 * 源码：src/client/index.jsx（布局与逻辑）
 *       src/client/styles.css（样式）
 * 构建：npm run build
 *
 * 产物为什么要提交进仓库：本插件以 git 依赖安装
 * （profile 里写的是 github:j62268781-alt/dsh-sidebar-mobile），
 * 提交产物能让安装方**完全不需要工具链**。代价是产物可能漂移，
 * 所以 npm run verify 会校验它是否与源码同步（见 build:check）。
 */
window.__ModuleLoader__.load({
  id: "@j62268781-alt/dsh-sidebar-mobile",
  factory(require) {
    const React = require("react");
    globalThis.__dshReact = React;
    const h = React.createElement;
    const Fragment = React.Fragment;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;
    const { Button, Tooltip, IconChevronDownOutlineRegular } = require("@deepseek-ai/dsh-client-ui-primitives");
    const TAB_ID = "@j62268781-alt/dsh-sidebar-mobile";
    const PREFIX = "/_dsh/dsh-sidebar-mobile";
    const MIN_SWIPE_DURATION_MS = 80;
    const MAX_SWIPE_DURATION_MS = 600;
    const SHORTCUT_ID = "sidebar.mobile";
    async function api(route, body) {
      let response;
      try {
        response = await fetch(`${PREFIX}/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {})
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
    const CSS = ".mbm-root { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; padding: 8px;\n  font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329); }\n/* 一行工具栏：左边设备下拉，右边动作按钮 */\n.mbm-bar { display: flex; align-items: center; gap: 8px; }\n/* 设备下拉：高 28 与官方 sm 按钮齐平。\n   原生箭头会吃掉右侧内边距（左 8 / 右 0 的视觉歪斜就是它造成的），\n   所以 appearance:none 关掉它，再自绘一个官方 chevron。 */\n.mbm-selectWrap { position: relative; display: flex; flex: 1; min-width: 0; max-width: 220px; }\n.mbm-select { font: inherit; height: 28px; width: 100%; min-width: 0;\n  appearance: none; -webkit-appearance: none;\n  padding: 0 26px 0 8px; border-radius: var(--dsw-radius-sm, 6px);\n  border: 1px solid var(--dsw-alias-border-l2, #d0d5dd);\n  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; cursor: pointer; }\n.mbm-select:disabled { opacity: .5; cursor: default; }\n/* 自绘箭头：文字左内边距 8px；右侧 6px + 16px 箭头 ≈ 视觉上也是 8px */\n.mbm-selectCaret { position: absolute; top: 50%; right: 6px; transform: translateY(-50%);\n  width: 16px; height: 16px; pointer-events: none;\n  color: var(--dsw-alias-label-tertiary, #98a2b3); }\n/* 动作按钮：靠右，自身小间距 */\n.mbm-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }\n/* 官方 Button 是 28px 高的方形容器；这里只补「图标按钮」的宽度与内边距。\n   不加边框、不加背景——hover 填充由 Button 的 ghost 变体提供。 */\n.mbm-tool { width: 28px; padding: 0; color: var(--dsw-alias-label-secondary, #667085); }\n.mbm-tool:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2329); }\n.mbm-stage { position: relative; flex: 1; min-height: 120px; display: flex; align-items: center;\n  justify-content: center; overflow: hidden; border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-2, #f4f5f7);\n  border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); }\n.mbm-stage[data-frame=\"device\"] { padding: 10px; background: #101114; }\n.mbm-stage[data-frame=\"frameless\"] { border: none; background: transparent; }\n/* 媒体元素：CSS 尺寸由 JS 按帧的真实宽高比算好写进 style（见 fitCanvasToFrame）。\n   这里只加 flex:none —— 否则 flex 容器会把它拉伸/压缩，宽高比又丢了。\n   max-* 作为兜底：万一 JS 还没跑到，也不至于溢出容器。 */\n.mbm-media { display: block; flex: none; max-width: 100%; max-height: 100%; }\n/* 画面获得键盘焦点时给一圈提示 —— 否则用户不知道打字会送到哪里。\n   只在键盘聚焦时显示（:focus-visible），鼠标点选不闪边框。 */\n.mbm-media:focus { outline: none; }\n.mbm-media:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);\n  outline-offset: 2px; }\n.mbm-stage[data-frame=\"device\"] .mbm-media { border-radius: 18px; }\n.mbm-stage[data-frame=\"bezel\"] .mbm-media { border-radius: 10px; }\n.mbm-hint { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px;\n  align-items: center; justify-content: center; text-align: center; padding: 16px;\n  color: var(--dsw-alias-label-tertiary, #667085); line-height: 1.6; }\n.mbm-hint[data-overlay=\"1\"] { background: rgba(16,17,20,.72); color: #fff; }\n.mbm-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 5px; }\n.mbm-dot[data-on=\"1\"] { background: #22c55e; }\n.mbm-dot[data-on=\"0\"] { background: #9aa4b2; }\n/* data-on=\"2\" = 正在启动设备。琥珀色 + 呼吸动画：既区别于「正常 / 未串流」，\n   又表明「在动，等着就好」，而不是故障。 */\n.mbm-dot[data-on=\"2\"] { background: #f59e0b; animation: mbm-pulse 1.2s ease-in-out infinite; }\n@keyframes mbm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }\n.mbm-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;\n  color: var(--dsw-alias-label-tertiary, #667085); font-size: 11px; }\n.mbm-err { color: var(--dsw-alias-state-error-primary, #d92d20); line-height: 1.6; }\n/* adb / 工具链诊断横幅。\n   用警示色的浅底而不是纯红字：它是\"需要你做一个动作\"的说明，不是崩溃。\n   三行各司其职 —— 结论 / 原因 / 怎么做 —— 所以各自成段，行高放松。 */\n.mbm-adb { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;\n  border-radius: var(--dsw-radius-sm, 6px); line-height: 1.6;\n  border: 1px solid var(--dsw-alias-state-warning-border, #f7d08a);\n  background: var(--dsw-alias-state-warning-bg, #fff8e6);\n  color: var(--dsw-alias-label-primary, #1f2329); }\n.mbm-adbHint { color: var(--dsw-alias-label-secondary, #667085); }\n.mbm-adbPath { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;\n  font-size: 10px; color: var(--dsw-alias-label-tertiary, #98a2b3);\n  word-break: break-all; }\n/* tab 标签里的图标。dockkit 的 .tabTitle 已经给了 gap:5px，所以这里**只**需要\n   flex:none（防止标题长时被压扁）。不要再加 margin-right：那会变成 9px，\n   而官方的「文件」标签用的是 5px（它的 titleIcon 就没写 margin）。 */\n.mbm-title-icon { flex: none; }\n";
    function codecStringFromSps(nal) {
      let offset = 0;
      if (nal[2] === 1) offset = 3;
      else if (nal[2] === 0 && nal[3] === 1) offset = 4;
      const profile = offset + 1;
      if (profile + 3 > nal.length) return "avc1.42E01F";
      const hex = (value) => value.toString(16).padStart(2, "0");
      return `avc1.${hex(nal[profile])}${hex(nal[profile + 1])}${hex(nal[profile + 2])}`;
    }
    function splitAnnexB(carry, chunk) {
      const buffer = new Uint8Array(carry.length + chunk.length);
      buffer.set(carry, 0);
      buffer.set(chunk, carry.length);
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
      if (starts.length === 0) {
        const keep = Math.min(buffer.length, 3);
        return { units: [], rest: buffer.subarray(buffer.length - keep) };
      }
      const units = [];
      for (let i = 0; i < starts.length - 1; i++) {
        units.push(buffer.subarray(starts[i], starts[i + 1]));
      }
      const rest = buffer.subarray(starts[starts.length - 1]);
      return { units, rest };
    }
    function nalType(unit) {
      let offset = 0;
      if (unit[2] === 1) offset = 3;
      else if (unit[2] === 0 && unit[3] === 1) offset = 4;
      return offset < unit.length ? unit[offset] & 31 : 0;
    }
    const TARGET_RENDER_FPS = 30;
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
    function fitCanvasToFrame(canvas, frameWidth, frameHeight) {
      if (!(frameWidth > 0) || !(frameHeight > 0)) return null;
      const parent = canvas.parentElement;
      if (parent === null) return null;
      const style = getComputedStyle(parent);
      const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availWidth = parent.clientWidth - (Number.isFinite(paddingX) ? paddingX : 0);
      const availHeight = parent.clientHeight - (Number.isFinite(paddingY) ? paddingY : 0);
      if (availWidth <= 0 || availHeight <= 0) return null;
      const scale = Math.min(availWidth / frameWidth, availHeight / frameHeight);
      const cssWidth = Math.max(1, Math.round(frameWidth * scale));
      const cssHeight = Math.max(1, Math.round(frameHeight * scale));
      if (canvas.style.width !== `${cssWidth}px`) canvas.style.width = `${cssWidth}px`;
      if (canvas.style.height !== `${cssHeight}px`) canvas.style.height = `${cssHeight}px`;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bufferWidth = Math.max(1, Math.round(cssWidth * dpr));
      const bufferHeight = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
      }
      return { width: cssWidth, height: cssHeight };
    }
    function useH264Canvas(streamUrl, canvasRef, onState, frameSizeRef) {
      useEffect(() => {
        if (streamUrl === null) return void 0;
        let cancelled = false;
        let decoder = null;
        let reader = null;
        let stallTimer = null;
        let bytesReceived = 0;
        let carry = new Uint8Array(0);
        let timestamp = 0;
        let configured = false;
        let activeCodec = null;
        let sps = null;
        let pps = null;
        let needsKeyframe = true;
        let frames = 0;
        let lastDrawAt = 0;
        const report = (state, detail) => {
          if (!cancelled) onState(state, detail);
        };
        const buildDecoder = (codec) => {
          if (decoder !== null) {
            try {
              decoder.close();
            } catch {
            }
          }
          decoder = new VideoDecoder({
            output: (frame) => {
              const canvas = canvasRef.current;
              if (frameSizeRef !== void 0) {
                frameSizeRef.current = {
                  width: frame.displayWidth,
                  height: frame.displayHeight
                };
              }
              const now = performance.now();
              if (canvas !== null && now - lastDrawAt >= 1e3 / TARGET_RENDER_FPS) {
                lastDrawAt = now;
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
              report("error", `解码器错误：${error?.message ?? String(error)}`);
            }
          });
          decoder.configure({
            codec,
            avc: { format: "annexb" },
            optimizeForLatency: true
          });
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
          const STALL_TIMEOUT_MS = 3e3;
          let lastByteAt = performance.now();
          stallTimer = setInterval(() => {
            if (cancelled) return;
            if (performance.now() - lastByteAt > STALL_TIMEOUT_MS) {
              report("connecting", "画面卡住了，正在重连…");
              void reader?.cancel().catch(() => {
              });
            }
          }, 500);
          try {
            for (; ; ) {
              const { done, value } = await reader.read();
              if (cancelled || done) break;
              lastByteAt = performance.now();
              bytesReceived += value?.byteLength ?? 0;
              const { units, rest } = splitAnnexB(carry, value);
              carry = rest;
              for (const unit of units) {
                const type = nalType(unit);
                if (type === 7) {
                  const codec = codecStringFromSps(
                    new Uint8Array(unit.buffer, unit.byteOffset, unit.length)
                  );
                  if (!configured || decoder.state === "closed") {
                    try {
                      buildDecoder(codec);
                    } catch (error) {
                      report("error", `解码器初始化失败：${error?.message ?? error}`);
                      return;
                    }
                  }
                  activeCodec = codec;
                  sps = unit;
                  continue;
                }
                if (type === 8) {
                  pps = unit;
                  continue;
                }
                if (!configured || activeCodec === null) continue;
                if (type !== 1 && type !== 5) continue;
                if (decoder.state === "closed") {
                  try {
                    buildDecoder(activeCodec);
                  } catch {
                    continue;
                  }
                }
                const isKey = type === 5;
                if (needsKeyframe && !isKey) continue;
                if (isKey) needsKeyframe = false;
                timestamp += 33333;
                const payload = isKey && sps !== null && pps !== null ? concatBytes(sps, pps, unit) : unit;
                try {
                  decoder.decode(
                    new EncodedVideoChunk({
                      type: isKey ? "key" : "delta",
                      timestamp,
                      data: payload
                    })
                  );
                } catch (error) {
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
            }
            reader = null;
          }
        };
        const RECONNECT_BASE_MS = 1e3;
        const RECONNECT_MAX_MS = 8e3;
        let reconnectDelay = RECONNECT_BASE_MS;
        const runWithReconnect = async () => {
          for (; ; ) {
            const before = bytesReceived;
            await run();
            if (cancelled) return;
            if (bytesReceived > before) reconnectDelay = RECONNECT_BASE_MS;
            report("connecting", "画面中断，正在重连…");
            await new Promise((resolve) => setTimeout(resolve, reconnectDelay));
            if (cancelled) return;
            reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          }
        };
        if (typeof VideoDecoder === "undefined") {
          report(
            "error",
            "此浏览器不支持 WebCodecs，无法解码 H.264 画面。 用较新的 Chrome/Edge，或从 HTTPS 或 localhost 打开。"
          );
          return void 0;
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
          }
          try {
            if (decoder !== null && decoder.state !== "closed") decoder.close();
          } catch {
          }
        };
      }, [streamUrl]);
    }
    function StreamView({ deviceId, streamToken, format, frame, onError }) {
      const [state, setState] = useState("idle");
      const [detail, setDetail] = useState(null);
      const canvasRef = useRef(null);
      const mediaRef = useRef(null);
      const gestureRef = useRef(null);
      const frameSizeRef = useRef({ width: 0, height: 0 });
      const streamUrl = streamToken === null ? null : `${PREFIX}/stream/${encodeURIComponent(streamToken)}`;
      const isMjpeg = format === "mjpeg";
      useH264Canvas(
        isMjpeg || streamUrl === null ? null : streamUrl,
        canvasRef,
        (next, info) => {
          setState(next);
          if (info !== void 0) setDetail(info);
          if (next === "error" && typeof info === "string") onError?.(info);
        },
        frameSizeRef
      );
      useEffect(() => {
        if (!isMjpeg) return void 0;
        setState(streamUrl === null ? "idle" : "connecting");
        return void 0;
      }, [isMjpeg, streamUrl]);
      const sendPointer = useCallback(
        async (event, phase) => {
          const element = isMjpeg ? mediaRef.current : canvasRef.current;
          if (element === null || deviceId === null) return;
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const naturalWidth = isMjpeg ? element.naturalWidth : frameSizeRef.current.width;
          const naturalHeight = isMjpeg ? element.naturalHeight : frameSizeRef.current.height;
          if (!naturalWidth || !naturalHeight) return;
          const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
          const shownWidth = naturalWidth * scale;
          const shownHeight = naturalHeight * scale;
          const offsetX = (rect.width - shownWidth) / 2;
          const offsetY = (rect.height - shownHeight) / 2;
          const localX = event.clientX - rect.left - offsetX;
          const localY = event.clientY - rect.top - offsetY;
          if (localX < 0 || localY < 0 || localX > shownWidth || localY > shownHeight) return;
          const x = Math.round(localX / shownWidth * naturalWidth);
          const y = Math.round(localY / shownHeight * naturalHeight);
          if (phase === "down") {
            gestureRef.current = { x, y, at: event.timeStamp };
            return;
          }
          if (phase === "up") {
            const start = gestureRef.current;
            gestureRef.current = null;
            if (start === null) return;
            const dx = Math.abs(x - start.x);
            const dy = Math.abs(y - start.y);
            const threshold = Math.max(12, Math.round(naturalWidth * 0.02));
            try {
              if (dx > threshold || dy > threshold) {
                const heldMs = Math.max(0, event.timeStamp - start.at);
                const duration = Math.min(
                  MAX_SWIPE_DURATION_MS,
                  Math.max(MIN_SWIPE_DURATION_MS, Math.round(heldMs))
                );
                await api("control", {
                  action: "swipe",
                  x1: start.x,
                  y1: start.y,
                  x2: x,
                  y2: y,
                  duration
                });
              } else {
                await api("control", { action: "tap", x, y });
              }
            } catch (error) {
              onError?.(error?.message ?? String(error));
            }
          }
        },
        [deviceId, isMjpeg, onError]
      );
      const interactive = deviceId !== null && (state === "playing" || isMjpeg);
      const KEY_BATCH_MS = 40;
      function translateKey(event) {
        const { key } = event;
        if (typeof key !== "string" || key === "") return null;
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
          PageDown: "pagedown"
        };
        const name = named[key];
        if (name !== void 0) return { kind: "key", value: name };
        const chars = Array.from(key);
        if (chars.length !== 1) return null;
        const codePoint = key.codePointAt(0);
        if (codePoint >= 32 && codePoint < 127) {
          return { kind: "key", value: withModifiers(key.toLowerCase(), event) };
        }
        return { kind: "text", value: key };
      }
      function withModifiers(base, event) {
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
      const flushKeys = useCallback(async () => {
        keyTimerRef.current = null;
        const pending = keyQueueRef.current;
        keyQueueRef.current = [];
        if (pending.length === 0) return;
        const asciiKeys = pending.filter((item) => item.kind === "key").map((item) => item.value);
        const texts = pending.filter((item) => item.kind === "text").map((item) => item.value);
        try {
          if (asciiKeys.length > 0) await api("control", { action: "keys", keys: asciiKeys });
          for (const text of texts) await api("control", { action: "text", text });
        } catch (error) {
          onError?.(error?.message ?? String(error));
        }
      }, [onError]);
      const enqueueKey = useCallback(
        (item) => {
          const queue = keyQueueRef.current;
          queue.push(item);
          if (keyTimerRef.current === null) {
            keyTimerRef.current = setTimeout(() => void flushKeys(), KEY_BATCH_MS);
          }
        },
        [flushKeys]
      );
      useEffect(
        () => () => {
          if (keyTimerRef.current !== null) {
            clearTimeout(keyTimerRef.current);
            keyTimerRef.current = null;
          }
          keyQueueRef.current = [];
        },
        []
      );
      const keyboardHandlers = interactive ? {
        onKeyDown: (event) => {
          if (event.metaKey || event.ctrlKey) {
            const probe = translateKey(event);
            const EDIT_KEYS = new Set(["a", "c", "v", "x", "z", "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z", "cmd+a", "cmd+c", "cmd+v", "cmd+x", "cmd+z"]);
            if (probe === null || !EDIT_KEYS.has(probe.value)) return;
          }
          const item = translateKey(event);
          if (item === null) return;
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
          const text = event.clipboardData?.getData("text");
          if (typeof text !== "string" || text === "") return;
          event.preventDefault();
          enqueueKey({ kind: "text", value: text });
        }
      } : {};
      const pointerHandlers = {
        onPointerDown: (e) => void sendPointer(e, "down"),
        onPointerUp: (e) => void sendPointer(e, "up"),
        onPointerCancel: () => {
          gestureRef.current = null;
        }
      };
      const media = isMjpeg ? h(
        "img",
        {
          ref: mediaRef,
          className: "mbm-media",
          src: streamUrl ?? void 0,
          alt: "设备画面",
          draggable: false,
          tabIndex: interactive ? 0 : void 0,
          onLoad: () => setState("playing"),
          onError: () => {
            const message = "MJPEG 流加载失败，检查设备是否仍在线。";
            setState("error");
            onError?.(message);
          },
          ...pointerHandlers,
          ...keyboardHandlers,
          style: { cursor: interactive ? "crosshair" : "default", touchAction: "none" }
        }
      ) : h(
        "canvas",
        {
          ref: canvasRef,
          className: "mbm-media",
          tabIndex: interactive ? 0 : void 0,
          ...pointerHandlers,
          ...keyboardHandlers,
          style: {
            cursor: interactive ? "crosshair" : "default",
            touchAction: "none",
            display: state === "playing" ? "block" : "none"
          }
        }
      );
      return h("div", { className: "mbm-stage", "data-frame": frame }, media, state === "playing" ? null : h("div", { className: "mbm-hint", "data-overlay": state === "error" ? "1" : "0" }, h("span", null, hintText(state, detail))));
    }
    function deviceKindLabel(type) {
      if (type === "real") return "真机";
      if (type === "simulator" || type === "emulator") return "模拟器";
      return typeof type === "string" && type !== "" ? type : "未知";
    }
    function deviceKindSuffix(device) {
      const label = deviceKindLabel(device?.type);
      return label === "" ? "" : ` · ${label}`;
    }
    function deviceOptionText(device, withKind = true) {
      const kind = withKind ? deviceKindSuffix(device) : "";
      const offline = device.state === "online" ? "" : "（离线）";
      return `${device.name}${kind}${offline}`;
    }
    function renderDeviceOptions(devices) {
      const groups = new Map();
      for (const device of devices) {
        const kind = deviceKindLabel(device.type);
        if (!groups.has(kind)) groups.set(kind, []);
        groups.get(kind).push(device);
      }
      const entries = [...groups.entries()];
      if (entries.length <= 1) {
        return devices.map((d) => h("option", { key: d.id, value: d.id }, deviceOptionText(d, true)));
      }
      return entries.map(([kind, list]) => h("optgroup", { key: kind, label: kind }, list.map((d) => h("option", { key: d.id, value: d.id }, deviceOptionText(d, false)))));
    }
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
    const ARTWORK_BLUE = "#539CFA";
    function MobileArtwork({ size = 36, className, color = ARTWORK_BLUE, dense = false }) {
      const BOX = 36;
      const fill = dense ? 0.761 : 0.564;
      const strokeWidth = BOX * (dense ? 1 / 16 : 2 / 36);
      const bodyHeight = BOX * fill;
      const bodyWidth = bodyHeight * 0.47;
      const center = BOX / 2;
      const top = center - bodyHeight / 2;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: `0 0 ${BOX} ${BOX}`,
          fill: "none",
          className,
          "aria-hidden": "true",
          xmlns: "http://www.w3.org/2000/svg"
        },
        h(
          "rect",
          {
            x: center - bodyWidth / 2,
            y: top,
            width: bodyWidth,
            height: bodyHeight,
            rx: bodyWidth * 0.22,
            stroke: color,
            strokeWidth
          }
        ),
        h(
          "path",
          {
            d: `M${center - bodyWidth * 0.22} ${top + bodyHeight * 0.86}H${center + bodyWidth * 0.22}`,
            stroke: color,
            strokeWidth,
            strokeLinecap: "round"
          }
        )
      );
    }
    function makeIcon(name, children) {
      const Icon = ({ size = 16, className }) => h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          className,
          "aria-hidden": "true",
          stroke: "currentColor",
          strokeWidth: 1,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          xmlns: "http://www.w3.org/2000/svg"
        },
        children.map(([Tag, attributes], index) => h(Tag, { key: index, ...attributes }))
      );
      Icon.displayName = name;
      return Icon;
    }
    const IconHome = makeIcon("IconHome", [
      ["path", { d: "M2.6 6.9 8 2.6l5.4 4.3" }],
      ["path", { d: "M3.7 6.5v6.1c0 .5.4.9.9.9h6.8c.5 0 .9-.4.9-.9V6.5" }]
    ]);
    const IconBack = makeIcon("IconBack", [
      ["path", { d: "M13 8H3.5" }],
      ["path", { d: "M6.9 4.6 3.5 8l3.4 3.4" }]
    ]);
    const IconRotate = makeIcon("IconRotate", [
      ["path", { d: "M13.1 8A5.1 5.1 0 1 1 11.5 4.2" }],
      ["path", { d: "M13.3 2.7v3.2h-3.2" }]
    ]);
    const IconRefresh = makeIcon("IconRefresh", [
      ["path", { d: "M2.9 8a5.1 5.1 0 1 1 1.6 3.8" }],
      ["path", { d: "M2.7 13.3v-3.2h3.2" }]
    ]);
    const IconFrame = makeIcon("IconFrame", [
      ["rect", { x: 4.5, y: 1.9, width: 7, height: 12.2, rx: 1.5 }],
      ["path", { d: "M6.9 12.2h2.2" }]
    ]);
    const IconFrameNone = makeIcon("IconFrameNone", [
      ["rect", { x: 4.5, y: 1.9, width: 7, height: 12.2, rx: 1.5, strokeDasharray: "2 1.5" }],
      ["path", { d: "M6.9 12.2h2.2" }]
    ]);
    function MobilePanel() {
      const [devices, setDevices] = useState([]);
      const devicesRef = useRef([]);
      const rememberDevices = useCallback((list) => {
        devicesRef.current = Array.isArray(list) ? list : [];
        setDevices(devicesRef.current);
      }, []);
      const [activeId, setActiveId] = useState(null);
      const [token, setToken] = useState(null);
      const [format, setFormat] = useState("unknown");
      const [frame, setFrame] = useState("bezel");
      const [busy, setBusy] = useState(false);
      const [booting, setBooting] = useState(false);
      const [error, setError] = useState(null);
      const [streaming, setStreaming] = useState(false);
      const [adb, setAdb] = useState(null);
      const grant = useCallback(
        async (deviceId) => {
          setBusy(true);
          setError(null);
          try {
            const target = devicesRef.current.find((d) => d.id === deviceId);
            const willBoot = target !== void 0 && target.state !== "online" && (target.type === "simulator" || target.type === "emulator");
            if (willBoot) setBooting(true);
            const result = await api("grant", deviceId === void 0 ? {} : { deviceId });
            rememberDevices(result.devices ?? []);
            setActiveId(result.device?.id ?? null);
            setToken(result.streamToken ?? null);
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
        [rememberDevices]
      );
      useEffect(() => {
        void grant();
      }, [grant]);
      useEffect(() => {
        let stopped = false;
        const poll = async () => {
          try {
            const status2 = await api("status");
            if (stopped) return;
            setStreaming(status2.streaming === true);
            setFormat(status2.format ?? "unknown");
            if (Array.isArray(status2.devices)) rememberDevices(status2.devices);
            setAdb(status2.adb ?? null);
          } catch {
          }
        };
        void poll();
        const timer = setInterval(() => void poll(), 5e3);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, []);
      const act = useCallback(
        async (action) => {
          setError(null);
          try {
            await api("device-action", { action });
          } catch (err) {
            setError(err?.message ?? String(err));
          }
        },
        []
      );
      const active = useMemo(
        () => devices.find((d) => d.id === activeId) ?? null,
        [devices, activeId]
      );
      const BarButton = ({ label, icon: Icon, onClick, disabled = false }) => h(Tooltip, { label, side: "bottom", delayMs: 400 }, h(
        Button,
        {
          size: "sm",
          variant: "ghost",
          className: "mbm-tool",
          disabled,
          "aria-label": label,
          onClick,
          icon: h(Icon, { size: 16 })
        }
      ));
      const select = h("div", { className: "mbm-selectWrap" }, h(
        "select",
        {
          className: "mbm-select",
          value: activeId ?? "",
          disabled: busy,
          onChange: (e) => void grant(e.target.value),
          "aria-label": "选择设备"
        },
        devices.length === 0 ? h("option", { value: "" }, "未发现设备") : renderDeviceOptions(devices)
      ), h(IconChevronDownOutlineRegular, { className: "mbm-selectCaret", size: 16 }));
      const toolbar = h("div", { className: "mbm-bar" }, select, h("div", { className: "mbm-actions" }, h(
        BarButton,
        {
          key: "home",
          label: "主屏幕",
          icon: IconHome,
          disabled: activeId === null,
          onClick: () => void act("home")
        }
      ), active?.platform === "android" ? h(
        BarButton,
        {
          key: "back",
          label: "返回",
          icon: IconBack,
          disabled: activeId === null,
          onClick: () => void act("back")
        }
      ) : null, h(
        BarButton,
        {
          key: "rotate",
          label: "旋转",
          icon: IconRotate,
          disabled: activeId === null,
          onClick: () => void act("rotate")
        }
      ), h(
        BarButton,
        {
          key: "reconnect",
          label: "重新连接",
          icon: IconRefresh,
          disabled: busy,
          onClick: () => void grant(activeId ?? void 0)
        }
      ), h(
        BarButton,
        {
          key: "frame",
          label: "切换外观",
          icon: frame === "frameless" ? IconFrameNone : IconFrame,
          onClick: () => setFrame(frame === "bezel" ? "device" : frame === "device" ? "frameless" : "bezel")
        }
      )));
      const status = h("div", { className: "mbm-status" }, booting ? h("span", null, h("i", { className: "mbm-dot", "data-on": "2" }), "正在启动设备…（首次可能要几分钟）") : h("span", null, h("i", { className: "mbm-dot", "data-on": streaming ? "1" : "0" }), streaming ? "实时" : "未串流"), active === null ? null : h("span", null, `${active.platform} · ${deviceKindLabel(active.type)} · ${active.version ?? "?"}`), format === "unknown" ? null : h("span", null, format === "h264" ? "H.264" : format === "mjpeg" ? "MJPEG" : format), error === null ? null : h("span", { className: "mbm-err" }, error));
      const adbWarning = devices.length === 0 && adb !== null && adb.reason !== "ok" && adb.message ? h("div", { className: "mbm-adb" }, h("strong", null, "无法发现 Android 设备"), h("span", null, adb.message), adb.hint ? h("span", { className: "mbm-adbHint" }, adb.hint) : null, adb.path ? h("code", { className: "mbm-adbPath" }, `adb: ${adb.path}`) : null) : null;
      return h("div", { className: "mbm-root" }, h("style", null, CSS), toolbar, adbWarning, h(
        StreamView,
        {
          key: `${activeId ?? "none"}:${token ?? "none"}`,
          deviceId: activeId,
          streamToken: token,
          format,
          frame,
          onError: (message) => setError(message)
        }
      ), status);
    }
    function MobileTitle({ useTabInfo }) {
      const { tab } = useTabInfo();
      return h(Fragment, null, h(
        MobileArtwork,
        {
          size: 16,
          className: "mbm-title-icon",
          color: "currentColor",
          dense: true
        }
      ), tab.title);
    }
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
        ctx.inject(["shortcuts", "sidebarRight"], (scope) => {
          scope.effect(
            () => scope.shortcuts.register({
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
                "web:windows": { code: "KeyM", modifiers: ["primary", "alt"] }
              },
              regions: ["page", "editable", "terminal"],
              modals: [],
              resolve: ({ target: element }) => {
                const target = scope.sidebarRight.commandTarget(element);
                if (target === void 0) {
                  return { status: "blocked", reason: "先打开一个会话，再打开移动设备" };
                }
                return {
                  status: "handled",
                  run: () => {
                    scope.sidebarRight.openTabFromTarget("mobile", target);
                  }
                };
              }
            }),
            "dsh-sidebar-mobile:shortcut"
          );
        });
        ctx.effect(
          () => ctx.sidebarRightTabs.register({
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
                order: 40,
                // files 10 / terminal 20 / browser 30，dsh-context 20
                // commandId 让胶囊右侧显示快捷键徽标。它必须与下面
                // shortcuts.register 的 id 逐字一致，否则查不到、徽标不显示
                // （官方 files/browser 也是这么连的）。
                commandId: SHORTCUT_ID,
                title: () => "移动设备",
                description: () => "实时画面 + 直接操作 iOS / Android 设备",
                icon: MobileArtwork
              }
            ]
          }),
          "dsh-sidebar-mobile:tab-type"
        );
        ctx.effect(
          () => ctx.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: TAB_ID
            },
            MobilePanel
          ),
          "dsh-sidebar-mobile:tab-body"
        );
        ctx.effect(
          () => ctx.slots.register(
            {
              name: "sidebar.right.pane.tab.title",
              key: TAB_ID
            },
            MobileTitle
          ),
          "dsh-sidebar-mobile:tab-title"
        );
      }
    };
  }
});
