/**
 * 面向模型的工具集。
 *
 * ── 设计原则：先给便宜的观察者，再给贵的 ────────────────────────────────
 * mobilecli 提供了从廉价到昂贵的多种"看屏幕"方式，价格差很大：
 *
 *   dump ui（UI 树）    ~100–300ms   结构化：resource-id / text / bounds
 *   screenshot          ~200–400ms   一张图，给人看或给多模态模型看
 *   find_text（OCR）    ~1s          只在树里没有文字时才值得用
 *
 * 所以工具描述里明确写出"先用哪个、什么时候才升级到下一个"，而不是把
 * 五个观察工具并列丢给模型让它自己猜。这是 dsh-android 的 skill 里最
 * 有价值的部分，这里直接沿用它的取舍。
 *
 * ── 为什么失败要 throw 而不是返回空 ────────────────────────────────────
 * "没有设备"和"设备列表拿不到"必须可区分。前者是事实，后者是故障。
 * 把故障伪装成空列表会让模型得出"这台机器没有设备"的错误结论，
 * 然后在错误的路上继续走。凡是枚举失败一律抛，让模型看到真实原因。
 *
 * @module dsh-sidebar-mobile/lib/tools
 */

import { defineTool } from "./tool-support.js";

/**
 * 统一的 JSON 呈现。
 *
 * 不用宿主内部的 renderJson：那是个未导出的实现细节，跟着 DSH 版本漂移。
 * 这里给一个最小实现——把结果序列化进一个 text 块，模型读到的就是结构化 JSON。
 *
 * ⚠️ **签名必须是 `(args, value)` 两个参数，第一个要忽略。**
 *
 * 这不是风格问题，是本插件一个长期 bug 的根因。DSH 的 `ToolOutputDefinition`
 * 在类型和调用点两处都写死了两个参数：
 *
 *     render(args: unknown, value: JsonValue): ContentBlock[]
 *     rawRender(args, value)     // harness 里的实际调用
 *
 * 而这里原先写的是 `renderJson(value)` —— 于是 harness 传进来的 **`args`
 * 被当成了结果**。后果按工具有没有参数分成两种：
 *
 *   · 无参数的（mobile_devices / mobile_open_panel）：args 是 `{}`，
 *     所有调用一律显示 `{}`。
 *   · 有参数的：显示的是**你刚刚传进去的入参**，看起来像个正常结果，
 *     其实完全不是 —— 比显示空更糟，因为它不可疑。
 *
 * 这也正是"所有 mobile_* 工具返回空结果"那个长期未解之谜的答案。
 * 测试「render 必须按 (args, value) 两参签名」钉住它。
 *
 * @param {unknown} _args 工具入参，**必须忽略**
 * @param {any} value 工具的返回值，这才是要呈现的东西
 * @returns {Array<{type: "text", text: string}>}
 */
export function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** 工具名常量，供插件入口与文档引用，避免拼错。 */
/**
 * 注册的工具名。键名 → 模型看到的工具名。
 *
 * ⚠️ 这份表是**公开 API**（index.js 会 re-export，外部脚本可能按名引用），
 * 所以删工具时不要静默移走键 —— 见下面 REMOVED_TOOL_NAMES 的说明。
 */
export const TOOL_NAMES = {
  devices: "mobile_devices",
  boot: "mobile_boot",
  screenshot: "mobile_screenshot",
  uiTree: "mobile_ui_tree",
  tapElement: "mobile_tap_element",
  listApps: "mobile_list_apps",
  findText: "mobile_find_text",
  tapText: "mobile_tap_text",
  waitFor: "mobile_wait_for",
  logs: "mobile_logs",
  openPanel: "mobile_open_panel",
};

/**
 * 已移除的工具名。
 *
 * 保留这张表的原因：调用方拿到 `mobile_tap is not a tool` 时，能立刻分辨
 * "这个插件删了它" 和 "名字打错了"。两种移除原因不同，分别记在下面。
 */
export const REMOVED_TOOL_NAMES = {
  /**
   * 薄包装（5 个）：实现只是 `runJson(...)` 加一句 `return`，没有任何加工，
   * 而 agent 本来就有 shell —— 直接跑等价的 `mobilecli` 命令即可。
   * 留着要付 **349 tokens/轮** 的 schema 成本。命令与注意事项见
   * `skills/mobilecli/SKILL.md` 的「Driving the device from the shell」。
   */
  tap: "mobile_tap",
  swipe: "mobile_swipe",
  text: "mobile_type_text",
  button: "mobile_press_button",
  launchApp: "mobile_launch_app",

  /**
   * `mobile_flutter_tree`：**与 `mobile_ui_tree` 完全重复**，且描述不实。
   *
   * 两者的 execute 调的是同一个函数（`dumpUiElements` → `mobilecli dump ui`），
   * 唯一差别是它多一层"结果为空时给友好报错"。而描述却写着"绕过无障碍投影，
   * **直连 Dart VM Service**" —— 它从未连过任何 VM Service。
   *
   * 实测对一台真实的 debug Flutter 应用（`com.dycjr.jg.inner`）：
   * `dump ui` 得到 69 个节点、**全部是 `android.*`**（其中 32 个还是 systemui
   * 状态栏）；应用窗口下全是匿名 `View`/`ImageView`，只有 rect，没有 text、
   * 没有 identifier。也就是说它给不出描述承诺的任何东西。
   *
   * 一个**描述骗人的工具比没有这个工具更糟**：agent 会以为读到了 Flutter 树
   * 并据此下结论。所以删掉。
   *
   * 真要读 Flutter widget 树，正确路径是 Dart VM Service（协议细节见
   * `docs/FLUTTER-TREE-RESEARCH.md`），或在 tcl_jiguang 工作区直接用
   * `dart-mcp-server` 的 `get_widget_tree`（URI 由 `launch_app` 自己持有）。
   * 不该由本插件再实现一份。
   */
  flutterTree: "mobile_flutter_tree",
};

/**
 * 设备解析：把可选的 deviceId 落到一个确定的设备上。
 *
 * 规则与 mobilecli 一致：给了就用给的；没给且只有一台在线设备就用它；
 * 多台在线又没指定就报错，而不是替用户猜——猜错会让工具在错误的设备上
 * 执行操作，这类错误比"请指定设备"难排查得多。
 *
 * @param {import("./mobilecli.js").Mobilecli} client
 * @param {string|undefined} deviceId
 * @param {string} toolName 用于错误信息
 * @returns {Promise<{id: string, name: string, platform: string}>}
 */
export async function resolveDevice(client, deviceId, toolName) {
  const devices = await client.listDevices();

  if (typeof deviceId === "string" && deviceId !== "") {
    const found = devices.find((d) => d.id === deviceId || d.name === deviceId);
    if (found === undefined) {
      throw new Error(
        `${toolName}: 找不到设备 "${deviceId}"。可用设备：` +
          (devices.length === 0 ? "（无）" : devices.map((d) => `${d.name}(${d.id})`).join("、")),
      );
    }
    if (found.state !== "online") {
      throw new Error(
        `${toolName}: 设备 "${found.name}" 当前状态为 ${found.state}，不是 online。` +
          (found.state === "offline" ? " 用 mobile_boot 启动它。" : ""),
      );
    }
    return found;
  }

  const online = devices.filter((d) => d.state === "online");
  if (online.length === 0) {
    throw new Error(
      `${toolName}: 没有在线设备。启动一个模拟器/模拟机，或用 USB 连一台开了调试的手机。`,
    );
  }
  if (online.length > 1) {
    throw new Error(
      `${toolName}: 有 ${online.length} 台在线设备，需要显式指定 device。` +
        `可选：${online.map((d) => `${d.name}(${d.id})`).join("、")}`,
    );
  }
  return online[0];
}

/**
 * 构造全部工具。
 *
 * @param {object} options
 * @param {import("./mobilecli.js").Mobilecli} options.client
 * @param {(deviceId: string) => object} options.acquireSession 取设备的流会话（用于报告 streaming 状态）
 * @returns {Record<string, any>} 工具名 → 定义
 */
export function createTools({ client, acquireSession, openPanel = null }) {
  const devicesTool = defineTool({
    name: TOOL_NAMES.devices,
    description:
      "列出所有 iOS 与 Android 设备——真机、模拟器、模拟机一视同仁，每台给出 id、名称、平台、在线状态。"
      + " 这里返回的 id 是其它所有 mobile_* 工具要传的 device。"
      + " 先跑这个，再决定操作哪台。"
      + " 设备离线（offline）通常是模拟器没启动；真机没授权时会在状态里体现在设备端的调试提示上。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          devices: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                name: { type: "string", required: true },
                platform: { type: "string", required: true, enum: ["ios", "android"] },
                type: { type: "string", required: true },
                version: { type: "string" },
                model: { type: "string" },
                state: { type: "string", required: true },
                streaming: { type: "boolean", required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    async execute() {
      const devices = await client.listDevices({ includeOffline: true });
      return {
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          type: d.type,
          version: d.version,
          model: d.model,
          state: d.state,
          streaming: acquireSession(d.id)?.running ?? false,
        })),
      };
    },
  });

  const bootTool = defineTool({
    name: TOOL_NAMES.boot,
    description:
      "启动一台设备并开始它的实时画面，画面随即出现在右侧边栏的「移动设备」面板里。"
      + " 传一台在线设备的 id 立刻开始串流；传一台离线模拟器的 id 会先把它启动起来再串流"
      + "（冷启动可能要几分钟）。"
      + " 模拟器/真机都用这一个工具，没有平台差异。",
    parameters: {
      device: { type: "string", required: true, description: "设备 id（来自 mobile_devices）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          name: { type: "string", required: true },
          state: { type: "string", required: true },
          streaming: { type: "boolean", required: true },
          note: { type: "string" },
        },
      },
      render: renderJson,
      presentationMeta: (args, value) => ({
        kind: "mobile-stream",
        device: value.name,
        deviceId: value.device,
      }),
    },
    timeoutMs: 90_000,
    async execute(args) {
      const devices = await client.listDevices({ includeOffline: true });
      const target = devices.find((d) => d.id === args.device || d.name === args.device);
      if (target === undefined) {
        throw new Error(
          `mobile_boot: 找不到设备 "${args.device}"。先跑 mobile_devices 看有哪些。`,
        );
      }

      // 离线设备：先启动。mobilecli 的 device boot 只对模拟器/模拟机有效，
      // 真机本来就是开的。
      let note;
      if (target.state !== "online") {
        await client.runJson(["device", "boot", "--device", target.id], { timeoutMs: 300_000 });
        note = "设备已启动";
      }

      // 订阅一次即触发串流。会话持有子进程，面板与后续工具共用它。
      const session = acquireSession(target.id);
      session.addConsumer(() => {}).remove(); // 立刻退订：只为把流拉起来

      return {
        device: target.id,
        name: target.name,
        state: "online",
        streaming: session.running,
        ...(note === undefined ? {} : { note }),
      };
    },
  });

  const screenshotTool = defineTool({
    name: TOOL_NAMES.screenshot,
    description:
      "给设备截一张图并返回文件路径与尺寸。"
      + " ⚠️ 这是给『人看』或给多模态模型看的，不是读界面的首选——"
      + " 要读控件、拿坐标、做断言请用 mobile_ui_tree（快得多且是结构化的）。"
      + " 在纯文本模型上不要用它来判断界面状态，那种调用只会浪费一轮。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      scale: { type: "number", description: "缩放比例 0.1–1，默认 1" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          path: { type: "string", required: true },
          bytes: { type: "integer", required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_screenshot");
      const outPath = joinTmp(`mobile-shot-${Date.now()}.png`);
      const cmdArgs = ["screenshot", "--device", device.id, "--output", outPath];
      if (typeof args.scale === "number") {
        cmdArgs.push("--scale", String(args.scale));
      }
      await client.runJson(cmdArgs);
      const { size } = await statFile(outPath);
      return { device: device.id, path: outPath, bytes: size };
    },
  });

  const uiTreeTool = defineTool({
    name: TOOL_NAMES.uiTree,
    description:
      "读设备当前的 UI 树——这是观察界面的首选工具。每个元素给出类型、文本、标识与屏幕坐标。"
      + " iOS 上还能拿到 accessibility identifier，Android 上能拿到 resource-id，"
      + " 这两个标识比文本稳定得多（文本会随语言变化）。"
      + " 拿到元素后优先用 mobile_tap_element 按标识点，而不是用坐标。"
      + " 如果树是空的或只有零星几个节点，先看是不是 filter 太窄，再考虑 OCR（mobile_find_text）；"
      + " 绝不要因为一次浅读就断言『这个应用没有无障碍信息』。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      filter: { type: "string", description: "只保留文本/标识/类型里包含该子串的节点（不区分大小写）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          count: { type: "integer", required: true },
          elements: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                ref: { type: "string" },
                type: { type: "string" },
                text: { type: "string" },
                label: { type: "string" },
                identifier: { type: "string" },
                rect: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    x: { type: "integer", required: true },
                    y: { type: "integer", required: true },
                    width: { type: "integer", required: true },
                    height: { type: "integer", required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_ui_tree");
      const raw = await dumpUiElements(client, device.id);
      const needle = typeof args.filter === "string" ? args.filter.toLowerCase() : null;

      const elements = [];
      for (const el of raw) {
        if (needle !== null) {
          const hay = `${el.text ?? ""} ${el.label ?? ""} ${el.identifier ?? ""} ${el.type ?? ""}`.toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        elements.push({
          ...(el.ref === undefined ? {} : { ref: el.ref }),
          ...(el.type === undefined ? {} : { type: el.type }),
          ...(el.text === undefined ? {} : { text: el.text }),
          ...(el.label === undefined ? {} : { label: el.label }),
          ...(el.identifier === undefined ? {} : { identifier: el.identifier }),
          ...(el.rect === undefined ? {} : { rect: el.rect }),
        });
      }

      return { device: device.id, count: elements.length, elements };
    },
  });

    const tapElementTool = defineTool({
    name: TOOL_NAMES.tapElement,
    description:
      "按标识或文本点一个元素——比坐标稳得多，布局变化不会让它失效。"
      + " 先用 mobile_ui_tree 看有哪些元素，再把它的 identifier / text / label 传进来。"
      + " 精确匹配优先，其次是不区分大小写的子串匹配。"
      + " 传 expect_text 可以让『点一下』和『确认生效』合成一次调用："
      + " 点完会重新读一次界面，确认那个文本出现了。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      identifier: { type: "string", description: "元素的 identifier / resource-id" },
      text: { type: "string", description: "元素的文本或 label" },
      expect_text: { type: "string", description: "点击后界面上应该出现的文本（用于确认生效）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          matched: { type: "string", required: true },
          rect: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "integer", required: true },
              y: { type: "integer", required: true },
              width: { type: "integer", required: true },
              height: { type: "integer", required: true },
            },
          },
          verified: { type: "boolean" },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_tap_element");
      if (args.identifier === undefined && args.text === undefined) {
        throw new Error("mobile_tap_element: identifier 与 text 至少要给一个。");
      }

      const found = await findElement(client, device.id, {
        identifier: args.identifier,
        text: args.text,
      });
      if (found === null) {
        // 找不到时把可见元素摘出来，省掉模型再读一次树的往返
        const raw = await dumpUiElements(client, device.id);
        const preview = raw
          .filter((el) => el.text || el.label || el.identifier)
          .slice(0, 25)
          .map((el) => `${el.type ?? "?"}${el.text ? ` "${el.text}"` : ""}${el.identifier ? ` #${el.identifier}` : ""}`);
        throw new Error(
          `mobile_tap_element: 界面上找不到匹配 identifier=${args.identifier ?? "-"} text=${args.text ?? "-"} 的元素。`
          + ` 当前可见元素（前 25 个）：${preview.join("；") || "（空树）"}`,
        );
      }

      const { x, y } = centerOf(found.rect);
      await client.runJson(["io", "tap", "--device", device.id, `${x},${y}`]);

      let verified;
      if (typeof args.expect_text === "string" && args.expect_text !== "") {
        verified = await waitForText(client, device.id, args.expect_text, 5000);
      }

      return {
        device: device.id,
        matched: found.text ?? found.label ?? found.identifier ?? "",
        ...(found.rect === undefined ? {} : { rect: found.rect }),
        ...(verified === undefined ? {} : { verified }),
      };
    },
  });

        const listAppsTool = defineTool({
    name: TOOL_NAMES.listApps,
    description:
      "列出设备上已安装的应用，返回包名（Android）或 bundle id（iOS）。"
      + " 第三方应用的包名猜不出来（Android 上 adb 拿不到应用显示名，"
      + " iOS 上 bundle id 也不是显示名），所以要启动某个应用时必须先列一次。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      query: { type: "string", description: "按包名/bundle id 子串过滤（不区分大小写）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          count: { type: "integer", required: true },
          apps: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                version: { type: "string" },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_list_apps");
      const data = await client.runJson(["apps", "list", "--device", device.id]);
      const raw = Array.isArray(data) ? data : (data?.apps ?? []);

      const needle = typeof args.query === "string" ? args.query.toLowerCase() : null;
      const apps = [];
      for (const app of raw) {
        const id = app.packageName ?? app.bundleId ?? app.id ?? "";
        if (id === "") continue;
        if (needle !== null && !id.toLowerCase().includes(needle)) continue;
        apps.push({
          id,
          ...(app.version === undefined ? {} : { version: app.version }),
        });
      }
      return { device: device.id, count: apps.length, apps };
    },
  });

    const findTextTool = defineTool({
    name: TOOL_NAMES.findText,
    description:
      "用 OCR 识别当前屏幕上的文字，返回文本与其屏幕坐标。"
      + " ⚠️ 这是树读不到文字时的**兜底**，不是首选：它比 mobile_ui_tree 慢一个数量级，"
      + " 而且结果不如结构化数据可靠。"
      + " 适合的场景：文字被画进了图片（角标数字、价格图）、WebView / 自绘界面"
      + " 不暴露无障碍信息、或者要独立验证屏幕上到底显示着什么。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      query: { type: "string", description: "只返回包含该子串的文本（不区分大小写）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          count: { type: "integer", required: true },
          items: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string", required: true },
                confidence: { type: "number" },
                rect: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    x: { type: "integer", required: true },
                    y: { type: "integer", required: true },
                    width: { type: "integer", required: true },
                    height: { type: "integer", required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_find_text");
      const cmdArgs = ["find-text", "--device", device.id];
      if (typeof args.query === "string") cmdArgs.push("--query", args.query);
      const data = await client.runJson(cmdArgs);
      const items = Array.isArray(data) ? data : (data?.items ?? []);
      return { device: device.id, count: items.length, items };
    },
  });

  const tapTextTool = defineTool({
    name: TOOL_NAMES.tapText,
    description:
      "用 OCR 找到屏幕上的某段文字并点它的中心。"
      + " 用在树里看不见的文字上（无无障碍信息的应用、画进图片的数字）。"
      + " 同样地，能用 mobile_tap_element 按标识点就不要用这个。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      query: { type: "string", required: true, description: "要点击的文本" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          tapped: { type: "string", required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 60_000,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_tap_text");
      await client.runJson(["tap-text", "--device", device.id, args.query]);
      return { device: device.id, tapped: args.query };
    },
  });

  const waitForTool = defineTool({
    name: TOOL_NAMES.waitFor,
    description:
      "等某段文本出现或消失（OCR 轮询）。"
      + " 比让模型自己『读一次、等一会、再读一次』省往返，也省 token。"
      + " 超时返回 matched:false 而不是报错——等不到是正常结果。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      text: { type: "string", required: true, description: "要等待的文本" },
      mode: { type: "string", enum: ["appear", "disappear"], description: "默认 appear" },
      timeout_ms: { type: "integer", description: "超时毫秒数，默认 8000，上限 60000" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          matched: { type: "boolean", required: true },
          text: { type: "string", required: true },
        },
      },
      render: renderJson,
    },
    timeoutMs: 70_000,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_wait_for");
      const cmdArgs = [
        "wait-for", "--device", device.id, args.text,
        "--mode", args.mode ?? "appear",
      ];
      if (typeof args.timeout_ms === "number") {
        cmdArgs.push("--timeout", String(Math.min(60_000, Math.max(1000, args.timeout_ms))));
      }
      const data = await client.runJson(cmdArgs);
      return {
        device: device.id,
        matched: data?.matched === true,
        text: args.text,
      };
    },
  });

  const logsTool = defineTool({
    name: TOOL_NAMES.logs,
    description:
      "读设备日志（Android 是 logcat，iOS 是 unified log）。"
      + " 用来查崩溃、看应用的运行时输出、或者确认某段代码真的跑了。"
      + " mode=snapshot 取最近一段（默认 2 分钟），mode=follow 抓一小段实时输出后返回"
      + "（有上限，不会挂住）。",
    parameters: {
      device: { type: "string", description: "设备 id；只有一台在线设备时可省略" },
      mode: { type: "string", enum: ["snapshot", "follow"], description: "默认 snapshot" },
      duration: { type: "string", description: "snapshot 的时间窗，如 2m / 30s，默认 2m" },
      duration_seconds: { type: "integer", description: "follow 抓取秒数，默认 10，上限 60" },
      grep: { type: "string", description: "按子串过滤日志行" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          device: { type: "string", required: true },
          lines: { type: "array", required: true, items: { type: "string" } },
          truncated: { type: "boolean" },
        },
      },
      render: renderJson,
    },
    timeoutMs: 90_000,
    async execute(args) {
      const device = await resolveDevice(client, args.device, "mobile_logs");
      const cmdArgs = ["device", "logs", "--device", device.id];
      // 日志流是无限输出，必须限流：limit 让它拿到 N 条后自然结束。
      cmdArgs.push("--limit", "300");
      if (typeof args.grep === "string" && args.grep !== "") {
        cmdArgs.push("--filter", `message=${args.grep}`);
      }
      const data = await client.runJson(cmdArgs, { timeoutMs: 60_000 });
      const lines = Array.isArray(data) ? data : (data?.lines ?? []);
      return {
        device: device.id,
        lines: lines.slice(0, 300).map((l) => (typeof l === "string" ? l : JSON.stringify(l))),
        ...(lines.length > 300 ? { truncated: true } : {}),
      };
    },
  });

  /**
   * 把面板打开给**用户**看。
   *
   * ⚠️ 这个工具不是给你自己读界面用的 —— 你**看不到**这个面板（它在用户的
   * 浏览器里，不在你的上下文里）。它的用途是：当你需要用户親眼看手机屏幕
   * 时（"你点一下这个弹窗"、"确认一下这一屏对不对"），把画面推到他面前，
   * 而不是让他自己去翻侧边栏。
   *
   * 实现上要跨进程：工具跑在 Host，侧边栏在浏览器。DSH 没有给客户端插件
   * 通用的 host→client 推送通道，所以走客户端的长轮询（见 routes.js 里
   * `#panelOpen` 的说明）。客户端**在插件加载时**就开始轮询，因此面板当前
   * 没打开也能被打开。
   *
   * 返回 `opened: true` 表示客户端**回执确认**了；false 说明没人应答
   * （网页没开 / 客户端半边没加载），此时不该对用户说"已经打开了"。
   */
  const openPanelTool = defineTool({
    name: TOOL_NAMES.openPanel,
    description:
      "把 DSH 右侧边栏的移动设备面板打开（若已打开则切到它），让**用户**能看到手机画面。"
      + " 当你需要用户亲眼看设备屏幕、或要点他配合操作某一屏时用它。"
      + " ⚠️ 你自己看不到这个面板 —— 它是给用户的，不是给你读界面的；"
      + "要读界面请用 mobile_ui_tree / mobile_screenshot。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          opened: { type: "boolean", required: true },
          waitedMs: { type: "integer", required: true },
          reason: { type: "string" },
        },
      },
      render: renderJson,
    },
    timeoutMs: 20_000,
    async execute() {
      if (typeof openPanel !== "function") {
        return {
          opened: false,
          waitedMs: 0,
          reason: "宿主没有提供打开面板的能力（面板路由未挂载）。",
        };
      }
      return await openPanel();
    },
  });

  /**
   * 只注册「工具能做得比 CLI 更好」的那些。
   *
   * 被刻意**排除**的 5 个（原先在此）：`mobile_tap` / `mobile_swipe` /
   * `mobile_press_button` / `mobile_type_text` / `mobile_launch_app`。
   * 它们都只是 `client.runJson([...])` 加一句 `return`，没有任何加工；
   * 而 agent 本来就有 shell，直接跑 `mobilecli io tap …` 完全等价。
   *
   * 依据（实测，按 dsh-token-meter 的 ceil(chars/4)+4 公式）：
   *   16 个工具 schema = 1487 tokens/轮（每次请求都发）
   *   删掉这 5 个     = 1138 tokens/轮  → **省 349 tokens/轮**
   *
   * 保留的 11 个都是"加工型"，skill 替代不了：
   *   · ui_tree       —— 把 mobilecli 的**嵌套**树拍平。实测只读顶层
   *                      得到 0 个可用元素，拍平后 92 个。
   *   · wait_for      —— OCR 轮询循环，单次 CLI 调用表达不了。
   *   · tap_element / tap_text / find_text —— 元素定位 + 失败时把可见元素
   *                      摘进错误信息，省一次往返。
   *   · boot          —— **耦合面板**：启动后 acquireSession 订阅一次把流拉起。
   *   · devices       —— 合并设备数据与流池的 streaming 状态。
   *   · screenshot    —— 落临时文件并返回 { path, bytes }。
   *   · logs          —— 限流 + 过滤构造 + 行整形。
   *   · list_apps     —— 客户端过滤 + packageName/bundleId/id 归一化。
   *   · open_panel    —— **跨进程**：Host 工具去驱动浏览器里的侧边栏，
   *                      靠客户端长轮询 + 回执才做得到。
   *
   * ⚠️ 被删的 5 个命令的**关键知识**不能一起丢（坐标是物理像素、
   * swipe 必须传 --duration 否则默认 1000ms、type_text 要求先聚焦、
   * button 的键名、launch 前先 list 应用）—— 已写进
   * `skills/mobilecli/SKILL.md` 的「Driving the device from the shell」一节。
   *
   * ⚠️ `flutter_tree` 原先列在上面是**错的** —— 它不是"加工型"，而是
   * `ui_tree` 的副本（同一个 `dumpUiElements`），描述却声称直连 VM Service。
   * 已删除，理由见 REMOVED_TOOL_NAMES 里那段。
   */
  return {
    [TOOL_NAMES.devices]: devicesTool,
    [TOOL_NAMES.boot]: bootTool,
    [TOOL_NAMES.screenshot]: screenshotTool,
    [TOOL_NAMES.uiTree]: uiTreeTool,
    [TOOL_NAMES.tapElement]: tapElementTool,
    [TOOL_NAMES.listApps]: listAppsTool,
    [TOOL_NAMES.findText]: findTextTool,
    [TOOL_NAMES.tapText]: tapTextTool,
    [TOOL_NAMES.waitFor]: waitForTool,
    [TOOL_NAMES.logs]: logsTool,
    [TOOL_NAMES.openPanel]: openPanelTool,
  };
}

// ── 内部工具 ────────────────────────────────────────────────────────────

/**
 * 读设备的 UI 树并**扁平化**成元素数组。
 *
 * mobilecli 的 `dump ui --format json` 返回的是一棵嵌套树：
 *
 *     { status:"ok", data:{ elements:[ {ref,type,text,identifier,rect,children:[…]} ] } }
 *
 * 子节点挂在每个元素的 `children` 下而不是平铺在顶层。直接读
 * `data.elements` 只会拿到最外层的几个容器（实测：一个页面顶层只有
 * 状态栏相关的 6 个 FrameLayout），真正的控件全在深层——这正是
 * "读出一片空白"的典型来源。
 *
 * 所以这里按深度优先展开，并保留每个元素的 ref（mobilecli 用它做
 * 免坐标点击）。判空也要在展开之后：展开前为空才能真正说明"没有元素"。
 *
 * @param {import("./mobilecli.js").Mobilecli} client
 * @param {string} deviceId
 * @returns {Promise<any[]>}
 */
async function dumpUiElements(client, deviceId) {
  const data = await client.runJson(["dump", "ui", "--device", deviceId, "--format", "json"]);
  // 兼容两种形状：对象带 data.elements，或直接就是数组
  const roots = Array.isArray(data) ? data : (data?.elements ?? []);

  const flat = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    const { children, ...rest } = node;
    flat.push(rest);
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    }
  };
  for (const root of roots) visit(root);
  return flat;
}

/**
 * 在 UI 树里按标识/文本找元素。
 * 精确匹配优先，其次不区分大小写的子串。
 *
 * @returns {Promise<any|null>}
 */
async function findElement(client, deviceId, { identifier, text }) {
  const elements = await dumpUiElements(client, deviceId);

  const matches = (el, mode) => {
    const identifierHit =
      typeof identifier === "string" &&
      typeof el.identifier === "string" &&
      (mode === "exact" ? el.identifier === identifier : el.identifier.toLowerCase().includes(identifier.toLowerCase()));
    const textHit =
      typeof text === "string" &&
      (mode === "exact"
        ? el.text === text || el.label === text
        : (typeof el.text === "string" && el.text.toLowerCase().includes(text.toLowerCase())) ||
          (typeof el.label === "string" && el.label.toLowerCase().includes(text.toLowerCase())));
    return identifierHit || textHit;
  };

  for (const mode of ["exact", "substring"]) {
    const hits = elements.filter((el) => matches(el, mode));
    if (hits.length === 0) continue;

    // 多个命中时优先可点击的、面积更小的（更可能是真正的目标而不是容器）
    const withArea = hits
      .map((el) => ({
        el,
        area: el.rect === undefined ? Number.MAX_SAFE_INTEGER : el.rect.width * el.rect.height,
      }))
      .sort((a, b) => a.area - b.area);
    const best = withArea.find((c) => c.el.rect !== undefined);
    return best?.el ?? hits[0];
  }
  return null;
}

/** 取矩形的中心点。 */
function centerOf(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

/**
 * 轮询等待某段文本出现。
 *
 * 用 UI 树而不是 OCR：树读快一个数量级，而且多数「等一个元素出现」的
 * 场景里目标本来就是有语义的。轮询有上限，不会无限等。
 *
 * @returns {Promise<boolean>}
 */
async function waitForText(client, deviceId, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const elements = await dumpUiElements(client, deviceId);
      const lower = needle.toLowerCase();
      const hit = elements.some(
        (el) =>
          (typeof el.text === "string" && el.text.toLowerCase().includes(lower)) ||
          (typeof el.label === "string" && el.label.toLowerCase().includes(lower)),
      );
      if (hit) return true;
    } catch {
      // 读失败不当作「没出现」，继续轮询到超时
    }
    await sleep(400);
  }
  return false;
}

/** 拼一个临时目录下的路径。 */
function joinTmp(filename) {
  const base = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
  return `${base.replace(/\/+$/, "")}/${filename}`;
}

/** 取文件大小。 */
async function statFile(path) {
  const { stat } = await import("node:fs/promises");
  const info = await stat(path);
  return { size: info.size };
}

/** 睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
