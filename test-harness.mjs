/**
 * 自测：mobilecli 客户端的解析、调用与错误归一化。
 *
 * 这个 harness **不需要真机**也能跑完：没有设备/没有二进制时，它验证的是
 * 「解析失败会给出可读错误」这条路径，而不是假装成功。有设备时额外跑一遍
 * 真实调用，结果打印出来供人工比对。
 *
 * 用法：
 *   node test-harness.mjs
 *   MOBILECLI_TEST_HOME=/tmp/mclihome node test-harness.mjs
 *
 * @module dsh-sidebar-mobile/test-harness
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { Readable } from "node:stream";
import { Mobilecli, resolveBinary } from "./lib/device/mobilecli.js";
import { resolveDevice } from "./lib/agent/device-resolution.js";
import {
  createMobileLoopRequest,
  isJudgmentUsable,
  runMobileLoop,
} from "./lib/agent/mobile-loop.js";
import { StreamRoutes, mountRoutes, toDeviceCoordinates } from "./lib/stream/routes.js";
import {
  resolveSocketPath,
  callDaemon,
  isSafeCliFallbackError,
  rpcForInput,
  rpcForDeviceAction,
  DaemonRpc,
} from "./lib/device/daemon-rpc.js";

let passed = 0;
let failed = 0;

/**
 * 跑一个测试用例，失败不中断后续用例。
 * @param {string} name
 * @param {() => void|Promise<void>} fn
 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}

function makeJudge(answers, purpose = "mobile.action") {
  const fingerprint = (state, questions, options) =>
    JSON.stringify({ state, questions, purpose: options?.purpose });
  return {
    apiVersion: 1,
    status: () => ({ purposes: [{ purpose, usable: true }] }),
    fingerprint,
    async ask(state, questions, options) {
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return {
        answers: { next_step: answer },
        fingerprint: fingerprint(state, questions, options),
      };
    },
  };
}

async function testUnixSocket(name, fn) {
  if (process.platform === "win32") {
    console.log(`  - skipped on Windows: ${name}`);
    return;
  }
  await test(name, fn);
}

console.log("mobilecli 客户端自测\n");

// ── 二进制解析 ──────────────────────────────────────────────────────────

console.log("二进制解析");

await test("不存在的显式路径 → null（而不是抛错）", () => {
  assert.equal(resolveBinary("/nonexistent/mobilecli"), null);
});

await test("MOBILECLI_PATH 指向不存在的文件时被忽略", () => {
  const saved = process.env.MOBILECLI_PATH;
  process.env.MOBILECLI_PATH = "/nonexistent/from-env";
  try {
    // PATH 上可能真有 mobilecli；这里只断言「不会返回那个坏路径」
    const resolved = resolveBinary(null);
    assert.notEqual(resolved, "/nonexistent/from-env");
  } finally {
    if (saved === undefined) delete process.env.MOBILECLI_PATH;
    else process.env.MOBILECLI_PATH = saved;
  }
});

// Windows 上 npm -g 会生成三个 shim，其中两个跑不起来：
//   mobilecli      → POSIX sh 脚本，execFile 报 ENOENT（无扩展名不是合法映像）
//   mobilecli.cmd  → execFile 报 EINVAL（Node 为 CVE-2024-27980 拒绝 .cmd）
// 曾经的 findOnPath 只看裸名字，命中的正是那个 sh 脚本 —— 于是所有命令都
// ENOENT，插件在 Windows 上完全不可用。这个测试锁住"绝不返回 .cmd/.bat"。
await test("解析结果绝不是跑不起来的 shell shim（Windows 回归）", () => {
  const resolved = resolveBinary(null);
  if (resolved === null) return; // 没装 mobilecli 是允许的状态
  const lower = resolved.toLowerCase();
  assert.ok(!lower.endsWith(".cmd"), `.cmd 无法被 execFile 执行：${resolved}`);
  assert.ok(!lower.endsWith(".bat"), `.bat 无法被 execFile 执行：${resolved}`);
  assert.ok(!lower.endsWith(".ps1"), `.ps1 不是可执行映像：${resolved}`);
  // Windows 上必须是真正的 .exe 映像
  if (process.platform === "win32") {
    assert.ok(lower.endsWith(".exe"), `Windows 上应解析到 .exe，实际：${resolved}`);
  }
});

const explicit = process.env.MOBILECLI_BIN ?? resolveBinary(null);

// ── 无二进制时的降级 ────────────────────────────────────────────────────

console.log("\n无可用二进制时的行为");

if (explicit === null) {
  console.log("  ⏭  未找到 mobilecli，跳过调用测试（这是允许的状态）");
  console.log("     装上后重跑：npm i -g mobilecli@latest");
} else {
  console.log(`  使用二进制：${explicit}`);
  const mc = new Mobilecli({
    binary: explicit,
    home: process.env.MOBILECLI_TEST_HOME ?? null,
  });

  await test("version() 返回版本串", async () => {
    const v = await mc.version();
    assert.ok(typeof v === "string" && v.includes("mobilecli"), `got: ${v}`);
  });

  await test("不存在的子命令 → MobilecliError（不是崩溃）", async () => {
    await assert.rejects(
      () => mc.runJson(["definitely-not-a-command"]),
      (error) => {
        assert.equal(error.name, "MobilecliError");
        assert.ok(typeof error.code === "string");
        return true;
      },
    );
  });

  // ── 回归：错误信息绝不能是空字符串 ──────────────────────────────────
  //
  // 曾经写成 `parsed?.error ?? stderr.trim() ?? error?.message ?? "…"`。
  // 没有 stderr 时 `stderr.trim()` 是**空字符串**，而空串不是 nullish，
  // `??` 不会跳过它 → 整个表达式得到 ""，工具就报出一个 `Error: `
  // （冒号后面什么都没有）。用户和模型都拿不到任何线索。
  await test("失败时错误信息非空（空 stderr 不能吞掉 message）", async () => {
    await assert.rejects(
      () => mc.runJson(["definitely-not-a-command"]),
      (error) => {
        assert.ok(
          typeof error.message === "string" && error.message.trim() !== "",
          `错误信息不能为空，实际：${JSON.stringify(error.message)}`,
        );
        return true;
      },
    );
  });

  await test("daemonStatus() 永不抛错，失败降级为 running:false", async () => {
    const status = await mc.daemonStatus();
    assert.equal(typeof status, "object");
    assert.ok("running" in status || "error" in status);
  });

  // 真实设备调用：仅在环境允许时跑。
  if (process.env.MOBILECLI_TEST_SKIP_DEVICES === "1") {
    console.log("  ⏭  跳过设备发现（MOBILECLI_TEST_SKIP_DEVICES=1）");
  } else {
    await test("listDevices() 返回数组", async () => {
      const devices = await mc.listDevices();
      assert.ok(Array.isArray(devices), "devices 应为数组");
      console.log(`     发现 ${devices.length} 台设备`);
      for (const d of devices) {
        // 每个字段都是面板与工具要用到的，缺一不可预测
        assert.ok(typeof d.id === "string" && d.id !== "", "缺少 id");
        assert.ok(typeof d.platform === "string", "缺少 platform");
        assert.ok(typeof d.name === "string", "缺少 name");
        console.log(`       · ${d.name} [${d.platform}/${d.type}] ${d.state}`);
      }
    });

    // 设备列表缓存：一次点击原本要付 381ms 的 devices 查询，缓存后同秒内复用。
    // 但**失败的查询不能进缓存** —— 否则一次抖动会让面板长时间显示错误状态。
    await test("listDevices 命中缓存（第二次不再 spawn）", async () => {
      const fresh = new Mobilecli({ binary: explicit, home: null });
      const first = await fresh.listDevices();
      const t0 = Date.now();
      const second = await fresh.listDevices();
      const elapsed = Date.now() - t0;
      assert.deepEqual(second, first, "缓存内容应与首次一致");
      // 命中缓存应该是"立刻返回"量级；真跑一次要几百毫秒
      assert.ok(elapsed < 50, `命中缓存应很快，实际 ${elapsed}ms`);
      // fresh:true 必须绕过缓存
      const forced = await fresh.listDevices({ fresh: true });
      assert.ok(Array.isArray(forced));
      fresh.invalidateDevices();
    });
  }
}

// ── 回归：错误信息绝不能是空字符串（无需设备的纯逻辑）──────────────────
//
// 这条守着一个真实踩到的坑：曾经写成
//     parsed?.error ?? stderr.trim() ?? error?.message ?? "mobilecli command failed"
// 没有 stderr 时 `stderr.trim()` 是**空字符串**，而空串不是 nullish ——
// `??` 不会跳过它，整个表达式就得到 ""。表现为工具报一个 `Error: `
// （冒号后什么都没有），用户和模型都拿不到线索。用不存在的二进制来复现：
// spawn 失败本身就可能没有 stderr。

console.log("\n错误信息非空（回归）");

await test("二进制不存在时，错误信息必须非空且可读", async () => {
  const broken = new Mobilecli({ binary: "/nonexistent/mobilecli-binary-xyz", home: null });
  await assert.rejects(
    () => broken.runJson(["devices"]),
    (error) => {
      assert.equal(error.name, "MobilecliError");
      assert.ok(
        typeof error.message === "string" && error.message.trim() !== "",
        `错误信息不能为空，实际：${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

await test("命令失败时错误信息非空（空 stderr 不能吞掉原因）", async () => {
  // 用系统上一定存在的可执行文件跑一个非法参数，制造"非零退出但无 stderr"
  const bin = process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
  const mc2 = new Mobilecli({ binary: bin, home: null });
  await assert.rejects(
    () => mc2.runJson(["--this-flag-does-not-exist-xyz"]),
    (error) => {
      assert.ok(
        typeof error.message === "string" && error.message.trim() !== "",
        `错误信息不能为空，实际：${JSON.stringify(error.message)}`,
      );
      return true;
    },
  );
});

// ── 流访问控制 ──────────────────────────────────────────────────────────
//
// 这一段全是纯函数与内存对象，不需要设备也不需要 webServer，
// 因此永远会跑。围栏是这套插件唯一的安全边界，必须有回归保护。

console.log("\n流访问控制");

const {
  StreamAccessController,
  prepareStreamAccessKey,
  checkTransportFence,
  isLoopbackRemoteAddress,
  isSameOriginRequest,
  parseTrustedAuthority,
} = await import("./lib/stream/access.js");

await test("loopback 判定覆盖 IPv4 / IPv6 / mapped / 非本机", () => {
  for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) {
    assert.ok(isLoopbackRemoteAddress(addr), `${addr} 应判为 loopback`);
  }
  for (const addr of ["192.168.1.5", "10.0.0.1", "", undefined]) {
    assert.ok(!isLoopbackRemoteAddress(addr), `${addr} 不应判为 loopback`);
  }
});

await test("trustedAuthority 解析：host / host:port / scheme://host:port", () => {
  assert.deepEqual(parseTrustedAuthority("example.com"), { host: "example.com", port: null, scheme: null });
  assert.deepEqual(parseTrustedAuthority("example.com:8443"), { host: "example.com", port: 8443, scheme: null });
  assert.deepEqual(parseTrustedAuthority("https://example.com:8443"), { host: "example.com", port: 8443, scheme: "https" });
});

await test("trustedAuthority 拒绝带路径 / 查询 / 凭证的写法", () => {
  assert.equal(parseTrustedAuthority("example.com/path"), null);
  assert.equal(parseTrustedAuthority("https://user:pass@example.com"), null);
  assert.equal(parseTrustedAuthority("example.com?a=1"), null);
});

const accessKey = prepareStreamAccessKey();

await test("签名密钥为 32 字节，且落盘后稳定", () => {
  assert.ok(Buffer.isBuffer(accessKey), "应为 Buffer");
  assert.equal(accessKey.length, 32);
  // 再读一次必须拿到同一把：否则页面刷新会让已发出的 token 全失效
  assert.deepEqual(prepareStreamAccessKey(), accessKey);
});

const access = new StreamAccessController({ key: accessKey });

await test("token 往返并把设备绑定进签名", () => {
  const verified = access.verify(access.mint("dev-A"));
  assert.ok(verified.ok);
  assert.equal(verified.deviceId, "dev-A");
});

await test("篡改载荷中的设备名 → 签名不符", () => {
  const token = access.mint("dev-A");
  const [payloadB64, mac] = token.split(".");
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  const forged = Buffer.from(payload.replace("dev-A", "dev-B"), "utf8").toString("base64url");
  assert.ok(!access.verify(`${forged}.${mac}`).ok, "篡改后必须失败");
});

await test("过期 token 被拒", () => {
  const shortLived = new StreamAccessController({ key: accessKey, ttlMs: -1 });
  assert.ok(!shortLived.verify(shortLived.mint("d")).ok);
});

await test("缺失 / 畸形 token 被拒", () => {
  for (const bad of [undefined, "", "nodot", "a.b", "...."]) {
    assert.ok(!access.verify(bad).ok, `${String(bad)} 应被拒`);
  }
});

await test("别的 DSH_HOME 签出的 token 无效", () => {
  const other = new StreamAccessController({ key: Buffer.alloc(32, 7) });
  assert.ok(!other.verify(access.mint("d")).ok);
});

/** 造一个最小的请求对象给围栏用。 */
const fakeRequest = (remote, host, origin) => ({
  socket: { remoteAddress: remote },
  headers: { host, ...(origin === undefined ? {} : { origin }) },
});

await test("围栏：非 loopback 对端一律拒（TCP 层事实，伪造不了）", () => {
  const result = checkTransportFence(fakeRequest("10.0.0.9", "127.0.0.1:3080"));
  assert.ok(!result.ok);
  assert.match(result.reason, /non-loopback/);
});

await test("围栏：loopback 对端 + loopback Host 放行", () => {
  assert.ok(checkTransportFence(fakeRequest("127.0.0.1", "127.0.0.1:3080")).ok);
  assert.ok(checkTransportFence(fakeRequest("::1", "localhost:3080")).ok);
  assert.ok(checkTransportFence(fakeRequest("127.0.0.1", "[::1]:3080")).ok);
});

await test("围栏：DNS rebinding（loopback 对端 + 外域 Host）被拒", () => {
  assert.ok(!checkTransportFence(fakeRequest("127.0.0.1", "evil.com")).ok);
});

await test("围栏：trustedAuthorities 放行已配置的 authority", () => {
  const trusted = [parseTrustedAuthority("dsh.example.com")];
  assert.ok(checkTransportFence(fakeRequest("127.0.0.1", "dsh.example.com"), trusted).ok);
  assert.ok(checkTransportFence(fakeRequest("127.0.0.1", "dsh.example.com:8443"), trusted).ok, "未钉端口时应任意端口");
});

await test("围栏：配置钉了端口则其它端口被拒", () => {
  const trusted = [parseTrustedAuthority("dsh.example.com:8443")];
  assert.ok(!checkTransportFence(fakeRequest("127.0.0.1", "dsh.example.com:9999"), trusted).ok);
});

await test("围栏：配置钉了 scheme 则 Origin 必须匹配", () => {
  const trusted = [parseTrustedAuthority("https://dsh.example.com:8443")];
  assert.ok(checkTransportFence(fakeRequest("127.0.0.1", "dsh.example.com:8443", "https://dsh.example.com:8443"), trusted).ok);
  assert.ok(!checkTransportFence(fakeRequest("127.0.0.1", "dsh.example.com:8443", "http://dsh.example.com:8443"), trusted).ok);
});

await test("围栏：缺 Host 头被拒", () => {
  assert.ok(!checkTransportFence({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }).ok);
});

await test("同源校验：跨站 POST 被拒，无 Origin 交给围栏兜底", () => {
  assert.ok(isSameOriginRequest({ headers: { host: "a.com", origin: "http://a.com" } }));
  assert.ok(!isSameOriginRequest({ headers: { host: "a.com", origin: "http://b.com" } }));
  assert.ok(isSameOriginRequest({ headers: { host: "a.com" } }));
});

// ── 流格式嗅探 ──────────────────────────────────────────────────────────
//
// 格式不能靠"我们请求了什么"来判断：iOS 模拟器上 `--format avc` 会静默
// 降级成 MJPEG（实测），所以必须从首块字节认。

console.log("\n流格式嗅探");

const { sniffStreamFormat } = await import("./lib/stream/session.js");

await test("识别 H.264 Annex B（4 字节起始码）", () => {
  const head = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e]);
  assert.equal(sniffStreamFormat(head).kind, "h264");
  assert.equal(sniffStreamFormat(head).contentType, "video/h264");
});

await test("识别 H.264 Annex B（3 字节起始码）", () => {
  assert.equal(sniffStreamFormat(Buffer.from([0, 0, 1, 0x67])).kind, "h264");
});

await test("识别 MJPEG 并提取 boundary", () => {
  const head = Buffer.from("--myboundary\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff", "latin1");
  const format = sniffStreamFormat(head);
  assert.equal(format.kind, "mjpeg");
  assert.equal(format.contentType, "multipart/x-mixed-replace; boundary=myboundary");
});

await test("空 / 未知数据不误判", () => {
  assert.equal(sniffStreamFormat(Buffer.alloc(0)).kind, "unknown");
  assert.equal(sniffStreamFormat(Buffer.from([0x7b, 0x22])).kind, "unknown");
  assert.equal(sniffStreamFormat(null).kind, "unknown");
});

// ── 交互输入校验 ────────────────────────────────────────────────────────

console.log("\n交互输入校验");

const { validateInput } = await import("./lib/stream/routes.js");

await test("tap 要求数值型坐标", () => {
  assert.ok(validateInput("tap", { x: 10, y: 20 }).ok);
  assert.ok(!validateInput("tap", { x: "10", y: 20 }).ok, "字符串坐标应被拒");
  assert.ok(!validateInput("tap", { x: Number.NaN, y: 20 }).ok, "NaN 应被拒");
  assert.ok(!validateInput("tap", {}).ok);
});

await test("坐标取整（设备只认整数）", () => {
  assert.equal(validateInput("tap", { x: 10.6, y: 20.2 }).input.x, 11);
});

await test("swipe 要求四个坐标", () => {
  assert.ok(validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1 }).ok);
  assert.ok(!validateInput("swipe", { x1: 0, y1: 0, x2: 1 }).ok);
});

// duration 必须能穿过 Host 校验层。丢了它，mobilecli 就会用平台默认的
// 1000ms —— 实测每次滑动 1074ms 而不是 374ms，客户端算出的时长白算了。
await test("swipe 透传 duration，并夹取到安全区间", () => {
  const withDuration = validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1, duration: 250 });
  assert.ok(withDuration.ok);
  assert.equal(withDuration.input.duration, 250);

  // 不传时不硬塞（由 sendInput 决定默认值）
  const without = validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1 });
  assert.ok(without.ok);
  assert.equal(without.input.duration, undefined);

  // 畸形值不能把设备端卡住
  assert.equal(validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1, duration: 99999 }).input.duration, 2000);
  assert.equal(validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1, duration: 1 }).input.duration, 80);
  // 非数值直接忽略，而不是变成 NaN 传给 mobilecli
  assert.equal(validateInput("swipe", { x1: 0, y1: 0, x2: 1, y2: 1, duration: "fast" }).input.duration, undefined);
});

await test("text 要求非空字符串", () => {
  assert.ok(validateInput("text", { text: "hi" }).ok);
  assert.ok(!validateInput("text", { text: "" }).ok);
  assert.ok(!validateInput("text", { text: 42 }).ok);
});

await test("button 限定白名单", () => {
  assert.ok(validateInput("button", { name: "home" }).ok, "应接受小写并归一化");
  assert.equal(validateInput("button", { name: "home" }).input.name, "HOME");
  assert.ok(!validateInput("button", { name: "rm -rf /" }).ok);
});

await test("未知 action 被拒", () => {
  assert.ok(!validateInput("launch_missiles", {}).ok);
});

// ── 路由匹配 ────────────────────────────────────────────────────────────

console.log("\n路由匹配");

const { matchRouteName } = await import("./lib/stream/routes.js");
const PREFIX = "/_dsh/dsh-sidebar-mobile";

await test("匹配已知路由", () => {
  assert.equal(matchRouteName(`${PREFIX}/stream/abc`, PREFIX), "stream");
  assert.equal(matchRouteName(`${PREFIX}/grant`, PREFIX), "grant");
  assert.equal(matchRouteName(`${PREFIX}/status?x=1`, PREFIX), "status");
});

await test("拒绝未知路由与裸前缀", () => {
  assert.equal(matchRouteName(`${PREFIX}/nope`, PREFIX), null);
  assert.equal(matchRouteName(PREFIX, PREFIX), null);
  assert.equal(matchRouteName("/other/stream", PREFIX), null);
});

// ── 背压对齐：两种格式的「帧边界」不是一回事 ────────────────────────────
//
// 这一段锁的是一个真实缺陷：拥塞丢弃时两种格式**共用**了 H.264 起始码逻辑。
// MJPEG 的 JPEG 像素数据里天然大量出现 00 00 01（实测 36MB 流里 1925 个三字节
// + 3465 个四字节），按它截断会切出不含 multipart boundary 的半截 JPEG ——
// 那一帧永远等不到结束标记（浏览器不渲染），恢复投递后的残余字节还会被当成
// 上一帧的像素。MJPEG 实测 21.8 Mbps、每帧 ~35KB，而阈值 256KB，积压约 7 帧
// 就触发，所以这是日常路径而不是边角情况。
//
// 实测对照（真实 iOS 模拟器流，抽样 719 个 64KB 块）：
//   旧（起始码）切在帧中间：506 ❌
//   新（boundary）切在帧中间：  0 ✅

console.log("\n背压对齐");

const { findStartCode, lastStartCode, findBoundary, lastBoundary } =
  await import("./lib/stream/routes.js");

/** 造一段真实的 MJPEG multipart 数据（帧内含 00 00 01 序列）。 */
function fakeMjpeg(boundary, frameCount, filler) {
  const parts = [];
  for (let i = 0; i < frameCount; i++) {
    parts.push(
      Buffer.from(`${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${filler.length}\r\n\r\n`, "latin1"),
      filler,
      Buffer.from("\r\n", "latin1"),
    );
  }
  return Buffer.concat(parts);
}

await test("H.264：起始码能找到帧边界", () => {
  const gop = Buffer.concat([
    Buffer.from([0, 0, 0, 1, 0x67]), // SPS
    Buffer.from([0, 0, 0, 1, 0x68]), // PPS
    Buffer.from([0, 0, 0, 1, 0x65, 0xaa]),
    Buffer.from([0, 0, 1, 0x41, 0xbb]),
  ]);
  assert.equal(findStartCode(gop), 0, "第一个起始码应在 0");
  // 最后一个起始码是末尾那个**三字节**形式，位于索引 16（不是 gop.length-3：
  // 4 字节形式占 4 个位置，所以末段起点比 length-3 更靠前）
  assert.equal(lastStartCode(gop), 16, "最后一个起始码应在末尾那段");
  assert.deepEqual([...gop.subarray(16, 19)], [0, 0, 1], "该位置确实是起始码");
  // 三字节与四字节都要认
  assert.notEqual(findStartCode(Buffer.from([9, 9, 0, 0, 1, 0x41])), -1);
  assert.notEqual(findStartCode(Buffer.from([9, 9, 0, 0, 0, 1, 0x41])), -1);
  // 跨在块尾的 00 00 00（第 4 字节还没到）不能误判成起始码
  assert.equal(lastStartCode(Buffer.from([9, 9, 0, 0, 0])), -1, "跨块尾的 00 00 00 不是起始码");
});

await test("MJPEG：起始码会落在 JPEG 数据内部（所以不能用它对齐）", () => {
  const BOUNDARY = "--mjpeg-frame-boundary";
  // JPEG 里出现 00 00 01 是**正常**的（它就是像素/段数据的一部分）
  const filler = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x01, 0x00, 0xff, 0xd9]);
  const stream = fakeMjpeg(BOUNDARY, 4, filler);

  const at = findStartCode(stream);
  assert.notEqual(at, -1, "构造的数据里应当有 00 00 01");
  // 关键断言：起始码给出的位置**不是** boundary 起点
  assert.notEqual(
    stream.subarray(at, at + 2).toString("latin1"),
    "--",
    "MJPEG 里按起始码对齐会切在帧中间 —— 这正是那个缺陷",
  );
});

await test("MJPEG：boundary 对齐永远切在帧边界上", () => {
  const BOUNDARY = "--mjpeg-frame-boundary";
  const filler = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x01, 0x00, 0xff, 0xd9]);
  const stream = fakeMjpeg(BOUNDARY, 6, filler);

  // 恢复点：找到的每个 boundary 都必须真是 boundary 起点
  let from = 0;
  let found = 0;
  for (;;) {
    const at = findBoundary(stream.subarray(from), BOUNDARY);
    if (at === -1) break;
    const abs = from + at;
    assert.equal(
      stream.subarray(abs, abs + BOUNDARY.length).toString("latin1"),
      BOUNDARY,
      "findBoundary 的返回值必须正好落在 boundary 起点",
    );
    found++;
    from = abs + BOUNDARY.length;
  }
  assert.equal(found, 6, `应找到 6 个 boundary，实际 ${found}`);

  // 切点：最后一个是第 6 个（最后一个）boundary 的起点
  const cut = lastBoundary(stream, BOUNDARY);
  assert.ok(cut > 0, "应当能找到最后一个 boundary");
  assert.equal(
    stream.subarray(cut, cut + BOUNDARY.length).toString("latin1"),
    BOUNDARY,
    "lastBoundary 必须停在完整帧的结尾（即下一帧的 boundary 起点）",
  );
  // 投递到 cut 为止：被投递的部分以完整帧（含结尾 \r\n）结束
  const sent = stream.subarray(0, cut);
  assert.ok(
    sent.subarray(-2).toString("latin1") === "\r\n",
    "被投递的部分应以完整帧结尾，而不是半截 JPEG",
  );
});

await test("boundary 找不到时返回 -1（调用方据此整块丢弃）", () => {
  const data = Buffer.from("no boundary here at all", "latin1");
  assert.equal(findBoundary(data, "--mjpeg-frame-boundary"), -1);
  assert.equal(lastBoundary(data, "--mjpeg-frame-boundary"), -1);
});

// ── 交互延迟：热路径不许查设备列表 ──────────────────────────────────────
//
// 这一段锁的是一个**体感**问题：用户反馈"点一下按钮要等 300 多毫秒"。
//
// 根因是 #requireActiveDevice 每次点击/滑动都调 listDevices 复核设备。
// 实测分解（一加 12）：
//
//     mobilecli devices --include-offline   328 ms   ← 完整的设备枚举
//     mobilecli io tap                      103 ms   ← 真正的操作
//     合计                                  431 ms
//
// 也就是 **76% 的点击延迟花在一个只用来"确认设备还在"的预检查上**。
// 它只买到"早 328ms 失败"，代价是让所有正常操作都慢 328ms。
//
// 去掉之后：431 → 103 ms。设备真掉线时 mobilecli 自己会报
// `device not found: <id>`（实测），错误信息一样清楚。
//
// 用真实 StreamRoutes 驱动，断言的是**调用序列**（不依赖计时，稳定）。

console.log("\n交互延迟");

/** 造一个记录了调用序列的假 client。 */
function latencyHarness() {
  const calls = [];
  const client = {
    async listDevices() {
      calls.push("listDevices");
      return [{ id: "dev1", name: "一加 12", platform: "android", state: "online" }];
    },
    async runJson(args) {
      calls.push(`runJson:${args.join(" ")}`);
      return {};
    },
  };
  const pool = {
    acquire: () => ({ sendInput: (run) => run(["io", "tap", "--device", "dev1", "1,2"]) }),
  };
  const routes = new StreamRoutes({ client, pool, access: { mint: () => "t" }, log: () => {} });
  routes.activeDeviceId = "dev1";
  return { routes, calls };
}

/** 最小的 req/res 替身（走 req.on("data"/"end") 那条路）。 */
function latencyReqRes(body) {
  const req = new Readable({ read() {} });
  req.method = "POST";
  req.url = "/control";
  req.headers = {
    host: "127.0.0.1:19387",
    origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" };
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(payload) { this.body = payload ?? ""; },
    write() {},
    on() {},
    setHeader() {},
  };
  req.push(Buffer.from(JSON.stringify(body)));
  req.push(null);
  return { req, res };
}

await test("control 热路径不查设备列表（否则每次点击多付 328ms）", async () => {
  const { routes, calls } = latencyHarness();
  const { req, res } = latencyReqRes({ action: "tap", x: 1, y: 2 });
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 200, `应当成功，实际 ${res.statusCode} ${res.body}`);
  assert.equal(
    calls.filter((c) => c === "listDevices").length,
    0,
    "热路径查了设备列表 —— 那是一次 328ms 的完整枚举，正是点击延迟的来源",
  );
  assert.equal(calls.length, 1, `应当只有一次真实操作，实际：${calls.join(" → ")}`);
  assert.ok(calls[0].startsWith("runJson:io tap"), `应当直接执行 tap，实际：${calls[0]}`);
});

await test("device-action 热路径同样不查设备列表", async () => {
  const { routes, calls } = latencyHarness();
  routes.client.runJson = async (args) => { calls.push(`runJson:${args.join(" ")}`); return {}; };
  const { req, res } = latencyReqRes({ action: "home" });
  await routes.handle("device-action", req, res);
  assert.equal(
    calls.filter((c) => c === "listDevices").length,
    0,
    "device-action 也不该查设备列表",
  );
});

await test("没有选中设备时仍然 409（去掉预检查不能连带丢掉这个判断）", async () => {
  const { routes } = latencyHarness();
  routes.activeDeviceId = null;
  const { req, res } = latencyReqRes({ action: "tap", x: 1, y: 2 });
  await routes.handle("control", req, res);
  assert.equal(res.statusCode, 409, "没选设备必须拒绝，而不是把 null 当 deviceId 传下去");
  assert.match(res.body, /尚未选择设备/u);
});

// ── Android 工具链（adb）体检 ───────────────────────────────────────────
//
// 这一组测试守着一个很具体的坑：**adb 缺失时 mobilecli 不报错**。
// 实测它会安静地返回 {"status":"ok","data":{"devices":[]}}、exit code 0，
// 于是"没装 adb"和"没插手机"在返回值上完全一样。插件必须能自己分辨。

console.log("\nAndroid 工具链（adb）");

const { findAdb, parseAdbDevices, describeAdbProblem, probeAdb, AdbProbe } =
  await import("./lib/device/android-toolchain.js");

await test("parseAdbDevices 解析真实输出（含 -l 的 key:value）", () => {
  const out = [
    "List of devices attached",
    "77b8cf49               device product:haotian model:2410DPN6CC transport_id:1",
    "emulator-5554          offline",
    "ABC123                 unauthorized usb:1-1",
    "",
  ].join("\r\n");

  const devices = parseAdbDevices(out);
  assert.equal(devices.length, 3);
  assert.equal(devices[0].serial, "77b8cf49");
  assert.equal(devices[0].state, "device");
  assert.equal(devices[0].model, "2410DPN6CC");
  assert.equal(devices[1].state, "offline");
  assert.equal(devices[2].state, "unauthorized");
});

await test("parseAdbDevices 忽略表头与 daemon 提示行", () => {
  const out = [
    "* daemon not running; starting now at tcp:5037",
    "* daemon started successfully",
    "List of devices attached",
    "",
  ].join("\n");
  assert.equal(parseAdbDevices(out).length, 0);
});

await test("parseAdbDevices 对空/非字符串输入不炸", () => {
  assert.equal(parseAdbDevices("").length, 0);
  assert.equal(parseAdbDevices(null).length, 0);
  assert.equal(parseAdbDevices(undefined).length, 0);
});

await test("findAdb 从 ANDROID_HOME 推出 platform-tools 路径", () => {
  const fakeHome = join(tmpdir(), "dsh-adb-test-sdk");
  const platformTools = join(fakeHome, "platform-tools");
  const exe = process.platform === "win32" ? "adb.exe" : "adb";

  mkdirSync(platformTools, { recursive: true });
  writeFileSync(join(platformTools, exe), "");

  try {
    // PATH 空 → 只能靠 ANDROID_HOME
    assert.equal(findAdb({ PATH: "", ANDROID_HOME: fakeHome }), join(platformTools, exe));
    // ANDROID_SDK_ROOT 是等价的备用变量
    assert.equal(findAdb({ PATH: "", ANDROID_SDK_ROOT: fakeHome }), join(platformTools, exe));
    // 容忍 ANDROID_HOME 被直接指到 platform-tools 本身
    assert.equal(findAdb({ PATH: "", ANDROID_HOME: platformTools }), join(platformTools, exe));
    // 都没有 → null
    assert.equal(findAdb({ PATH: "" }), null);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

await test("describeAdbProblem 把每种失败都翻成可照做的提示", () => {
  const notFound = describeAdbProblem({ reason: "adb-not-found", path: null });
  assert.equal(notFound.code, "ADB_NOT_FOUND");
  assert.ok(notFound.hint.includes("platform-tools"), "应指向 platform-tools 下载");
  // 必须点明 daemon 会缓存旧环境 —— 否则用户装完 adb 仍然看不到设备
  assert.ok(notFound.hint.includes("daemon stop"), "应提示重启 daemon");

  const unauthorized = describeAdbProblem({ reason: "unauthorized", path: "adb" });
  assert.equal(unauthorized.code, "ADB_UNAUTHORIZED");
  assert.ok(unauthorized.hint.includes("允许"), "应告诉用户去手机上点允许");

  const offline = describeAdbProblem({ reason: "offline", path: "adb" });
  assert.equal(offline.code, "ADB_OFFLINE");

  const noDevice = describeAdbProblem({ reason: "no-device", path: "adb" });
  assert.equal(noDevice.code, "ADB_NO_DEVICE");

  const failed = describeAdbProblem({ reason: "adb-failed", path: "adb", error: "boom" });
  assert.equal(failed.code, "ADB_FAILED");
  assert.ok(failed.message.includes("boom"), "应带上原始错误");

  // ok 时不该产生噪音文案
  const ok = describeAdbProblem({ reason: "ok", path: "adb" });
  assert.equal(ok.code, "OK");
  assert.equal(ok.message, "");
});

await test("probeAdb：找不到 adb 时明确报 adb-not-found（不假装没设备）", async () => {
  // PATH 与 ANDROID_HOME 都清空 → 一定找不到
  const saved = { PATH: process.env.PATH, ANDROID_HOME: process.env.ANDROID_HOME };
  try {
    const probe = await probeAdb({ env: { PATH: "", ANDROID_HOME: "", ANDROID_SDK_ROOT: "" } });
    assert.equal(probe.available, false);
    // 可能是 adb-not-found（机器上真没有），也可能是 adb-not-in-env
    // （装在常见位置但当前环境没配）—— 两者都必须**不是**"没有设备"
    assert.ok(
      probe.reason === "adb-not-found" || probe.reason === "adb-not-in-env",
      `reason 应是 adb 层面的结论，实际：${probe.reason}`,
    );
    assert.equal(probe.usable, 0);
  } finally {
    if (saved.PATH !== undefined) process.env.PATH = saved.PATH;
    if (saved.ANDROID_HOME !== undefined) process.env.ANDROID_HOME = saved.ANDROID_HOME;
  }
});

// 这条守着一个实测踩到的真实场景：adb 装在 D:\Android\platform-tools，
// 用户级 PATH/ANDROID_HOME 都配好了，但 DSH 启动更早 → 进程环境是旧快照。
// 此时若报"未找到 adb，请安装"，就是在让用户去装一个已经装好的东西。
await test("adb 装了但当前进程看不到 → 提示重启 DSH，而不是重装 adb", () => {
  const described = describeAdbProblem({
    reason: "adb-not-in-env",
    path: null,
    installedPath: "D:\\Android\\platform-tools\\adb.exe",
  });
  assert.equal(described.code, "ADB_NOT_IN_ENV");
  assert.ok(described.message.includes("重启"), "应说明是环境快照问题");
  assert.ok(described.hint.includes("重启 DSH"), "首要动作应是重启 DSH");
  assert.ok(!described.hint.includes("下载 https://"), "不该让用户去下载已经装好的东西");
  assert.ok(described.hint.includes("mobilecli daemon stop"), "应连带提醒重启 daemon");
  assert.ok(described.adbPath.includes("adb.exe"), "应回传找到的路径");
});

await test("findAdbOutsideEnv：能从常见安装位置找到 adb（不依赖 PATH）", async () => {
  const { findAdbOutsideEnv } = await import("./lib/device/android-toolchain.js");
  // 造一个"常见位置"，确认它真的会被查到
  const fakeDrive = join(tmpdir(), "adb-outside");
  const target = join(fakeDrive, "Android", "platform-tools");
  mkdirSync(target, { recursive: true });
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  writeFileSync(join(target, exe), "");
  try {
    // 这个函数只认硬编码的盘符/约定路径，tmpdir 不在其中，
    // 所以这里断言的是"不会误报" —— 真正的覆盖由上面的 describeAdbProblem 测试保证
    const found = findAdbOutsideEnv({ PATH: "" });
    assert.ok(found === null || typeof found === "string");
  } finally {
    rmSync(fakeDrive, { recursive: true, force: true });
  }
});

await test("AdbProbe：短时间内的重复查询命中缓存，invalidate 能清掉", async () => {
  const probe = new AdbProbe();

  const first = await probe.get();
  const second = await probe.get();
  // 同一个对象（命中缓存）而不是重新体检一次
  assert.equal(first, second, "第二次应命中缓存，返回同一个结果对象");

  probe.invalidate();
  const third = await probe.get();
  assert.equal(typeof third.reason, "string", "invalidate 后应能重新体检出结果");
  assert.notEqual(third, first, "invalidate 后应是新对象");
});

// ── 技能注册 ────────────────────────────────────────────────────────────
//
// 打包上游的 mobilecli playbook，所以 frontmatter 剥离必须正确：
// 它是 Claude Code 的约定，混进正文会被当作内容喂给模型。

console.log("\n技能注册");

const { parseFrontmatter, loadBundledSkill } = await import("./lib/agent/skills.js");

await test("frontmatter 解析：标量 + 折叠块 + 正文切分", () => {
  const { attributes, body } = parseFrontmatter(
    "---\nname: t\ndescription: >-\n  a long\n  folded desc\nallowed-tools: Bash(x)\n---\n# Body\nhi",
  );
  assert.equal(attributes.name, "t");
  assert.equal(attributes.description, "a long folded desc", "折叠块应拼成一行");
  assert.equal(attributes["allowed-tools"], "Bash(x)");
  assert.ok(body.startsWith("# Body"), "正文应从分隔符之后开始");
});

await test("无 frontmatter 时原样返回", () => {
  const { attributes, body } = parseFrontmatter("# Just markdown");
  assert.deepEqual(attributes, {});
  assert.equal(body, "# Just markdown");
});

await test("未闭合的 frontmatter 不吞掉正文", () => {
  const { body } = parseFrontmatter("---\nname: x\n# no closing");
  assert.ok(body.includes("# no closing"), "找不到结束符时应原样返回");
});

const bundled = loadBundledSkill();

await test("加载打包的 skill 成功", () => {
  assert.ok(bundled !== null, "应能读到 skills/mobilecli/SKILL.md");
  assert.equal(typeof bundled.content, "string");
  assert.ok(bundled.content.length > 5000, `正文过短：${bundled.content.length}`);
});

await test("skill name 符合 DSH 的命名规则", () => {
  // DSH: SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  assert.match(bundled.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});

await test("description 非空（DSH 会拒绝空描述）", () => {
  assert.ok(typeof bundled.description === "string" && bundled.description.length > 0);
});

await test("正文里没有 frontmatter 残留", () => {
  assert.ok(!bundled.content.includes("allowed-tools"), "frontmatter 字段泄漏进正文");
  assert.ok(!bundled.content.startsWith("---"), "正文不该以分隔符开头");
});

await test("reference.md 作为附录并入正文", () => {
  assert.ok(bundled.content.includes("命令速查"), "缺少 reference 附录");
});

// ── 客户端 tab 注册 ────────────────────────────────────────────────────
//
// 锁住的是"面板装了但找不到入口"这个 bug：本插件的 tab 是**页类型**
// （不声明 patterns，不认领任何 dsh-resource:// 地址），所以它只能被显式打开；
// 而显式打开的唯一用户可达路径，是右栏「开始」页上的 guide 入口胶囊。
// guide 一丢，tab 仍然注册成功、仍然能渲染——只是没人能打开它。
// 这里用桩 loader 把 client.js 求值一遍，直接检查注册出去的定义。

console.log("\n客户端 tab 注册");

/**
 * 在桩环境里求值 lib/client.js，返回它注册出去的东西。
 *
 * client.js 是经典脚本（走 window.__ModuleLoader__，不能用 import 求值），
 * 所以这里手工搭一个最小的 window + ctx 替身。
 *
 * @param {{commandTarget?: () => object|undefined}} [options]
 *   commandTarget 决定「有没有会话」——用来覆盖快捷键的 blocked / handled 两条分支。
 * @returns {{types: object[], slots: object[], shortcuts: object[], opened: object[], id: string}}
 */
async function loadClientRegistrations(options = {}) {
  let loaded = null;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
  // 查询参数让 ESM 缓存失效，避免和别的用例互相干扰
  await import(`./lib/client.js?t=${Date.now()}`);
  if (loaded === null) throw new Error("client.js 没有调用 __ModuleLoader__.load");

  const plugin = loaded.factory((spec) => {
    if (spec === "react") {
      // 极简 createElement 替身：保留 type/props/children，够断言 SVG 契约
      return {
        createElement: (type, props, ...children) => ({
          type,
          props: { ...(props ?? {}), children },
        }),
      };
    }
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
      // primitives 是平台 seed 模块（web shell 的 staticModules），永远可 require。
      // 测试里桩成透明透传组件：只保留 props，便于断言调用方传了什么。
      const passthrough = (name) => {
        const Component = (props) =>
          ({ type: name, props: { ...(props ?? {}) } });
        Component.displayName = name;
        return Component;
      };
      return { Button: passthrough("Button"), Tooltip: passthrough("Tooltip"), Input: passthrough("Input") };
    }
    throw new Error(`require 了没注入的模块：${spec}`);
  });

  const types = [];
  const slots = [];
  const shortcuts = [];
  const opened = [];
  const ctx = {
    effect: (fn) => fn(),
    // 可选注入：回调立即执行，桩出 shortcuts / sidebarRight
    inject: (_names, cb) => cb(ctx),
    sidebarRightTabs: { register: (def) => { types.push(def); return () => {}; } },
    slots: { register: (def) => { slots.push(def); return () => {}; } },
    shortcuts: { register: (def) => { shortcuts.push(def); return () => {}; } },
    sidebarRight: {
      commandTarget: options.commandTarget ?? (() => ({ sessionId: "s1", paneId: "p1", host: "dock" })),
      openTabFromTarget: (kind, target) => opened.push({ kind, target }),
    },
  };
  plugin.apply(ctx);
  // plugin 本身也带出去：自适应取流的判定是纯函数（plugin.__test），
  // 直接喂时间戳比渲染真实 React 面板驱动 600ms/5s 时间线可靠得多。
  return { types, slots, shortcuts, opened, id: loaded.id, plugin };
}

const client = await loadClientRegistrations();
const mobileType = client.types.find((t) => t.kind === "mobile");

await test("注册了 kind=mobile 的 tab 类型与正文 slot", () => {
  assert.ok(mobileType !== undefined, "没有注册 kind=mobile 的类型");
  assert.ok(
    client.slots.some((s) => s.name === "sidebar.right.pane.tab" && s.key === mobileType.id),
    "正文 slot 的 key 必须等于类型 id，否则 tab 打开是空白",
  );
});

await test("tab 类型带 guide 入口（否则用户找不到面板）", () => {
  assert.ok(Array.isArray(mobileType.guide), "页类型没有 guide 入口就永远打不开");
  assert.equal(mobileType.guide.length, 1);

  const entry = mobileType.guide[0];
  assert.ok(entry.id, "入口缺 id");
  assert.equal(typeof entry.order, "number", "入口缺 order，排序会不稳定");
  assert.equal(typeof entry.title, "function", "title 必须是函数（随语言变化）");
  assert.ok(entry.title().length > 0, "入口标题不能为空");
  assert.equal(
    new Set(mobileType.guide.map((e) => e.id)).size,
    mobileType.guide.length,
    "guide 入口 id 必须唯一，重复会被 registry 抛错",
  );
});

await test("注册了 tab 标签 slot（否则标签上没有图标）", () => {
  const title = client.slots.find((s) => s.name === "sidebar.right.pane.tab.title");
  assert.ok(title !== undefined, "没注册 sidebar.right.pane.tab.title，标签只有纯文字");
  assert.equal(title.key, mobileType.id, "标题 slot 的 key 必须等于类型 id");
});

// ── 面板外观 ────────────────────────────────────────────────────────────
//
// 这一段锁的是用户直接看到、且改样式时最容易改坏的东西：
// 按钮尺寸、下拉内边距对称、标签图标不重复加间距。

console.log("\n面板外观");

/**
 * 面板样式文本。
 *
 * ⚠️ 直接读 `src/client/styles.css`，**不要**再去 `lib/client.js` 里抠模板：
 * 样式已经拆成独立文件，构建时被内联成**一个 JSON 字符串**（单行）。
 * 从产物里正则抠 CSS 既脆又难读，而断言的本来就是"样式写了什么"，
 * 源文件才是它该待的地方。
 */
function panelCss() {
  return readFileSync(new URL("./src/client/styles.css", import.meta.url), "utf8");
}

await test("工具栏按钮用官方 Button（28px），而不是自绘的 26px 小方块", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  // 官方 Button 的 sm 规格是 height 28；自绘要自己写高度，很容易写成 26
  assert.ok(source.includes('size: "sm"'), "工具栏未使用官方 Button 的 sm 尺寸");
  assert.ok(
    source.includes('variant: "ghost"'),
    "ghost 变体提供 hover 填充；缺它按钮看起来不像按钮",
  );
  // 旧的 mbm-btn 自绘样式必须已经删干净
  assert.ok(!source.includes("mbm-btn"), "残留了旧的 mbm-btn 自绘按钮样式");
  assert.ok(!/\.mbm-btn\s*\{/u.test(source), "残留了 .mbm-btn 规则");
});

// ── canvas 尺寸：必须由「帧的宽高比」决定 ──────────────────────────────
//
// 这一段锁的是一个把画面压成**横向小条**的真实 bug（真机截图确认）。
//
// <canvas> 没设 CSS 尺寸时默认 300×150（宽高比 2.0）。`.mbm-media` 只有
// max-width/max-height，元素就按这个内在尺寸排版。若尺寸函数去读
// canvas 自己的 getBoundingClientRect，就形成循环依赖：
//
//   读到 300×150 → 后备存储设成 600×300 → 显示仍是 300×150（max-* 之下不变）
//   → 自洽地卡在 2.0，与设备的 1080×2376（0.45）毫无关系
//
// 实测：连续 6 帧都停在 330×165（2.0），而正确值应是 ~318×700（0.45）。
//
// 所以尺寸必须由**帧的真实宽高比** + **父容器可用空间**推出。

console.log("\ncanvas 尺寸");

await test("尺寸从帧的宽高比推出，而不是读 canvas 自己的矩形（防反馈环）", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  const fit = source.match(/function fitCanvasToFrame\([\s\S]*?\n    \}/u)?.[0] ?? "";
  assert.ok(fit.length > 0, "找不到 fitCanvasToFrame");

  // 必须用传入的帧尺寸算宽高比（contain：两轴都要参与，取较小的缩放比）
  assert.ok(/frameWidth/u.test(fit) && /frameHeight/u.test(fit), "未使用帧尺寸");
  assert.ok(/availWidth \/ frameWidth/u.test(fit), "没有按 frameWidth 做 contain");
  assert.ok(/availHeight \/ frameHeight/u.test(fit), "没有按 frameHeight 做 contain");
  assert.ok(/Math\.min\(/u.test(fit), "contain 必须取两轴缩放比的较小值");

  // ★ 核心断言：不能读 canvas 自己的 getBoundingClientRect 来定尺寸
  assert.ok(
    !fit.includes("canvas.getBoundingClientRect"),
    "读了 canvas 自己的矩形 —— 那正是把画面压成横条的反馈环",
  );
  // 可用空间应取自父容器
  assert.ok(/parentElement/u.test(fit), "可用空间应取自父容器（.mbm-stage）");
  // 两个尺寸都要写：CSS 决定显示多大，后备存储决定画多少像素
  assert.ok(/canvas\.style\.width/u.test(fit), "没有写 CSS 尺寸 → 元素仍按 300×150 排版");
  assert.ok(/canvas\.width = /u.test(fit), "没有写后备存储");
});

await test("媒体元素是 flex:none（否则 flex 容器会拉伸它、宽高比又丢）", () => {
  const css = panelCss();
  const rule = css.match(/\.mbm-media\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.ok(rule.includes("flex: none"), `媒体元素必须 flex:none：${rule}`);
  assert.ok(rule.includes("max-width: 100%"), "应保留 max-* 作为 JS 未跑到时的兜底");
});

await test("绘制时按帧尺寸设 canvas（而不是复用传入的旧尺寸）", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  // 调用点必须把 frame.displayWidth/Height 传进去
  assert.ok(
    /fitCanvasToFrame\(canvas,\s*frame\.displayWidth,\s*frame\.displayHeight\)/u.test(source),
    "调用点没有传真实帧尺寸",
  );
  // 旧的 syncCanvasSize 应已删除
  assert.ok(!source.includes("syncCanvasSize"), "残留了旧的 syncCanvasSize");
});

await test("设备下拉：关掉原生箭头并自绘，左右内边距才对称", () => {
  const css = panelCss();
  // 原生箭头会吃掉右侧内边距（左 8 / 右 0），必须 appearance:none
  assert.ok(
    /\.mbm-select\s*\{[^}]*appearance:\s*none/u.test(css),
    "未关掉原生 select 箭头，右侧内边距会不对称",
  );
  // 关掉原生箭头后必须自己画一个，否则没有可点的提示
  assert.ok(css.includes(".mbm-selectCaret"), "关掉了原生箭头却没有自绘箭头");
  assert.ok(/\.mbm-selectWrap\s*\{[^}]*position:\s*relative/u.test(css), "自绘箭头需要定位上下文");
  // 右侧 padding 要留出箭头的位置
  const padding = css.match(/\.mbm-select\s*\{[^}]*padding:\s*([^;]+);/u)?.[1] ?? "";
  assert.ok(padding.length > 0, "下拉框没有 padding");
  const [top, right, bottom, left] = padding.split(/\s+/u);
  assert.equal(top, bottom, `上下内边距应相等：${padding}`);
  assert.notEqual(right, "0", `右侧必须给箭头留位：${padding}`);
  assert.equal(left, "8px", `左侧内边距应为 8px：${padding}`);
});

await test("标签图标不再自带 margin（dockkit 已给 gap:5px）", () => {
  const css = panelCss();
  const rule = css.match(/\.mbm-title-icon\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.ok(rule.includes("flex: none"), "标签图标必须 flex:none，否则标题长时被压扁");
  assert.ok(
    !rule.includes("margin-right"),
    "dockkit 的 .tabTitle 已有 gap:5px，再加 margin-right 会变成 9px（官方「文件」是 5px）",
  );
});

// ── 仿真整机外壳（device 档）───────────────────────────────────────────
//
// 用户的原话是"像模拟器那样一眼看出这是一台手机"。外壳是纯 DOM + CSS
// （不引入图片/字体），所以最容易在后续重构里"顺手"掉的就是那几颗装饰节点。
// 这里同时锁三件事：外壳真的渲染、尺寸自洽（不会被 stage 裁掉）、
// 装饰件绝不参与指针坐标换算。

await test("device 档把画面包进仿真机身：外壳 + 三颗侧键 + 前置开孔", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  assert.ok(source.includes('className: "mbm-chassis"'), "device 档没有渲染 .mbm-chassis 外壳");
  assert.ok(
    source.includes('"data-device-kind": deviceKind'),
    "外壳没把平台下传：iOS 灵动岛 / Android 挖孔没法区分",
  );
  for (const side of ["power", "volumeUp", "volumeDown"]) {
    assert.ok(source.includes(`"data-side": "${side}"`), `缺少 ${side} 侧键`);
  }
  assert.ok(source.includes('className: "mbm-island"'), "缺少 iOS 灵动岛节点");
  assert.ok(source.includes('className: "mbm-punch"'), "缺少 Android 挖孔节点");
});

await test("机身内边距与 CHASSIS_INSET 一致（否则画布窄 2px 或侧键被裁）", () => {
  const css = panelCss();
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  const rule = css.match(/\.mbm-stage\[data-frame="device"\]\s+\.mbm-chassis\s*\{([^}]*)\}/u)?.[1] ?? "";
  assert.ok(
    rule.includes("display: inline-flex"),
    "机身必须 shrink-wrap（inline-flex）：自己撑满 stage 的话，画布可用空间就算不准",
  );
  assert.ok(rule.includes("flex: none"), "机身必须 flex:none，否则会被 stage 压扁");
  assert.ok(rule.includes("position: relative"), "侧键/开孔靠绝对定位挂在机身上");
  assert.ok(rule.includes("var(--mbm-device-radius"), "机身圆角要跟随画布宽度（CSS 变量由 JS 写）");
  const padding = Number(rule.match(/padding:\s*(\d+)px/u)?.[1] ?? NaN);
  const border = Number(rule.match(/border:\s*(\d+)px/u)?.[1] ?? NaN);
  const inset = Number(source.match(/const CHASSIS_INSET = (\d+)/u)?.[1] ?? NaN);
  assert.ok(Number.isFinite(padding) && Number.isFinite(border), `机身缺 padding/border：${rule}`);
  assert.equal(
    padding + border,
    inset,
    `CHASSIS_INSET(${inset}) 必须 = 机身 padding(${padding}) + 描边(${border})：` +
      "对不上时画布会比可用空间窄（浪费清晰度），或侧键伸出 stage 被 overflow:hidden 切掉",
  );
});

await test("侧键与开孔是纯装饰：不挡指针、不改 canvas 的坐标基准", () => {
  const css = panelCss();
  assert.ok(
    /\.mbm-sideKey,\s*\.mbm-island,\s*\.mbm-punch\s*\{\s*display:\s*none/u.test(css),
    "装饰件默认必须隐藏：bezel / frameless 两档要保持原样",
  );
  // 只给"真正生成盒子"的规则（display:block / position:absolute）要求
  // pointer-events:none；纯位置微调规则（right:-2px 之类）继承基础规则即可，
  // ::after 这种伪元素本身不参与命中测试，也不需要再写一遍。
  for (const m of css.matchAll(/\.mbm-(?:sideKey|island|punch)[^{]*\{([^}]*)\}/gu)) {
    if (m[0].includes("::")) continue;
    if (!/display:\s*block|position:\s*absolute/u.test(m[1])) continue;
    assert.ok(
      m[1].includes("pointer-events: none"),
      `装饰件必须 pointer-events:none，否则会截走画布上的点击/滑动：${m[1]}`,
    );
  }
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  assert.ok(
    source.includes("element.getBoundingClientRect()"),
    "指针坐标必须仍以媒体元素自己的矩形换算 —— 外面包一层机身不能改变这个基准",
  );
});

await test("默认外观就是整机；开孔按平台切换，三档仍然都在", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  assert.ok(
    source.includes('useState("device")'),
    "默认外观必须是整机：用户要的就是打开面板第一眼看出这是一台手机",
  );
  const css = panelCss();
  assert.ok(
    css.includes('.mbm-chassis[data-device-kind="ios"] .mbm-island'),
    "缺 iOS 灵动岛规则",
  );
  assert.ok(
    css.includes('.mbm-chassis[data-device-kind="android"] .mbm-punch'),
    "缺 Android 挖孔规则",
  );
  // frameless 必须仍是"完全无边框无背景"，不能被外壳样式带歪
  assert.ok(
    /\.mbm-stage\[data-frame="frameless"\]\s*\{[^}]*border:\s*none[^}]*background:\s*transparent/u.test(css),
    "frameless 档必须保持无边框无背景",
  );
});

await test("工具栏按钮走官方 Tooltip，且每个都有可读的 aria-label", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  // 本文件不用 JSX，走 h(Tooltip, ...) 工厂
  assert.ok(/\bh\(\s*Tooltip\b/u.test(source), "工具栏按钮没有 Tooltip");
  assert.ok(source.includes('"aria-label": label'), "图标按钮必须有 aria-label，否则读屏只剩空按钮");
});

await test("guide 入口是第 5 个胶囊 —— 副标题消失是预期行为，不是 bug", () => {
  // DSH 的「开始」页：const MAX_DESCRIBED_ENTRIES = 4;
  //   const described = entries.length <= MAX_DESCRIBED_ENTRIES;
  // 胶囊超过 4 个，上游会关掉**所有**胶囊的副标题（不是只关第 5 个）。
  //
  // 官方 3 个（files 10 / terminal 20 / browser 30）+ dsh-context（20）已经是 4 个，
  // 所以本插件必然是第 5 个 —— 装上后「工作区文件/上下文/新建终端/浏览器」的
  // 副标题会一起消失。那是上游的取舍，插件侧无法只为自己豁免；已确认接受。
  //
  // 这条用例把该事实钉住：以后看到副标题没了，先去改入口位置，
  // 不要当成回归去动 description 或去"修" guide。
  assert.equal(mobileType.guide[0].order, 40, "应排在 dsh-context（20）之后，做第 5 个胶囊");
});

await test("guide 入口会被 registry 绑到 kind=mobile（openTab 才找得到）", () => {
  // 复刻 DSH registry 的 refresh()：guideEntries 由 guide 派生并补上 kind
  const entries = client.types.flatMap((d) =>
    (d.guide ?? []).map((e) => ({ ...e, kind: d.kind })),
  );
  const mine = entries.find((e) => e.kind === "mobile");
  assert.ok(mine !== undefined, "registry 派生出的入口里没有 mobile");
  assert.equal(mine.title(), "移动设备");
});

await test("guide 入口带 icon，且尺寸/颜色契约与官方 artwork 一致", () => {
  const icon = mobileType.guide[0].icon;
  assert.equal(typeof icon, "function", "入口缺 icon，胶囊会退回灰色立方体占位图");

  // 官方 artwork 契约：收 { size, className }，默认 36，viewBox 0 0 36 36，aria-hidden
  const tree = icon({ size: 26, className: "x" });
  assert.equal(tree.props.width, 26, "size 必须透传到 width（guide 传 26 或 22）");
  assert.equal(tree.props.height, 26);
  assert.equal(tree.props.viewBox, "0 0 36 36", "viewBox 必须与官方 artwork 一致");
  assert.equal(tree.props["aria-hidden"], "true", "纯装饰图标必须对读屏隐藏");

  // 颜色要跟「浏览器」胶囊一致：官方 artwork 用固定色 #539CFA，不是 currentColor
  const strokes = [];
  const collect = (node) => {
    if (node === null || typeof node !== "object") return;
    if (node.props?.stroke !== undefined) strokes.push(node.props.stroke);
    for (const child of [].concat(node.props?.children ?? [])) collect(child);
  };
  collect(tree);
  assert.ok(strokes.length > 0, "图标没有任何描边");
  assert.ok(
    strokes.every((s) => s === "#539CFA"),
    `描边色应统一为浏览器胶囊的 #539CFA，实际：${strokes.join(", ")}`,
  );

  // 描边宽度按场合归一：官方 guide artwork 是 2/36，官方 tab 图标是 1/16。
  // 断言的是「有效描边」而非某个写死的数，这样改 viewBox 也不会假绿。
  const widths = [];
  const collectW = (node) => {
    if (node === null || typeof node !== "object") return;
    if (node.props?.strokeWidth !== undefined) widths.push(node.props.strokeWidth);
    for (const child of [].concat(node.props?.children ?? [])) collectW(child);
  };
  collectW(tree);
  assert.ok(widths.length > 0, "图标没有描边宽度");
  // guide 场合：26px 显示下应约等于官方 guide artwork 的观感（2/36 * 26 ≈ 1.44px）
  const guideEffective = (widths[0] * 26) / 36;
  assert.ok(
    Math.abs(guideEffective - (2 / 36) * 26) < 0.01,
    `guide 场合有效描边应约为 1.44px，实际 ${guideEffective.toFixed(2)}px`,
  );
});

await test("图标填充比例分两套：guide 56%、标签 76%（否则标签里小一圈）", () => {
  const icon = mobileType.guide[0].icon;
  const bodyBox = (tree) => {
    const rect = tree.props.children.find((c) => c?.type === "rect");
    return { height: rect.props.height, min: rect.props.y, max: rect.props.y + rect.props.height };
  };

  // 官方 guide artwork（GuideArtworkBrowser）：圆形占 viewBox 的 56.4%
  const guide = bodyBox(icon({ size: 26 }));
  const guideFill = guide.height / 36;
  assert.ok(
    Math.abs(guideFill - 0.564) < 0.01,
    `guide 填充比例应约 56.4%，实际 ${(guideFill * 100).toFixed(1)}%`,
  );

  // 官方 tab 图标（IconGlobeOutlineRegular）：占 76.1%。
  // 少了 dense，16px 下只画 9px，而旁边的文件夹/地球是 12.2px —— 肉眼可见小一圈。
  const tab = bodyBox(icon({ size: 16, dense: true }));
  const tabFill = tab.height / 36;
  assert.ok(
    Math.abs(tabFill - 0.761) < 0.01,
    `标签填充比例应约 76.1%（对齐官方 tab 图标），实际 ${(tabFill * 100).toFixed(1)}%`,
  );

  // 关键：16px 下标签图标的实际绘制高度要接近官方的 12.18px
  const rendered = (tab.height / 36) * 16;
  assert.ok(
    rendered > 11.8 && rendered < 12.6,
    `标签图标应渲染约 12.2px（官方 globe 尺寸），实际 ${rendered.toFixed(1)}px`,
  );

  // 两者都必须垂直居中
  for (const [name, box] of [["guide", guide], ["tab", tab]]) {
    const center = (box.min + box.max) / 2;
    assert.ok(Math.abs(center - 18) < 0.01, `${name} 未垂直居中：中心 ${center}`);
  }
});

await test("图标 color 可覆盖：胶囊用固定蓝，标签行用 currentColor", () => {
  const icon = mobileType.guide[0].icon;
  const walk = (node, sink) => {
    if (node === null || typeof node !== "object") return;
    if (node.props?.stroke !== undefined) sink.push(node.props.stroke);
    for (const c of [].concat(node.props?.children ?? [])) walk(c, sink);
  };

  // 默认（guide 胶囊）：固定蓝 —— 官方两幅 artwork 都是固定色
  const guideStrokes = [];
  walk(icon({ size: 26 }), guideStrokes);
  assert.ok(guideStrokes.every((s) => s === "#539CFA"), "guide 里应是固定蓝");

  // 标签行：currentColor —— 官方 tab 图标（IconGlobeOutlineRegular）都用它，
  // 否则暗色主题下固定蓝会突兀
  const tabStrokes = [];
  walk(icon({ size: 16, color: "currentColor" }), tabStrokes);
  assert.ok(tabStrokes.length > 0, "标签图标没有描边");
  assert.ok(
    tabStrokes.every((s) => s === "currentColor"),
    `标签行应传 currentColor 跟随前景色，实际：${tabStrokes.join(", ")}`,
  );
});

await test("快捷键已注册，且 guide 的 commandId 与之逐字一致", () => {
  // commandId 对不上 → 胶囊右侧的快捷键徽标不显示（官方 files/browser 同样机制）
  assert.equal(client.shortcuts.length, 1, "应恰好注册一条快捷键");
  const sc = client.shortcuts[0];
  assert.equal(
    mobileType.guide[0].commandId,
    sc.id,
    "guide.commandId 必须等于 shortcuts.register 的 id，否则徽标不显示",
  );
  // DSH 的 commandPattern：点分两段，重复 id 会 throw
  assert.match(sc.id, /^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+$/u);
});

await test("快捷键覆盖桌面与浏览器，且避开被占用的组合", () => {
  const sc = client.shortcuts[0];
  for (const profile of [
    "desktop:macos", "desktop:windows", "desktop:linux",
    "web:macos", "web:windows",
  ]) {
    assert.ok(sc.defaults[profile] !== undefined, `缺 ${profile} 的默认键`);
  }

  // DSH 自带 8 条绑定的 web:macos 组合（实测扫描 asar 得出），不能撞上
  const takenWeb = new Set([
    "alt+primary+Comma", "alt+primary+KeyB", "alt+primary+KeyP", "alt+primary+KeyT",
    "control+Backquote", "primary+shift+KeyB", "primary+shift+KeyO", "primary+Slash",
  ]);
  const webMac = sc.defaults["web:macos"];
  const key = [...webMac.modifiers].sort().join("+") + "+" + webMac.code;
  assert.ok(!takenWeb.has(key), `web:macos 的 ${key} 已被官方占用`);

  // 桌面端不能只用 ⌘M：macOS 的 windowMenu 把 ⌘M 绑给了「最小化」，
  // 原生菜单会先吃掉这个键。至少要两段修饰键。
  for (const profile of ["desktop:macos", "desktop:windows", "desktop:linux"]) {
    assert.ok(
      sc.defaults[profile].modifiers.length >= 2,
      `${profile} 必须至少两个修饰键（⌘M 被系统「最小化」占用）`,
    );
  }
});

await test("快捷键无会话时 blocked（带可读原因，而不是静默无反应）", async () => {
  const noSession = await loadClientRegistrations({ commandTarget: () => undefined });
  const blocked = noSession.shortcuts[0].resolve({ target: null });
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.reason.length > 0, "blocked 必须带原因，否则用户不知道为什么没反应");
});

await test("有会话时 resolve 返回 handled，且 run() 按 kind=mobile 打开", () => {
  const handled = client.shortcuts[0].resolve({ target: null });
  assert.equal(handled.status, "handled");
  assert.equal(typeof handled.run, "function", "handled 必须带 run，否则按键没反应");

  handled.run();
  assert.equal(client.opened.length, 1, "run() 应恰好打开一次");
  assert.equal(client.opened[0].kind, "mobile", "必须按 kind=mobile 打开");
});

// ── H.264 码流解析 ──────────────────────────────────────────────────────
//
// 这一段锁的是一个**真机上踩到过的黑屏 bug**：
// codecStringFromSps 忘了跳过起始码，从 `nal[1..3]` 读到的是 00 00 01，
// 于是算出 "avc1.000001"。Chrome 判为 "Unknown or ambiguous codec name."，
// 异步把解码器置为 closed，之后每次 decode() 都抛
// "Cannot call 'decode' on a closed codec" —— 画面全黑。
//
// 注意：这个函数从 client.js **源码里抽出来**求值，不是手抄一份副本，
// 否则测试会和出货代码漂移（这正是原 bug 没被测出来的原因）。

console.log("\nH.264 码流解析");

/** 从 client.js 源码里抽出一个具名函数（含函数体），用于独立测试。 */
function extractFunction(name) {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`client.js 里找不到函数 ${name}`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") { depth += 1; seen = true; }
    else if (source[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配对`);
}

/**
 * 去掉 JS 源码里的注释（行注释与块注释）。
 *
 * ⚠️ 为什么需要它：这个项目里注释写得很多，而且**注释里经常引用真实代码**
 * （例如解释某个属性为什么必须存在时会把 `keepMounted: true` 原样写进注释）。
 * 于是"断言某段代码存在"的测试会被注释骗过去 —— 删掉真代码，测试照样通过。
 * 断言源码前先剥注释，才能测到真正生效的那份。
 *
 * 不处理字符串里的 `//`（会把 URL 里的 `//` 误当注释）——所以先保护字符串。
 *
 * @param {string} source
 * @returns {string} 剥掉注释后的源码
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // 字符串 / 模板串：原样搬过去（含里面的 // 和 /*）
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") { out += source[i] + (source[i + 1] ?? ""); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }

    // 行注释
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    // 块注释
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** 把抽出来的函数包成可调用的形式。 */
function loadCodecHelpers() {
  const body = ["codecStringFromSps", "nalType", "concatBytes"]
    .map(extractFunction)
    .join("\n");
  return new Function(`${body}\nreturn { codecStringFromSps, nalType, concatBytes };`)();
}

const { codecStringFromSps, nalType, concatBytes } = loadCodecHelpers();

await test("codecStringFromSps 跳过 4 字节起始码（真机 SPS 回归）", () => {
  // 一加 12 / Android 16 实测抓到的 SPS：
  //   00 00 00 01 | 67 | 64 00 32 | ...
  //   起始码       NAL头  PP  CC  LL
  //   → profile 100 (High), constraint 0, level 50 → avc1.640032
  const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32, 0xac, 0xb4]);
  assert.equal(nalType(sps), 7, "应先认出这是 SPS");
  assert.equal(
    codecStringFromSps(sps),
    "avc1.640032",
    "必须跳过起始码再读 PPCCLL；读到起始码会得到 avc1.000001 并导致解码器 closed",
  );
});

await test("codecStringFromSps 跳过 3 字节起始码", () => {
  const sps = new Uint8Array([0x00, 0x00, 0x01, 0x67, 0x42, 0xE0, 0x1F]);
  assert.equal(nalType(sps), 7);
  // 十六进制大小写在 codec 字符串里等价（实测 Chrome 都接受），本实现统一小写
  assert.equal(codecStringFromSps(sps).toLowerCase(), "avc1.42e01f", "Baseline 3.1");
});

await test("codecStringFromSps 绝不会返回 avc1.000001 这种无效值", () => {
  // 任何合法 SPS 都不该产出 profile=0x00 constraint=0x00 level=0x01
  const samples = [
    [0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32],
    [0x00, 0x00, 0x01, 0x67, 0x4d, 0x40, 0x28],
    [0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e],
  ];
  for (const bytes of samples) {
    const codec = codecStringFromSps(new Uint8Array(bytes));
    assert.notEqual(codec, "avc1.000001", `起始码泄漏进 codec 字符串：${codec}`);
    assert.match(codec, /^avc1\.[0-9a-f]{6}$/u, `codec 字符串形状不对：${codec}`);
    // profile_idc 为 0 在 H.264 里是未定义值
    assert.notEqual(codec.slice(5, 7), "00", `profile_idc 为 0：${codec}`);
  }
});

await test("codecStringFromSps 对短数据回落到保守值而不是崩", () => {
  assert.equal(codecStringFromSps(new Uint8Array([0x00, 0x00, 0x01, 0x67])), "avc1.42E01F");
  assert.equal(codecStringFromSps(new Uint8Array(0)), "avc1.42E01F");
});

await test("concatBytes 按顺序拼接（关键帧自带参数集）", () => {
  // 关键帧必须把 SPS+PPS 拼在自己前面一起喂，实测这是唯一能出画面的喂法
  const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32]);
  const pps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x68, 0xee]);
  const idr = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
  const merged = concatBytes(sps, pps, idr);

  assert.equal(merged.length, sps.length + pps.length + idr.length);
  assert.deepEqual([...merged.slice(0, sps.length)], [...sps], "SPS 应在最前");
  assert.deepEqual(
    [...merged.slice(sps.length, sps.length + pps.length)],
    [...pps],
    "PPS 应紧随其后",
  );
  assert.deepEqual([...merged.slice(sps.length + pps.length)], [...idr], "关键帧应在最后");
  // 每段自带起始码，所以拼起来仍是合法 Annex B：头 4 字节仍是起始码
  assert.deepEqual([...merged.slice(0, 4)], [0, 0, 0, 1]);
});

await test("concatBytes 在 subarray 上工作（真实调用场景）", () => {
  // 真实代码里 sps/pps/unit 都是同一个大 buffer 上的 subarray，不是独立数组
  const big = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32, 0xee]);
  const sps = big.subarray(1, 9);
  const merged = concatBytes(sps, big.subarray(9, 10));
  assert.equal(merged.length, 9);
  assert.deepEqual([...merged], [0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x32, 0xee]);
});

// ── 流会话与多播 ────────────────────────────────────────────────────────
//
// 这一段用假的 spawn 替身，不需要设备。它锁住的是两个真实踩到过的 bug：
//   ① 首块消费者不注销 → consumers.size 永不归零 → 空闲自停永不触发
//   ② 首块转发两次 → 码流里多一个重复 NAL
// 两者都不会报错，只会表现为"设备一直编码"和"画面偶发花屏"，极难定位。

console.log("\n流会话");

const { StreamSession, StreamSessionPool, DEFAULT_SWIPE_DURATION_MS } =
  await import("./lib/stream/session.js");

/** 造一个可控的假流进程。 */
function fakeStream() {
  const listeners = {};
  const child = {
    on: (event, cb) => { (listeners[event] ??= []).push(cb); },
    emit: (event, ...args) => { for (const cb of listeners[event] ?? []) cb(...args); },
  };
  let killed = false;

  const proc = {
    child,
    stdout: {
      on: (event, cb) => { (listeners[`stdout:${event}`] ??= []).push(cb); },
      emit: (event, ...args) => { for (const cb of listeners[`stdout:${event}`] ?? []) cb(...args); },
    },
    stderr: () => "",
    kill: () => { killed = true; child.emit("exit", 0, null); },
  };

  return {
    proc,
    /** 往会话里推一块数据。 */
    push: (buf) => { for (const cb of listeners["stdout:data"] ?? []) cb(buf); },
    /** 模拟进程崩溃（触发 exit）。 */
    kill: () => proc.kill(),
    get killed() { return killed; },
  };
}

await test("首个消费者拉起进程，后续消费者复用同一进程", () => {
  let spawns = 0;
  let current = null;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { spawns += 1; current = fakeStream(); return current.proc; },
    idleStopMs: 100_000,
  });

  session.addConsumer(() => {});
  session.addConsumer(() => {});
  assert.equal(spawns, 1, "不应为每个消费者各起一个进程");
  assert.equal(session.consumers.size, 2);
  session.stop();
});

await test("新消费者会拿到已缓存的首块（否则错过格式）", () => {
  let current = null;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { current = fakeStream(); return current.proc; },
    idleStopMs: 100_000,
  });

  session.addConsumer(() => {});
  const head = Buffer.from([0, 0, 0, 1, 0x67]);
  current.push(head);
  assert.equal(session.format.kind, "h264", "首块应被嗅探");

  const received = [];
  session.addConsumer((c) => received.push(c));
  assert.equal(received.length, 1, "新消费者应立刻收到首块回放");
  assert.deepEqual(received[0], head);
  session.stop();
});

await test("消费者全部退订后必须归零（空闲自停的前提）", () => {
  let current = null;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { current = fakeStream(); return current.proc; },
    idleStopMs: 100_000,
  });

  const a = session.addConsumer(() => {});
  const b = session.addConsumer(() => {});
  assert.equal(session.consumers.size, 2);
  a.remove();
  b.remove();
  // 这条断言就是为了锁住那个 bug：曾经的转发实现留下一个永不注销的消费者
  assert.equal(session.consumers.size, 0, "退订后 consumers 必须归零，否则空闲自停永不触发");
  session.stop();
});

await test("remove 幂等：重复调用不会误减计数", () => {
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => fakeStream().proc,
    idleStopMs: 100_000,
  });
  const a = session.addConsumer(() => {});
  const b = session.addConsumer(() => {});
  a.remove();
  a.remove();
  a.remove();
  assert.equal(session.consumers.size, 1, "重复 remove 不该影响仍在的消费者");
  b.remove();
  assert.equal(session.consumers.size, 0);
  session.stop();
});

await test("进程崩溃后自动重启（还有人订阅时）", async () => {
  let spawns = 0;
  let current = null;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { spawns += 1; current = fakeStream(); return current.proc; },
    idleStopMs: 100_000,
    restartDelayMs: 10,
  });

  session.addConsumer(() => {});
  assert.equal(spawns, 1);
  current.kill(); // 模拟崩溃
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawns, 2, "有消费者时应自动重启");
  session.stop();
});

await test("主动 stop 后不再重启（否则退出事件会把刚停的流拉起来）", async () => {
  let spawns = 0;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { spawns += 1; return fakeStream().proc; },
    idleStopMs: 100_000,
    restartDelayMs: 10,
  });

  session.addConsumer(() => {});
  session.stop();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawns, 1, "主动停止后不该被退出事件重新拉起");
  assert.ok(session.stopped);
});

await test("无消费者时崩溃不重启（等下次订阅）", async () => {
  let spawns = 0;
  let current = null;
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => { spawns += 1; current = fakeStream(); return current.proc; },
    idleStopMs: 100_000,
    restartDelayMs: 10,
  });

  const sub = session.addConsumer(() => {});
  sub.remove();
  current.kill();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawns, 1, "没人看时不该白白重启");
  session.stop();
});

await test("池按 deviceId 复用，stop 后可重新获取", () => {
  let spawns = 0;
  const pool = new StreamSessionPool({
    spawnFor: () => { spawns += 1; return fakeStream().proc; },
    idleStopMs: 100_000,
  });

  const a1 = pool.acquire("dev-1");
  const a2 = pool.acquire("dev-1");
  assert.equal(a1, a2, "同一设备应复用会话");
  const b = pool.acquire("dev-2");
  assert.notEqual(a1, b, "不同设备应各自一条流");

  pool.stop("dev-1");
  const a3 = pool.acquire("dev-1");
  assert.notEqual(a1, a3, "stop 后应能重新获取");
  pool.stopAll();
  assert.equal(pool.sessions.size, 0);
});

await test("停止的会话拒绝新订阅（而不是静默失效）", () => {
  const session = new StreamSession({
    deviceId: "d",
    spawn: () => fakeStream().proc,
    idleStopMs: 100_000,
  });
  session.stop();
  assert.throws(() => session.addConsumer(() => {}), /stopped/);
});

await test("sendInput 拼出的命令形状正确", async () => {
  const session = new StreamSession({
    deviceId: "dev-1",
    spawn: () => fakeStream().proc,
    idleStopMs: 100_000,
  });
  const seen = [];
  const run = async (args) => { seen.push(args); return {}; };

  await session.sendInput(run, { action: "tap", x: 10, y: 20 });
  assert.deepEqual(seen[0], ["io", "tap", "--device", "dev-1", "10,20"]);

  // swipe 必须带 --duration。不传时 mobilecli 用平台默认的 1000ms，
  // 实测每次滑动要 1074ms（传 300 只需 374ms）—— 这是"滑动很慢"的直接原因。
  await session.sendInput(run, { action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.deepEqual(
    seen[1],
    ["io", "swipe", "--device", "dev-1", "1,2,3,4", "--duration", String(DEFAULT_SWIPE_DURATION_MS)],
  );

  // 显式传 duration 时用它自己的值，不要被默认值覆盖
  await session.sendInput(run, { action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, duration: 150 });
  assert.deepEqual(seen[2], ["io", "swipe", "--device", "dev-1", "1,2,3,4", "--duration", "150"]);

  await session.sendInput(run, { action: "longpress", x: 5, y: 6, duration: 800 });
  assert.deepEqual(seen[3], ["io", "longpress", "--device", "dev-1", "5,6", "--duration", "800"]);

  await session.sendInput(run, { action: "button", name: "HOME" });
  assert.deepEqual(seen[4], ["io", "button", "--device", "dev-1", "HOME"]);

  await assert.rejects(() => session.sendInput(run, { action: "nope" }), /不支持的操作/);
  session.stop();
});

// ── 键盘透传 ────────────────────────────────────────────────────────────
//
// 目标：点开设备里的输入框，用电脑键盘打字。手机输入法在侧边栏里没法用。
//
// 实测依据（一加 12 / Android 16，全部验证过）：
//   · `io keys` 真的送达 —— 计算器收到 "7" "8" "9" 后显示 789，再发 "1" "2" "3" 显示 123
//   · 一次可发多个键，耗时与发一个相同（每条命令约 100ms，逐字符发没法用）
//   · 非 ASCII 走 `io text` —— 中文/emoji/日文/韩文/带音标拉丁文都能送达，
//     **不需要 ADBKeyboard**（设备上根本没装，当前输入法是微信键盘）

console.log("\n键盘透传");

await test("keys 传给 mobilecli 的形状正确（一个 --device，多个键）", async () => {
  const session = new StreamSession({
    deviceId: "dev-1",
    spawn: () => fakeStream().proc,
    idleStopMs: 100_000,
  });
  const seen = [];
  const run = async (args) => { seen.push(args); return {}; };

  await session.sendInput(run, { action: "keys", keys: ["h", "e", "l"] });
  assert.deepEqual(
    seen[0],
    ["io", "keys", "--device", "dev-1", "h", "e", "l"],
    "合批的多个键应在同一次调用里，否则每条 100ms 会让打字没法用",
  );

  await session.sendInput(run, { action: "keys", keys: ["ctrl+a"] });
  assert.deepEqual(seen[1], ["io", "keys", "--device", "dev-1", "ctrl+a"]);
  session.stop();
});

await test("keys 白名单：合法按键通过", () => {
  for (const keys of [
    ["a"], ["enter"], ["backspace"], ["space"], ["escape"],
    ["up"], ["down"], ["left"], ["right"], ["home"], ["end"],
    ["shift+a"], ["ctrl+shift+z"], ["cmd+a"], ["alt+tab"],
    ["a", "b", "c"],
  ]) {
    const r = validateInput("keys", { keys });
    assert.equal(r.ok, true, `${JSON.stringify(keys)} 应通过，实际：${r.error}`);
  }
});

await test("keys 白名单：参数注入必须被拒（字符串直接进 argv）", () => {
  // 这些不是"奇怪的按键"，是**安全边界**：按键名直接进子进程 argv，
  // 一个名叫 `--device` 的"按键"会改变命令语义。
  for (const keys of [
    ["--device"], ["--fps"], ["a", "--bitrate"], ["a b"], ["a;b"],
    ["a/b"], ["../x"], [""], ["a\nb"], ["A+B+C+D+E"], ["x".repeat(25)],
  ]) {
    const r = validateInput("keys", { keys });
    assert.equal(r.ok, false, `${JSON.stringify(keys)} 必须被拒，但它通过了`);
  }
});

await test("keys 结构校验：非数组 / 空 / 非字符串 / 超量都要拒", () => {
  assert.equal(validateInput("keys", { keys: "a" }).ok, false);
  assert.equal(validateInput("keys", { keys: [] }).ok, false);
  assert.equal(validateInput("keys", { keys: [1, 2] }).ok, false);
  assert.equal(validateInput("keys", {}).ok, false);
  assert.equal(
    validateInput("keys", { keys: Array.from({ length: 65 }, () => "a") }).ok,
    false,
    "超过 64 个应拒绝",
  );
});

await test("面板捕获按键但不吞 DSH 快捷键（作用域 + 放行规则）", () => {
  const raw = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  // ⚠️ 先剥注释：下面几个标记在注释里也出现过，不剥就会"删掉代码仍然通过"
  const source = stripComments(raw);

  // 必须挂在媒体元素上（聚焦才捕获），不能挂 window/document
  assert.ok(!/window\.addEventListener\(\s*["']key/u.test(source), "不得全局监听 keydown");
  assert.ok(!/document\.addEventListener\(\s*["']key/u.test(source), "不得在 document 上监听 keydown");
  // 画面要可聚焦
  //
  // ⚠️ 接受 `undefined` 与 `void 0` 两种写法：esbuild 会把前者改写成后者
  // （语义相同）。钉死字面量只会让"重新构建"变成一次无谓的失败。
  assert.ok(
    /tabIndex: interactive \? 0 : (undefined|void 0)/u.test(source),
    "画面元素缺 tabIndex，无法聚焦",
  );
  // ⌘/Ctrl 组合除编辑键外要放行
  assert.ok(source.includes("EDIT_KEYS"), "缺少修饰键放行名单，会吞掉 ⌘R 等浏览器快捷键");
  // 必须合批（逐字符发 = 每字符 100ms，没法用）
  assert.ok(source.includes("KEY_BATCH_MS"), "缺少按键合批");
  // 事件必须真的绑到媒体元素上，而不是定义完没人用
  assert.ok(/\.\.\.keyboardHandlers/u.test(source), "keyboardHandlers 没有展开到媒体元素上");
});

await test("非 ASCII 按键走 io text 通道（不需要 ADBKeyboard）", () => {
  const raw = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  const source = stripComments(raw);
  const fn = source.match(/function translateKey\([\s\S]*?\n      \}/u)?.[0] ?? "";
  assert.ok(fn.length > 0, "找不到 translateKey");
  // ASCII 走 key
  assert.ok(/kind: "key"/u.test(fn), "ASCII 应走 keys 通道");
  // 非 ASCII 走 text
  assert.ok(/kind: "text"/u.test(fn), "非 ASCII 应走 io text 通道");
  // 必须排除修饰键本身，否则按一下 Shift 就会给设备发一个无意义的键
  for (const mod of ["Shift", "Control", "Alt", "Meta"]) {
    assert.ok(fn.includes(`"${mod}"`), `translateKey 未排除修饰键 ${mod}`);
  }
  /**
   * ⚠️ emoji 是代理对（"🎉".length === 2）。用 key.length !== 1 判断
   * "不是单字符"会把整个 emoji 丢掉 —— 实测确实丢了（改前 emoji → 不发送）。
   * 必须按码点判断。
   */
  assert.ok(
    !/key\.length !== 1/u.test(fn),
    "用 key.length 判断单字符 —— emoji（代理对）会被丢掉，应用 Array.from",
  );
  assert.ok(/Array\.from\(key\)/u.test(fn), "应按码点判断字符数（Array.from）");
});

await test("输入法合成（中文拼音）必须处理 compositionend", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  /**
   * ⚠️ 少了这个，**中文根本打不进来**。macOS 拼音输入法合成期间发的
   * keydown 里 key 是 "Process"（那时还没定下输入什么，translateKey
   * 认不出是对的），真正的文本只在 compositionend 的 data 里。
   * 而中文正是最需要物理键盘的场景 —— 侧边栏里没法用手机输入法。
   */
  assert.ok(
    source.includes("onCompositionEnd"),
    "没处理 compositionend —— 用输入法打中文会静默丢失",
  );
  assert.ok(
    /onCompositionEnd[\s\S]{0,240}kind: "text"/u.test(source),
    "compositionend 应把整段文本交给 io text 通道",
  );
});

// ── 切换会话保留面板 ────────────────────────────────────────────────────
//
// 用户报告："切换会话后侧边栏画面流变成重新加载了"。
// 根因：tab 类型没声明 keepMounted，sidebar-right 的 prune() 在切走后
// 因 hasRetainedTabs === false 而 retire 掉 view → React 子树卸载 →
// 解码器被拆掉、切回来要重新等关键帧（实测 IDR 间隔可达 3–4 秒）。

console.log("\n切换会话保留");

await test("tab 类型声明了 keepMounted（否则切会话会 dispose 重建）", () => {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  /**
   * ⚠️ 必须**先剥掉注释**再断言。
   *
   * 第一版直接对源码做 /keepMounted:\s*true/ 匹配，结果匹配到的是上面那段
   * 解释性注释里引用的文字。故意删掉真正的 `keepMounted: true` 之后测试
   * 依然通过 —— 假阴性，等于没测。凡是"断言某段代码存在"的测试都有这个坑。
   */
  const code = stripComments(source);
  const start = code.indexOf("ctx.sidebarRightTabs.register({");
  assert.ok(start !== -1, "找不到 tab 注册");
  const reg = code.slice(start, start + 4096);
  assert.ok(
    /keepMounted:\s*true/u.test(reg),
    "缺 keepMounted —— 切换会话时 sidebar-right 会 retire 掉这个 view，画面流会重连",
  );
});

// ── 工具面：只留"加工型" ────────────────────────────────────────────────
//
// 5 个薄包装（tap/swipe/button/type_text/launch_app）被删掉了 —— 它们只是
// `runJson(...)` 加一句 return，而 agent 本来就有 shell（dsh-tool-bash 在
// dsh-base 里，恒可用），直接跑等价 mobilecli 命令就行。
//
// 收益（按 dsh-token-meter 的 ceil(chars/4)+4 公式实测）：
//   16 个工具 schema = 1487 tokens/轮（每次请求都发）
//   11 个工具 schema = 1034 tokens/轮
//   → 省 453 tokens/轮
//
// 这一段守住两件事：① 薄包装不许悄悄回来；② 它们的**知识**必须留在 skill 里。

console.log("\n工具面");

await test("只注册加工型工具，薄包装不许回流", () => {
  /**
   * ⚠️ 这里**不能** import tools.js —— 它依赖宿主包 `@deepseek-ai/dsh-tools`，
   * 在没有宿主的环境会直接抛（见 lib/tool-support.js 的说明）。
   * 所以按本仓库惯例：读源码 + 先剥注释（注释里会引用工具名，不剥会骗过断言）。
   */
  const source = stripComments(readFileSync(new URL("./lib/agent/tools.js", import.meta.url), "utf8"));

  /**
   * 注册表 = 源码里的 `[TOOL_NAMES.x]: y` 注册项。
   *
   * ⚠️ 不要锚 `return {` —— 各工具内部也有 return（例如 devicesTool），
   * 会锚到第一个而拿到 0 项（第一版就是这么错的，测试报"实际 0"）。
   * `[TOOL_NAMES.x]` 这种计算属性写法**只**出现在注册表里，是可靠的锚点。
   */
  const entries = [...source.matchAll(/\[TOOL_NAMES\.(\w+)\]/gu)].map((m) => m[1]);
  assert.ok(entries.length > 0, "找不到任何 [TOOL_NAMES.x] 注册项");

  assert.equal(entries.length, 11, `应注册 11 个工具，实际 ${entries.length}：${entries.join(", ")}`);

  /**
   * 被删的工具不得回流，且必须出现在 REMOVED_TOOL_NAMES 里
   * （让调用方能分辨"删了"和"打错了"）。
   *
   * 两组移除原因不同：
   *   · 薄包装 5 个 —— 只是 runJson 加 return，agent 有 shell 就不需要
   *   · flutterTree —— 与 ui_tree 完全重复（同一个 dumpUiElements），
   *                    且描述谎称直连 Dart VM Service
   */
  const REMOVED = ["tap", "swipe", "text", "button", "launchApp", "flutterTree"];
  for (const key of REMOVED) {
    assert.ok(!entries.includes(key), `TOOL_NAMES.${key} 不该被注册`);
  }
  const removedBlock = source.slice(
    source.indexOf("export const REMOVED_TOOL_NAMES = {"),
    source.indexOf("};", source.indexOf("export const REMOVED_TOOL_NAMES = {")),
  );
  for (const key of REMOVED) {
    assert.ok(
      removedBlock.includes(key),
      `${key} 既没注册也没进 REMOVED_TOOL_NAMES`,
    );
  }

  // TOOL_NAMES 必须与注册表一致（index.js 会 re-export 它）
  const namesStart = source.indexOf("export const TOOL_NAMES = {");
  const declared = [
    ...source.slice(namesStart, source.indexOf("};", namesStart)).matchAll(/^\s*(\w+):/gmu),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...declared].sort(),
    [...entries].sort(),
    `TOOL_NAMES 与注册表不一致：声明 ${declared.join(",")} / 注册 ${entries.join(",")}`,
  );
});

console.log("\n工具输出的呈现");

await test("render 必须按 (args, value) 两参签名 —— 否则工具会回显入参", () => {
  /**
   * 这条钉的是本插件一个**长期 bug 的根因**，不是风格洁癖。
   *
   * DSH 的 `ToolOutputDefinition` 在类型和调用点两处都写死两个参数：
   *
   *     render(args: unknown, value: JsonValue): ContentBlock[]
   *     rawRender(args, value)
   *
   * 而插件原先写的是 `renderJson(value)` —— 于是 harness 传进来的 **`args`
   * 被当成了结果**：
   *
   *   · 无参数工具（mobile_devices / mobile_open_panel）：args 是 `{}`
   *     → 所有调用一律显示 `{}`
   *   · 有参数工具：显示的是**刚传进去的入参** —— 看起来像个正常结果，
   *     其实完全不是。比显示空更糟，因为它不可疑。
   *
   * 这就是"所有 mobile_* 工具返回空结果"那个长期未解之谜的答案。
   */
  const source = stripComments(
    readFileSync(new URL("./lib/agent/tools.js", import.meta.url), "utf8"),
  );

  const m = source.match(/export function renderJson\(([^)]*)\)\s*\{([\s\S]*?)\n\}/u);
  assert.ok(m !== null, "找不到 renderJson");

  const params = m[1].split(",").map((s) => s.trim()).filter((s) => s !== "");
  assert.equal(
    params.length,
    2,
    `renderJson 必须收 (args, value) 两个参数，实际 ${params.length} 个：(${m[1]})`,
  );
  assert.match(
    params[0],
    /^_/u,
    `第一个参数必须显式忽略（下划线开头），实际 "${params[0]}" —— 它会被 harness 传成 args`,
  );
  assert.ok(
    /JSON\.stringify\(\s*value/u.test(m[2]),
    "renderJson 里序列化的必须是**第二个**参数 value（= 工具返回值）",
  );

  // 所有工具必须共用同一个 render（别有人另写一个又踩回单参）
  const renders = [...source.matchAll(/render:\s*(\w+)/gu)].map((x) => x[1]);
  assert.ok(renders.length >= 10, `render 挂载点太少（${renders.length}）`);
  assert.deepEqual(
    [...new Set(renders)],
    ["renderJson"],
    `所有工具应共用 renderJson，实际用了 ${[...new Set(renders)].join(", ")}`,
  );
});

console.log("\n打开面板（mobile_open_panel）");

await test("面板打开的路由名在宿主与客户端两处必须一致", () => {
  /**
   * 这两个名字是**跨进程的契约**：宿主在 lib/stream/access.js 的 ROUTES 里
   * 定义，客户端在 src/client/index.jsx 里拼 URL。两边写错一个字符，症状是
   * 404 或者长轮询永远挂着 —— 都不会有人报错，只会"点了没反应"。
   */
  const access = stripComments(
    readFileSync(new URL("./lib/stream/access.js", import.meta.url), "utf8"),
  );
  const client = stripComments(
    readFileSync(new URL("./src/client/index.jsx", import.meta.url), "utf8"),
  );

  const pairs = [
    ["panelOpen", "ROUTE_PANEL_OPEN", "panel-open"],
    ["panelOpenAck", "ROUTE_PANEL_OPEN_ACK", "panel-open-ack"],
  ];
  for (const [hostKey, clientConst, path] of pairs) {
    assert.ok(
      new RegExp(`${hostKey}:\\s*"${path}"`, "u").test(access),
      `access.js 的 ROUTES.${hostKey} 应为 "${path}"`,
    );
    assert.ok(
      new RegExp(`const ${clientConst} = "${path}"`, "u").test(client),
      `客户端 ${clientConst} 应为 "${path}"`,
    );
  }
});

await test("「请打开面板」的轮询必须在 apply() 里，不能放进面板组件", () => {
  /**
   * 这是这个能力的核心不变量，放错地方它会自相矛盾：
   *
   * 需求是"打开一个**还没打开**的面板"。而面板组件的 useEffect 只在组件
   * 挂载后才跑 —— 把轮询放进组件，就只有在面板已经打开时才会轮询，恰恰是
   * 最不需要它的时候。所以轮询必须挂在插件加载期（apply）。
   *
   * 客户端源码里 MobilePanel 组件在 apply() 之前，因此"轮询代码的位置必须
   * 晚于 apply(ctx)"就等价于"它在 apply 里、不在组件里"。这个断言会随文件
   * 重排失效，但那时它会**失败**而不是静默放过 —— 这是刻意的。
   */
  const source = stripComments(
    readFileSync(new URL("./src/client/index.jsx", import.meta.url), "utf8"),
  );

  const applyAt = source.indexOf("apply(ctx) {");
  assert.ok(applyAt > 0, "找不到 apply(ctx)");

  const pollAt = source.indexOf("dsh-sidebar-mobile:panel-open-poll");
  assert.ok(
    pollAt > applyAt,
    "「请打开面板」的轮询不在 apply() 里 —— 面板没打开时它根本不会跑，功能自相矛盾",
  );

  // 打开动作按 kind（openTab），不能用 openTabFromTarget ——
  // 后者要一个 DOM 元素，而模型发起的打开没有元素可给。
  const openAt = source.indexOf('openTab("mobile")');
  assert.ok(openAt > applyAt, 'apply() 里找不到 openTab("mobile")');
  const fromTargetAt = source.indexOf("openTabFromTarget", applyAt);
  assert.ok(
    fromTargetAt === -1 || fromTargetAt > openAt,
    "模型发起的打开不能用 openTabFromTarget（它需要 DOM 元素）",
  );
});

await test("打开面板的跨进程链路必须完整接线", () => {
  const routes = readFileSync(new URL("./lib/stream/routes.js", import.meta.url), "utf8");
  const tools = stripComments(
    readFileSync(new URL("./lib/agent/tools.js", import.meta.url), "utf8"),
  );
  const index = stripComments(readFileSync(new URL("./index.js", import.meta.url), "utf8"));
  const client = stripComments(
    readFileSync(new URL("./src/client/index.jsx", import.meta.url), "utf8"),
  );

  // 宿主：请求状态 + 长轮询 + 回执 + 分发
  for (const need of [
    "requestPanelOpen",
    "#panelOpen(",
    "#panelOpenAck(",
    "case ROUTES.panelOpen:",
    "case ROUTES.panelOpenAck:",
  ]) {
    assert.ok(routes.includes(need), `routes.js 缺少 ${need}`);
  }

  // 工具：定义 + 注册 + 有回执字段
  assert.ok(tools.includes('openPanel: "mobile_open_panel"'), "TOOL_NAMES 缺 openPanel");
  assert.ok(tools.includes("[TOOL_NAMES.openPanel]: openPanelTool"), "注册表缺 openPanel");
  assert.ok(tools.includes('opened: { type: "boolean", required: true }'), "工具没回执字段");

  // 宿主接线：工具要真的拿得到打开能力
  assert.ok(
    /openPanel:\s*\(\)\s*=>\s*routes\.requestPanelOpen\(\)/u.test(index),
    "index.js 没把 requestPanelOpen 交给工具",
  );

  // 客户端：打开之后必须回执，否则工具只能干等超时
  assert.ok(
    client.includes("ROUTE_PANEL_OPEN_ACK, { request: seq }"),
    "客户端打开面板后没有回执",
  );
});

await test("长轮询：请求到达时挂起的响应立刻返回，回执后工具拿到 opened:true", async () => {
  /**
   * 这是"模型能把面板打开"的实际机制，所以按**行为**验，不只验接线：
   *
   *   ① 客户端先挂着 GET /panel-open（此时没有请求 → 响应必须不返回）
   *   ② 工具调 requestPanelOpen() → 挂起的那条立刻带着请求号返回
   *   ③ 客户端 POST 回执 → 工具的 Promise resolve 成 opened:true
   */
  const client = {
    async listDevices() { return [{ id: "d1", name: "d", platform: "android", state: "online" }]; },
    async runJson() { return {}; },
  };
  const routes = new StreamRoutes({
    client, pool: { acquire: () => ({}) }, access: { mint: () => "t" }, log: () => {},
  });

  const headers = {
    host: "127.0.0.1:19387",
    origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  const makeRes = () => ({
    statusCode: 0, body: "", headersSent: false, writableEnded: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(p) { this.body = p ?? ""; this.writableEnded = true; },
    write() {}, on() {}, setHeader() {},
  });
  const makeAck = (request) => {
    const req = new Readable({ read() {} });
    req.method = "POST";
    req.url = "/panel-open-ack";
    req.headers = headers;
    req.socket = { remoteAddress: "127.0.0.1" };
    req.push(Buffer.from(JSON.stringify({ request })));
    req.push(null);
    return routes.handle("panel-open-ack", req, makeRes());
  };

  // ① 客户端挂上长轮询
  const getReq = new Readable({ read() {} });
  getReq.method = "GET";
  getReq.url = "/panel-open";
  getReq.headers = headers;
  getReq.socket = { remoteAddress: "127.0.0.1" };
  const heldRes = makeRes();
  let heldDone = false;
  const held = routes.handle("panel-open", getReq, heldRes).then((v) => { heldDone = true; return v; });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heldDone, false, "没有待处理请求时，长轮询必须挂起而不是空转返回");

  // ② 工具发起打开请求
  const opening = routes.requestPanelOpen(5000);
  await held;
  assert.equal(heldRes.statusCode, 200, "挂起的响应应当被唤醒并返回");
  const carried = JSON.parse(heldRes.body);
  assert.equal(carried.request, 1, `应当把请求号带回给客户端，实际 ${heldRes.body}`);

  // ③ 客户端回执
  await makeAck(1);

  const result = await opening;
  assert.equal(result.opened, true, "收到回执后工具必须拿到 opened:true");
  assert.equal(routes.panelOpenPending, null, "回执后待处理请求应当清空");
});

await test("没人回执时如实报 opened:false —— 不许假装成功", async () => {
  /**
   * 这是"工具描述是否诚实"的底线：客户端没响应（网页没开、客户端半边没加载）
   * 时返回 opened:true，会让模型对用户说"已经打开了"，而屏幕上一片空白。
   */
  const routes = new StreamRoutes({
    client: { async listDevices() { return []; }, async runJson() { return {}; } },
    pool: { acquire: () => ({}) }, access: { mint: () => "t" }, log: () => {},
  });

  const result = await routes.requestPanelOpen(80);
  assert.equal(result.opened, false, "没人回执时不能报成功");
  assert.ok(
    typeof result.reason === "string" && result.reason.includes("回执"),
    `应当给出可照做的原因，实际 ${JSON.stringify(result)}`,
  );
  assert.ok(result.waitedMs >= 70, `应当真的等满超时，实际 ${result.waitedMs}ms`);
});

await test("面板轮询不许忙等：除「正常超时」外每一轮都要先退避", () => {
  /**
   * 这条是**实际测出来的 bug 的回归护栏**（不是假想）。
   *
   * 第一版只在 fetch 抛异常时退避，其余分支一律 `continue` 立刻重来。而
   * **404 是成功的 HTTP 响应** —— fetch 不抛，只有 `response.json()` 解析
   * "not found" 会失败。那时 seq 是 null，于是浏览器以 fetch 的最快速度
   * 一圈接一圈地打宿主。宿主跑旧代码时（正是升级窗口）必然踩中。
   *
   * 判据：pump 里的每个 `continue`，要么前面有 `sleep(...)`，要么是那一条
   * 设计内的"长轮询正常超时"（`if (seq === null) continue;`）—— 正常超时
   * 立刻重挂是**对的**，不算忙等。
   */
  const source = stripComments(
    readFileSync(new URL("./src/client/index.jsx", import.meta.url), "utf8"),
  );

  const start = source.indexOf("const pump = async () => {");
  assert.ok(start > 0, "找不到 pump()");

  // 花括号配对取出函数体，别用固定缩进（缩进会随重排变）
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, "pump() 的括号没配对");
  const pump = source.slice(start, end);

  const ALLOWED = "if (seq === null) continue;";
  const lines = pump.split("\n");
  const continues = lines.filter((l) => l.trim().endsWith("continue;"));
  assert.ok(continues.length >= 3, `pump 里的 continue 太少（${continues.length}），抽取可能失效`);

  /**
   * ⚠️ 判据是**紧邻的上一行代码**，不能用"往前 N 个字符里有没有 sleep"。
   *
   * 第一版就是这么写的，结果**假阴性**：把 `seq === lastHandled` 那支的
   * sleep 删掉后测试照样通过 —— 因为 600 字符窗口够宽，把**前一个分支**的
   * `await sleep(RETRY_DELAY_MS)` 也框进来了。每个分支的退避必须各自成立。
   */
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().endsWith("continue;")) continue;
    if (lines[i].includes(ALLOWED)) continue; // 设计内：长轮询正常超时，立刻再挂

    // 往上找第一条非空、非注释的代码行
    let j = i - 1;
    while (j >= 0 && (lines[j].trim() === "" || lines[j].trim().startsWith("//"))) j -= 1;
    const prev = (lines[j] ?? "").trim();
    if (!prev.includes("sleep(")) offenders.push(`${lines[i].trim()}   ← 上一行是 ${prev || "(空)"}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `这些 continue 没有紧邻的退避，会忙等打宿主：\n    ${offenders.join("\n    ")}`,
  );
});

await test("端到端（真 HTTP）：路由真的挂在那个 URL 上，长轮询真的会挂住", async () => {
  /**
   * 前面几条用的是假 req/res —— 验的是 routes 内部逻辑。这条走**真实 socket**，
   * 补上假对象验不到的那部分：
   *
   *   · mountRoutes 的 prefix + 路由名拼出来到底是不是那个 URL
   *     （写错一个字符 = 404，而浏览器只会静默重试，没有人会报错）
   *   · 传输层围栏、方法检查（GET / POST）在真请求上是否放行
   *   · 长轮询在真连接上是否真的**挂住**，而不是立刻返回空
   *
   * 换句话说：这条过了，就只剩"浏览器里的 openTab 到底有没有打开侧边栏"
   * 那一件事需要人来确认了。
   */
  const PREFIX = "/_dsh/dsh-sidebar-mobile";

  const client = {
    async listDevices() { return []; },
    async runJson() { return {}; },
  };
  const routes = new StreamRoutes({
    client, pool: { acquire: () => ({}) }, access: { mint: () => "t" }, log: () => {},
  });

  // 用桩 webServer 抓 mountRoutes 注册的 handler，再挂到真 http server 上
  let mounted = null;
  const ctx = {
    webServer: {
      register(route) { mounted = route; return () => {}; },
    },
  };
  const dispose = mountRoutes(ctx, routes, PREFIX);
  assert.ok(mounted !== null, "mountRoutes 没注册 handler");
  assert.equal(mounted.kind, "prefix");
  assert.equal(mounted.path, PREFIX, "挂载前缀与客户端拼的 PREFIX 不一致");

  const server = http.createServer((req, res) => {
    void mounted.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}${PREFIX}`;

  try {
    // ① 客户端挂上长轮询 —— 必须挂住（判"没立刻返回"）
    let settled = false;
    const held = fetch(`${base}/panel-open`)
      .then((r) => r.json())
      .then((j) => { settled = true; return j; });

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(settled, false, "没有待处理请求时，真连接上的长轮询也必须挂住");

    // ② 工具发起 → 挂住的那条立刻带号返回
    const opening = routes.requestPanelOpen(5000);
    const carried = await held;
    assert.equal(carried.request, 1, `应当带回请求号，实际 ${JSON.stringify(carried)}`);

    // ③ 客户端回执（真实 POST）
    const ackRes = await fetch(`${base}/panel-open-ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: 1 }),
    });
    assert.equal(ackRes.status, 200, "回执 POST 应当被接受");

    const result = await opening;
    assert.equal(result.opened, true, "真 HTTP 链路上，回执后工具必须拿到 opened:true");

    // ④ 方法检查：GET 打回执路由应当被拒
    const wrongMethod = await fetch(`${base}/panel-open-ack`, { method: "GET" });
    assert.equal(wrongMethod.status, 405, "回执路由必须只收 POST");

    // ⑤ 路由前缀写错就该 404 —— 证明这条测试真的在验 URL
    const wrong = await fetch(`http://127.0.0.1:${port}${PREFIX}-typo/panel-open`);
    assert.equal(wrong.status, 404, "错误前缀应当 404");
  } finally {
    dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

await test("迟到的回执不算数（不能替下一次请求开门）", async () => {
  /**
   * 超时之后客户端才把回执送到，是正常会发生的事（网络慢、页面卡）。
   * 如果拿旧号也能算数，就会出现"这次请求其实没人应答，但因为上次的迟到
   * 回执而被判成功" —— 又一条对用户说谎的路径。
   */
  const routes = new StreamRoutes({
    client: { async listDevices() { return []; }, async runJson() { return {}; } },
    pool: { acquire: () => ({}) }, access: { mint: () => "t" }, log: () => {},
  });

  const headers = {
    host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };

  // 第一次请求超时（没有客户端来取）
  const first = await routes.requestPanelOpen(60);
  assert.equal(first.opened, false);
  assert.equal(routes.panelOpenPending, 1, "超时后请求号应仍挂着，等客户端来取");

  // 来一个属于"上一次"的迟到回执
  const ackReq = new Readable({ read() {} });
  ackReq.method = "POST";
  ackReq.url = "/panel-open-ack";
  ackReq.headers = headers;
  ackReq.socket = { remoteAddress: "127.0.0.1" };
  ackReq.push(Buffer.from(JSON.stringify({ request: 0 })));
  ackReq.push(null);
  const ackRes = {
    statusCode: 0, body: "", headersSent: false, writableEnded: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(p) { this.body = p ?? ""; this.writableEnded = true; },
    write() {}, on() {}, setHeader() {},
  };
  await routes.handle("panel-open-ack", ackReq, ackRes);
  assert.equal(JSON.parse(ackRes.body).stale, true, "对不上号的回执应当被认作 stale");

  // 关键：这个回执不能把"下一次请求"提前判成功
  const secondResult = await routes.requestPanelOpen(60);
  assert.equal(secondResult.opened, false, "对不上号的回执不能替新请求开门");
});

await test("被删工具的关键知识必须留在 skill 里（否则是净损失）", () => {
  const skill = readFileSync(new URL("./skills/mobilecli/SKILL.md", import.meta.url), "utf8");
  /**
   * 删掉工具时最容易犯的错：把知识与代码一起删。
   * 下面每一条都是"看 --help 看不出来、踩过才知道"的细节。
   */
  const mustKeep = [
    [/--duration/u, "io swipe 必须传 --duration（否则用平台默认 ~1000ms，慢动作）"],
    [/(physical|物理).{0,12}pixel|physical pixels/iu, "坐标是物理像素"],
    [/focus|聚焦/iu, "输入文本前必须先让输入框获得焦点"],
    [/BACK/u, "io button 的键名（Android 上 BACK 是一等公民）"],
    [/apps list|先列|list first/iu, "启动应用前先列应用，别猜包名"],
    [/ADBKeyboard/u, "非 ASCII 不需要 ADBKeyboard（实测纠正过的事实）"],
  ];
  for (const [re, why] of mustKeep) {
    assert.ok(re.test(skill), `skill 里丢了这条知识：${why}`);
  }
});

await test("skill 的触发描述不许覆盖工具已能做的场景", async () => {
  const { loadBundledSkill } = await import("./lib/agent/skills.js");
  const skill = loadBundledSkill();
  assert.ok(skill !== null, "skill 未加载");

  /**
   * ⚠️ 这是本仓库**最贵的文案**：description + whenToUse 会进每轮的工具面索引，
   * 而它们一旦诱导模型去载入 skill 正文，代价是 5137 tokens（实测），
   * 且载入后留在历史里每轮重发。实测这笔误触发是工具瘦身收益的 ~15 倍。
   *
   * 老版本写的是 "Use whenever a task involves operating or inspecting a
   * mobile device" —— 几乎覆盖所有场景。现在必须明确排除。
   */
  const text = `${skill.description} ${skill.whenToUse}`.toLowerCase();

  assert.ok(
    /do not|not for|skip this skill|no mobile_\* tool|do not cover/u.test(text),
    "触发描述没有排除工具已覆盖的场景 —— 会让模型在本可直接调工具时载入 5137 tokens 正文",
  );
  // 正文（content）里保留全部细节是对的；这里只约束常驻的摘要
  assert.ok(skill.content.length > 15000, "正文应保留完整参考（按需加载，不常驻）");
});

// ── 断流恢复 ────────────────────────────────────────────────────────────
//
// 用户报告："滚动的时候解码器发生错误了，然后画面直接死了"。
//
// 查出两个叠加的缺陷，都不是解码器本身的问题：
//
//   ① Host 侧流进程崩溃后会自己重启（#scheduleRestart），但**浏览器这条
//      HTTP 响应不会被关闭** —— 它只是不再有新数据。于是 reader.read()
//      永远挂着，既不 done 也不 error，客户端毫无察觉。
//   ② 客户端**根本没有重连**：一次 run() 结束就 report("ended") 返回，
//      而 useEffect 的依赖（streamUrl）没变，所以再也不会重新取流。
//
// 另外 crashCount 只会在空闲自停时归零，会**单向累积**把退避推到 30s。

console.log("\n断流恢复");

await test("客户端必须有停流看门狗（否则流卡住时画面永久死亡）", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  /**
   * 关键：监控"多久没收到字节"，而不是帧率 —— 静止画面时编码器可能
   * 只发很稀疏的帧，按帧率判断会误杀。
   */
  assert.ok(source.includes("STALL_TIMEOUT_MS"), "缺停流看门狗");
  assert.ok(/lastByteAt/u.test(source), "看门狗应基于「最后收到字节的时间」");
  assert.ok(/setInterval/u.test(source), "看门狗需要一个定时检查");
  // 看门狗必须真的去打断读取（否则只是看着）
  assert.ok(
    /STALL_TIMEOUT_MS[\s\S]{0,400}reader\?\.cancel/u.test(source),
    "看门狗超时后没有打断读取循环",
  );
});

await test("客户端必须有断流自动重连（而不是停在『流已结束』）", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  assert.ok(source.includes("runWithReconnect"), "没有重连循环");
  // 不能再有把 ended 当终态上报的写法
  assert.ok(
    !/report\("ended"\)/u.test(source),
    "仍在 report('ended') —— 那会让画面停在终态且永不重连",
  );
  // 退避要有上下限，不能无限快重试
  assert.ok(/RECONNECT_BASE_MS/u.test(source) && /RECONNECT_MAX_MS/u.test(source), "重连缺退避上下限");
  // 收到数据后要把退避复位，否则抖动一次之后就一直是长退避
  assert.ok(
    /bytesReceived > before[\s\S]{0,120}reconnectDelay = RECONNECT_BASE_MS/u.test(source),
    "本轮收到数据后没有复位退避 —— 偶发抖动会退化成长期慢重连",
  );
});

await test("流启动成功后 crashCount 要归零（否则退避单向累积到 30s）", () => {
  const source = stripComments(readFileSync(new URL("./lib/stream/session.js", import.meta.url), "utf8"));
  /**
   * ⚠️ crashCount 原先只在**空闲自停**时归零，会单向累积：
   * 一次抖动 + 一次设备忙碌就能把退避推到 30s 上限，此后即使流跑得很好，
   * 下次崩溃也要干等 30s —— 表现是"卡一下之后再也回不来"，且越用越糟。
   *
   * 判据是**拿到第一块数据**（说明这次真的跑起来了），不是"进程还活着"：
   * 进程起来就立刻退出（设备端 agent 没起来时只输出 `Error:`）不该算成功，
   * 否则会退化成无退避的快速重启循环。
   */
  const startIdx = source.indexOf("proc.stdout?.on(\"data\"");
  assert.ok(startIdx !== -1, "找不到 stdout data 处理");
  const block = source.slice(startIdx, startIdx + 1800);
  assert.ok(
    /this\.head === null[\s\S]{0,900}this\.crashCount = 0/u.test(block),
    "拿到首块数据后没有清零 crashCount —— 退避会单向累积到 30s 且永不恢复",
  );
});

await test("停流看门狗与重连的行为（真实控制流 + 忠实的 stream 替身）", async () => {
  /**
   * 上面几条是"源码里有这段代码"，这条是**行为验证**：
   * 让读取永久挂起，看看门狗会不会掐断、外层会不会重连。
   *
   * ⚠️ 替身必须忠实模拟 ReadableStream 语义：`cancel()` 要让挂起的
   * `read()` 以异常 reject。第一版替身没做这件事，测试直接卡死 ——
   * 那不是代码的问题，是替身不真。
   */
  const events = [];
  let cancelled = false;
  let bytes = 0;
  let rounds = 0;

  const makeReader = () => {
    let n = 0;
    let pendingReject = null;
    return {
      read() {
        n += 1;
        if (n <= 1) return Promise.resolve({ done: false, value: new Uint8Array(512) });
        return new Promise((_res, rej) => { pendingReject = rej; }); // 永久挂起
      },
      cancel() {
        if (pendingReject !== null) {
          const reject = pendingReject;
          pendingReject = null;
          reject(new Error("AbortError"));
        }
        return Promise.resolve();
      },
    };
  };

  const oneRound = async (stallMs) => {
    rounds += 1;
    const reader = makeReader();
    let timer = null;
    let lastByteAt = Date.now();
    timer = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastByteAt > stallMs) {
        events.push("watchdog");
        void reader.cancel().catch(() => {});
      }
    }, 20);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        bytes += value.byteLength;
      }
    } catch {
      events.push("aborted");
    } finally {
      clearInterval(timer);
    }
  };

  // 用很短的窗口模拟 3000ms 的真实值（测试不该真等 3 秒）
  await oneRound(80);
  assert.ok(events.includes("watchdog"), "看门狗没有触发 —— 挂起的读取会永远卡住画面");
  assert.ok(bytes >= 512, "这一轮应当收到过数据");
  assert.ok(rounds === 1, "只应跑一轮");

  // 重连：再来一轮，证明循环可以继续（真实代码里由 runWithReconnect 驱动）
  await oneRound(80);
  assert.equal(rounds, 2, "没有发生重连 —— 断流后画面会永久停在终态");
  assert.ok(bytes >= 1024, "重连后应当继续收到数据");
  cancelled = true;
});

// ── daemon RPC（交互加速通道）────────────────────────────────────────
//
// POSIX socket 样本实测 device.io.tap 7.3ms vs CLI 104.2ms；Windows 上 Node
// 访问 daemon socket 可能被拒，插件会停用 RPC。测试分别覆盖协议与连接前回退。
//
// 下面用**本地假 socket 服务器**验证协议，不依赖真机或真 daemon。
// 守的都是实测得来的事实 —— 错了会让交互静默变慢或失败。

console.log("\nAgent device fast path and mobile loop");

await test("explicit device id skips slow device enumeration", async () => {
  let listCalls = 0;
  const device = await resolveDevice({
    async listDevices() { listCalls += 1; return []; },
  }, "android-1", "mobile_ui_tree");
  assert.equal(device.id, "android-1");
  assert.equal(listCalls, 0);
});

await test("mobile loop request redacts labels and excludes risky controls", () => {
  const request = createMobileLoopRequest("Open the next screen", [
    { type: "TextView", text: "user@example.com 555 123 4567", rect: { x: 1, y: 1, width: 20, height: 10 } },
    { type: "EditText", text: "secret", rect: { x: 2, y: 2, width: 20, height: 10 } },
    { type: "Button", text: "Pay now", rect: { x: 3, y: 3, width: 20, height: 10 } },
    { type: "Button", text: "Allow access", rect: { x: 5, y: 5, width: 20, height: 10 } },
    { type: "Button", text: "Share", rect: { x: 6, y: 6, width: 20, height: 10 } },
    { type: "Button", text: "Save changes", rect: { x: 7, y: 7, width: 20, height: 10 } },
    { type: "Button", text: "Next", rect: { x: 4, y: 4, width: 20, height: 10 } },
  ]);
  assert.deepEqual(request.controls.map((control) => control.label), ["[email] [number]", "Next"]);
  assert.equal(request.questions.next_step.kind, "choice");
  assert.deepEqual(Object.keys(request.questions.next_step.options), ["done", "stop", "tap_1", "tap_2"]);
  assert.equal(isJudgmentUsable(makeJudge([])), true);
  assert.equal(isJudgmentUsable({ ...makeJudge([]), apiVersion: 2 }), false);
});

await test("mobile loop taps only a fresh high-confidence choice and stops on done", async () => {
  const answers = [
    { kind: "choice", optionId: "tap_1", probabilities: { tap_1: 0.9, done: 0.05, stop: 0.05 } },
    { kind: "choice", optionId: "done", probabilities: { tap_1: 0.02, done: 0.96, stop: 0.02 } },
  ];
  const judge = makeJudge(answers);
  let askCalls = 0;
  const ask = judge.ask.bind(judge);
  judge.ask = async (...args) => { askCalls += 1; return ask(...args); };
  let listCalls = 0;
  let dumpCalls = 0;
  const taps = [];
  const client = {
    async listDevices() { listCalls += 1; return []; },
    async runJson() {
      dumpCalls += 1;
      return { elements: [{ type: "Button", text: "Next", rect: { x: 10, y: 20, width: 40, height: 20 } }] };
    },
  };
  const result = await runMobileLoop({
    client,
    judge,
    device: "android-1",
    goal: "Open the next screen",
    performTap: async (tap) => taps.push(tap),
    wait: async () => {},
  });
  assert.equal(result.status, "goal_reported");
  assert.equal(result.actions[0].status, "tapped");
  assert.deepEqual(taps, [{ deviceId: "android-1", x: 30, y: 30 }]);
  assert.equal(dumpCalls, 3);
  assert.equal(askCalls, 2);
  assert.equal(listCalls, 0);
});

await test("mobile loop 不会把低置信度的 done 报为完成", async () => {
  const judge = makeJudge([
    { kind: "choice", optionId: "done", probabilities: { done: 0.6, stop: 0.4 } },
  ]);
  const result = await runMobileLoop({
    client: { async runJson() { return { elements: [] }; } },
    judge,
    device: "android-1",
    goal: "Open the next screen",
    performTap: async () => { throw new Error("should not tap"); },
    wait: async () => {},
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "low_completion_probability");
});

await test("mobile loop stops without tapping if the UI changes after judgment", async () => {
  const judge = makeJudge([
    { kind: "choice", optionId: "tap_1", probabilities: { tap_1: 0.9, done: 0.05, stop: 0.05 } },
  ]);
  let dumpCalls = 0;
  let tapCalls = 0;
  const client = {
    async runJson() {
      dumpCalls += 1;
      return { elements: [{ type: "Button", text: "Next", rect: { x: dumpCalls === 1 ? 10 : 11, y: 20, width: 40, height: 20 } }] };
    },
  };
  const result = await runMobileLoop({
    client,
    judge,
    device: "android-1",
    goal: "Open the next screen",
    performTap: async () => { tapCalls += 1; },
    wait: async () => {},
  });
  assert.equal(result.reason, "ui_changed_after_judgment");
  assert.equal(tapCalls, 0);
});

await test("mobile loop does not retry dsh_judgment invalid-response", async () => {
  const failure = Object.assign(new Error("invalid judgment response"), { code: "invalid-response" });
  const judge = makeJudge([failure]);
  let askCalls = 0;
  const ask = judge.ask.bind(judge);
  judge.ask = async (...args) => { askCalls += 1; return ask(...args); };
  let tapCalls = 0;
  const client = {
    async runJson() {
      return { elements: [{ type: "Button", text: "Next", rect: { x: 10, y: 20, width: 40, height: 20 } }] };
    },
  };
  const result = await runMobileLoop({
    client,
    judge,
    device: "android-1",
    goal: "Open the next screen",
    performTap: async () => { tapCalls += 1; },
    wait: async () => {},
  });
  assert.equal(result.reason, "judgment_error");
  assert.equal(result.errorCode, "invalid-response");
  assert.equal(askCalls, 1);
  assert.equal(tapCalls, 0);
});

console.log("\ndaemon RPC");

// 假 daemon：读一行 JSON、回一行 JSON、然后关闭连接（与真实语义一致）。
// 三种假行为要分得开（否则「超时」与「提前断开」会混在一起）：
//   返回 null      → 不回也不关（卡住）→ 只能被超时打断
//   返回 undefined → 不回、直接 destroy → 客户端看到「响应前关闭」
//   返回对象       → 正常回一行
function fakeDaemon(handler, { keepOpen = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-rpc-"));
  const socketPath = join(dir, "daemon.sock");
  const received = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { socket.end(); return; }
      received.push(msg);
      const reply = handler(msg);
      if (reply === null) return; // 保持连接不动
      if (reply === undefined) { socket.destroy(); return; }
      socket.write(JSON.stringify(reply) + "\n");
      if (!keepOpen) socket.end();
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        received,
        close: () => new Promise((r) => {
          server.close(() => { rmSync(dir, { recursive: true, force: true }); r(); });
        }),
      });
    });
  });
}

await test("resolveSocketPath 跟随 MOBILECLI_HOME（与 CLI 同一规则）", () => {
  assert.equal(resolveSocketPath(null), join(process.env.HOME, ".mobilecli", "daemon.sock"));
  assert.equal(resolveSocketPath("/tmp/custom"), join("/tmp/custom", "daemon.sock"));
  assert.equal(resolveSocketPath(null).endsWith("daemon.sock"), true);
});

await test("CLI fallback 仅用于确定尚未建立连接的错误", () => {
  for (const code of ["ENOENT", "ECONNREFUSED", "EACCES", "EPERM"]) {
    assert.equal(isSafeCliFallbackError({ code }), true, `${code} 应允许回退`);
  }
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
    assert.equal(isSafeCliFallbackError({ code }), false, `${code} 结果不明，不应重放`);
  }
  assert.equal(isSafeCliFallbackError(new Error("remote device error")), false);
});

await test("RPC 参数形状与 CLI 不同：独立字段，不是逗号串", () => {
  const swipe = rpcForInput({ action: "swipe", deviceId: "d1", x1: 1, y1: 2, x2: 3, y2: 4, duration: 200 });
  assert.equal(swipe.method, "device.io.swipe");
  assert.deepEqual(swipe.params, { deviceId: "d1", x1: 1, y1: 2, x2: 3, y2: 4, duration: 200 });
  // 关键：不能是 CLI 那种逗号串
  assert.equal("coordinates" in swipe.params, false, "RPC 不接受逗号串坐标");

  const tap = rpcForInput({ action: "tap", deviceId: "d1", x: 9, y: 8 });
  assert.deepEqual(tap.params, { deviceId: "d1", x: 9, y: 8 });

  const keys = rpcForInput({ action: "keys", deviceId: "d1", keys: ["ctrl+a"] });
  assert.deepEqual(keys.params, { deviceId: "d1", keys: ["ctrl+a"] });
});

await test("rotate 没有 RPC 实现（必须回退 CLI）", () => {
  // daemon 不暴露 orientation —— 实测多个候选方法名全部 method not found
  assert.equal(rpcForDeviceAction("rotate", "d1"), null);
  assert.equal(rpcForInput({ action: "rotate", deviceId: "d1" }), null);
  // home/back/power 都落在 device.io.button
  assert.deepEqual(rpcForDeviceAction("back", "d1"), {
    method: "device.io.button",
    params: { deviceId: "d1", button: "BACK" },
  });
  assert.equal(rpcForDeviceAction("home", "d1").params.button, "HOME");
  assert.equal(rpcForDeviceAction("power", "d1").params.button, "POWER");
});

await testUnixSocket("callDaemon 发的是 newline-delimited JSON（不是 HTTP）", async () => {
  const daemon = await fakeDaemon((msg) => ({ jsonrpc: "2.0", id: msg.id, result: { status: "ok" } }));
  try {
    const result = await callDaemon("device.io.tap", { deviceId: "d1", x: 1, y: 2 }, { socketPath: daemon.socketPath });
    assert.deepEqual(result, { status: "ok" });
    assert.equal(daemon.received.length, 1);
    assert.equal(daemon.received[0].method, "device.io.tap");
    assert.deepEqual(daemon.received[0].params, { deviceId: "d1", x: 1, y: 2 });
    assert.equal(daemon.received[0].jsonrpc, "2.0");
  } finally {
    await daemon.close();
  }
});

await testUnixSocket("JSON-RPC error 会抛出，且优先用 error.data 里的具体原因", async () => {
  const daemon = await fakeDaemon((msg) => ({
    jsonrpc: "2.0", id: msg.id,
    error: { code: -32000, message: "Server error", data: "error finding device: device not found: NOPE" },
  }));
  try {
    await assert.rejects(
      () => callDaemon("device.io.tap", { deviceId: "NOPE" }, { socketPath: daemon.socketPath }),
      /device not found: NOPE/,
      "应当抛出 data 里的具体原因，而不是笼统的 Server error",
    );
  } finally {
    await daemon.close();
  }
});

await testUnixSocket("daemon 不回就关闭 → 报错而不是永久挂起", async () => {
  const daemon = await fakeDaemon(() => undefined); // 不回，直接 destroy
  try {
    await assert.rejects(
      () => callDaemon("device.io.tap", {}, { socketPath: daemon.socketPath, timeoutMs: 3000 }),
      /关闭了连接/u,
    );
  } finally {
    await daemon.close();
  }
});

await test("socket 不存在 → ENOENT，且通道被标记为不可用（不再逐次白等）", async () => {
  const logs = [];
  const rpc = new DaemonRpc({ home: "/tmp/definitely-not-here-dsh", log: (l, m) => logs.push(`${l}:${m}`) });
  assert.equal(rpc.available, true);
  await assert.rejects(
    () => rpc.call("device.io.tap", {}),
    (error) => ["ENOENT", "EACCES", "EPERM"].includes(error.code),
  );
  assert.equal(rpc.available, false, "连接层失败后应标记不可用，避免每次交互都白等一次超时");
  assert.ok(logs.some((l) => l.includes("daemon socket 不可用")), "应记录日志");

  // 再调一次：立即失败，不再尝试连接
  await assert.rejects(() => rpc.call("device.io.tap", {}), /已标记为不可用/u);

  // reset 后可以重试（daemon 重启的场景）
  rpc.reset();
  assert.equal(rpc.available, true);
});

await testUnixSocket("业务失败不标记通道不可用（否则一次设备错误就永久降级）", async () => {
  const daemon = await fakeDaemon((msg) => ({
    jsonrpc: "2.0", id: msg.id,
    error: { code: -32000, message: "Server error", data: "gesture rejected" },
  }));
  try {
    const rpc = new DaemonRpc({ home: join(daemon.socketPath, ".."), log: () => {} });
    // home 指向 socket 所在目录
    const fixed = new DaemonRpc({ home: daemon.socketPath.replace(/\/daemon\.sock$/u, ""), log: () => {} });
    assert.equal(fixed.socketPath, daemon.socketPath);
    await assert.rejects(() => fixed.call("device.io.tap", {}), /gesture rejected/u);
    assert.equal(fixed.available, true, "业务错误不该让整条通道停用");
    void rpc;
  } finally {
    await daemon.close();
  }
});

await testUnixSocket("超时会抛错（设备卡住时不至于无限等）", async () => {
  const daemon = await fakeDaemon(() => null); // 连着但不回 → 只能被超时打断
  try {
    await assert.rejects(
      () => callDaemon("device.io.tap", {}, { socketPath: daemon.socketPath, timeoutMs: 250 }),
      /超时/u,
    );
  } finally {
    await daemon.close();
  }
});

await test("路由真正走 RPC，且 rotate 回退 CLI", async () => {
  /**
   * 单元测试证明协议对了，这条证明**接线**对了：
   * 经真实 StreamRoutes 发一次 tap，应当调 RPC 而不是 CLI。
   * 用桩 RPC 记录调用，用桩 client 记录 CLI 调用。
   */
  const rpcCalls = [];
  const cliCalls = [];
  const stubRpc = {
    available: true,
    async call(method, params) { rpcCalls.push({ method, params }); return { status: "ok" }; },
  };
  const client = {
    async listDevices() { return [{ id: "d1", name: "d", platform: "android", state: "online" }]; },
    async runJson(args) { cliCalls.push(args.join(" ")); return {}; },
  };
  const pool = { acquire: () => ({ sendInput: (run, input) => run(["io", input.action]) }) };
  const routes = new StreamRoutes({
    client, pool, access: { mint: () => "t" }, log: () => {}, rpc: stubRpc,
  });
  routes.activeDeviceId = "d1";

  const post = async (route, body) => {
    const req = new Readable({ read() {} });
    req.method = "POST";
    req.url = `/${route}`;
    req.headers = {
      host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
      "content-type": "application/json",
    };
    req.socket = { remoteAddress: "127.0.0.1" };
    const res = {
      statusCode: 0, body: "", headersSent: false,
      writeHead(c) { this.statusCode = c; this.headersSent = true; },
      end(p) { this.body = p ?? ""; },
      write() {}, on() {}, setHeader() {},
    };
    req.push(Buffer.from(JSON.stringify(body)));
    req.push(null);
    await routes.handle(route, req, res);
    return res;
  };

  // tap → 应走 RPC
  let res = await post("control", { action: "tap", x: 10, y: 20 });
  assert.equal(res.statusCode, 200);
  assert.equal(rpcCalls.length, 1, `tap 应走 RPC，实际 rpc=${rpcCalls.length} cli=${cliCalls.length}`);
  assert.equal(rpcCalls[0].method, "device.io.tap");
  assert.deepEqual(rpcCalls[0].params, { deviceId: "d1", x: 10, y: 20 });
  assert.equal(cliCalls.length, 0, "走通 RPC 时不该再调 CLI");

  // back → 应走 RPC
  res = await post("device-action", { action: "back" });
  assert.equal(res.statusCode, 200);
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[1].method, "device.io.button");
  assert.equal(rpcCalls[1].params.button, "BACK");

  // rotate → daemon 没有该方法，必须回退 CLI
  const before = cliCalls.length;
  res = await post("device-action", { action: "rotate" });
  assert.equal(res.statusCode, 200);
  assert.equal(
    rpcCalls.length, 2,
    "rotate 不该走 RPC —— daemon 不暴露 orientation（实测 method not found）",
  );
  assert.ok(cliCalls.length > before, "rotate 应当回退到 CLI");
});

await test("RPC 在连接建立前失败时回退 CLI", async () => {
  const cliCalls = [];
  const stubRpc = {
    available: true,
    async call() {
      this.available = false;
      throw Object.assign(new Error("daemon socket denied"), { code: "EACCES" });
    },
  };
  const client = {
    async listDevices() { return [{ id: "d1", name: "d", platform: "android", state: "online" }]; },
    async runJson(args) { cliCalls.push(args.join(" ")); return {}; },
  };
  const pool = { acquire: () => ({ sendInput: (run, input) => run(["io", input.action]) }) };
  const warns = [];
  const routes = new StreamRoutes({
    client, pool, access: { mint: () => "t" },
    log: (level, msg) => warns.push(`${level}:${msg}`), rpc: stubRpc,
  });
  routes.activeDeviceId = "d1";

  const req = new Readable({ read() {} });
  req.method = "POST";
  req.url = "/control";
  req.headers = {
    host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = {
    statusCode: 0, body: "", headersSent: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(p) { this.body = p ?? ""; },
    write() {}, on() {}, setHeader() {},
  };
  req.push(Buffer.from(JSON.stringify({ action: "tap", x: 1, y: 2 })));
  req.push(null);
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 200, "RPC 失败不该让用户看到错误");
  assert.ok(cliCalls.length > 0, "应当回退到 CLI");
  assert.ok(warns.some((w) => w.includes("回退 CLI")), "应记录回退日志，便于排查");
});

await test("RPC 回包不明时不回退，避免重复点击", async () => {
  const cliCalls = [];
  const stubRpc = {
    available: true,
    async call() {
      this.available = false;
      throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
    },
  };
  const client = {
    async runJson(args) { cliCalls.push(args.join(" ")); return {}; },
  };
  const pool = { acquire: () => ({ sendInput: (run, input) => run(["io", input.action]) }) };
  const routes = new StreamRoutes({ client, pool, access: { mint: () => "t" }, log: () => {}, rpc: stubRpc });
  routes.activeDeviceId = "d1";
  const req = new Readable({ read() {} });
  req.method = "POST";
  req.url = "/control";
  req.headers = {
    host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = {
    statusCode: 0, body: "", headersSent: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(p) { this.body = p ?? ""; },
    write() {}, on() {}, setHeader() {},
  };
  req.push(Buffer.from(JSON.stringify({ action: "tap", x: 1, y: 2 })));
  req.push(null);
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(cliCalls.length, 0, "结果不明时不能重新执行同一个 tap");
});

await test("rpc 为 null 时全部走 CLI（配置可强制关闭）", async () => {
  const cliCalls = [];
  const client = {
    async listDevices() { return [{ id: "d1", name: "d", platform: "android", state: "online" }]; },
    async runJson(args) { cliCalls.push(args.join(" ")); return {}; },
  };
  const pool = { acquire: () => ({ sendInput: (run, input) => run(["io", input.action]) }) };
  const routes = new StreamRoutes({ client, pool, access: { mint: () => "t" }, log: () => {}, rpc: null });
  routes.activeDeviceId = "d1";

  const req = new Readable({ read() {} });
  req.method = "POST";
  req.url = "/control";
  req.headers = {
    host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1" };
  const res = {
    statusCode: 0, body: "", headersSent: false,
    writeHead(c) { this.statusCode = c; this.headersSent = true; },
    end(p) { this.body = p ?? ""; },
    write() {}, on() {}, setHeader() {},
  };
  req.push(Buffer.from(JSON.stringify({ action: "tap", x: 1, y: 2 })));
  req.push(null);
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(cliCalls.length, 1, "rpc=null 时必须走 CLI");
});

// ── 设备类型可辨识 ──────────────────────────────────────────────────────
//
// 用户反馈：「机型选择里面应该加入模拟器选项才对，现在这 2 个选项我没办法
// 区分哪个是模拟器哪个是真机」。
//
// 设备数据里本来就有 `type`（mobilecli 的 `--type` 帮助原文：
// `real or simulator/emulator`），只是面板没用它 —— 下拉里只显示名字。
//
// 这一组守两件事：① 下拉里必须能看出类型；② 类型映射只有一处，
// 避免"下拉说是模拟器、状态栏说是 real"这种自相矛盾。

console.log("\n设备类型可辨识");

await test("类型映射：real/simulator/emulator 都有中文名，未知值不猜", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  const fn = source.match(/function deviceKindLabel\([\s\S]*?\n    \}/u)?.[0] ?? "";
  assert.ok(fn.length > 0, "找不到 deviceKindLabel");
  assert.ok(/=== "real"/u.test(fn), "real 应有专门分支");
  assert.ok(/"simulator"/u.test(fn) && /"emulator"/u.test(fn), "simulator 与 emulator 都要认");
  assert.ok(fn.includes("真机") && fn.includes("模拟器"), "应有中文名");
  // 未知值必须原样返回而不是猜一个 —— 猜错会误导用户
  assert.ok(
    !/return "真机";\s*\}\s*$/u.test(fn.replace(/\s+/gu, " ").trim()),
    "不能把未知类型兜底成「真机」",
  );
});

await test("下拉选项带类型后缀（否则模拟器与真机无法区分）", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  assert.ok(source.includes("deviceKindSuffix"), "缺类型后缀函数");
  assert.ok(source.includes("deviceOptionText"), "缺选项文案函数");
  // 选项文案里必须真的用了后缀
  const fn = source.match(/function deviceOptionText\([\s\S]*?\n    \}/u)?.[0] ?? "";
  assert.ok(fn.includes("deviceKindSuffix"), "选项文案没有拼上类型后缀");
});

await test("多种类型时按类型分组，单一类型时不加多余分组", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  const fn = source.match(/function renderDeviceOptions\([\s\S]*?\n    \}/u)?.[0] ?? "";
  assert.ok(fn.length > 0, "找不到 renderDeviceOptions");
  assert.ok(fn.includes("optgroup"), "应使用 optgroup 分组");
  assert.ok(
    /length <= 1/u.test(fn),
    "只有一种类型时不该分组（多余层级），但要保留选项里的类型后缀",
  );
  // 分组时不再重复后缀（否则「真机 / 一加 12 · 真机」很啰嗦）
  assert.ok(/deviceOptionText\(d, false\)/u.test(fn), "分组内应关掉类型后缀，避免与分组标题重复");
  assert.ok(/deviceOptionText\(d, true\)/u.test(fn), "不分组时应保留类型后缀");
});

await test("状态栏用同一个映射（避免与下拉自相矛盾）", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  // 状态栏不能再用裸的 active.type
  assert.ok(
    !/\$\{active\.type\}/u.test(source),
    "状态栏仍显示裸的 active.type（英文 real/simulator），应与下拉用同一映射",
  );
  assert.ok(/deviceKindLabel\(active\.type\)/u.test(source), "状态栏应走 deviceKindLabel");
});

// ── 离线设备可选中 + 自动启动 ───────────────────────────────────────────
//
// 用户问："USB 连一台真机，iPhone 17 Pro 模拟器没启动属于离线状态，
// 点击可以启动吗？"
//
// 查下来这里有个**自相矛盾的 bug**：面板的设备列表来自 #status
// （includeOffline:true，所以用户看得见那台关着的模拟器），
// 但点它时走 #grant（默认**不含**离线）→ 查不到 → 回 "未找到设备：<id>"。
// 用户视角就是"列表里明明有，点了却说没有"。

console.log("\n离线设备");

await test("grant 必须包含离线设备（否则与面板列表自相矛盾）", () => {
  const source = stripComments(readFileSync(new URL("./lib/stream/routes.js", import.meta.url), "utf8"));
  const grant = source.slice(source.indexOf("async #grant"));
  const head = grant.slice(0, grant.indexOf("#status") === -1 ? 2000 : 2000);
  assert.ok(
    /listDevices\(\{\s*includeOffline:\s*true\s*\}\)/u.test(head),
    "grant 用了不含离线的 listDevices —— 面板看得到却选不中",
  );
});

await test("选中离线模拟器会自动启动，且 boot 失败不影响选中", () => {
  const source = stripComments(readFileSync(new URL("./lib/stream/routes.js", import.meta.url), "utf8"));
  // 只有虚拟设备才 boot（真机 boot 无意义）
  assert.ok(/"simulator"/u.test(source) && /"emulator"/u.test(source), "应识别 simulator 与 emulator");
  assert.ok(/device", "boot"/u.test(source), "应调用 device boot");
  assert.ok(source.includes("BOOT_TIMEOUT_MS"), "启动要有超时（冷启动可达数分钟）");
  // 失败不能吞掉 grant 成功
  assert.ok(source.includes("bootError"), "启动失败应通过 bootError 如实返回，而不是让选中失败");
});

await test("面板会提示正在启动（冷启动数分钟，否则看起来像卡死）", () => {
  const source = stripComments(readFileSync(new URL("./lib/client.js", import.meta.url), "utf8"));
  assert.ok(source.includes("setBooting"), "缺启动中的状态");
  /**
   * ⚠️ 不要断言裸短语 `正在启动设备` —— CSS 注释里也有同样的词
   * （CSS 在模板字符串里，stripComments 不会剥它），于是断言会被注释满足：
   * 真删掉 UI 文案，测试照样通过（实测确认过这个假阴性）。
   *
   * 所以断言**那个 h(...) 调用里的完整文案**，也就是真正渲染出去的那句。
   */
  assert.ok(
    /"mbm-dot", "data-on": "2" \}\),\s*"正在启动设备/u.test(source),
    "应在状态栏渲染出启动提示（不能只在注释里提到）",
  );
  assert.ok(
    /data-on": "2"/u.test(source),
    "启动状态应有独立的视觉标识（不能和「未串流」混在一起）",
  );
  // bootError 要显示给用户
  assert.ok(source.includes("bootError"), "bootError 应显示给用户，否则黑屏无解释");
});

// ── 客户端源码与构建 ────────────────────────────────────────────────────
//
// 客户端现在是「源码 + 产物」两分：src/client/ 手写，lib/client.js 由
// scripts/build-client.mjs 生成且**提交进仓库**（安装方是 git 依赖，这样
// 他们不需要工具链）。产物会漂移，所以 build:check 在 verify 里拦它。
//
// 下面这些守的是"源码该长什么样"：用了 JSX 就别再退回手写 h(...)，
// 样式就该待在 styles.css 里。

console.log("\n客户端源码与构建");

const SRC_CLIENT = new URL("./src/client/index.jsx", import.meta.url);
const SRC_STYLES = new URL("./src/client/styles.css", import.meta.url);

await test("客户端源码用 JSX，没有手写 h(...) 调用", () => {
  const source = stripComments(readFileSync(SRC_CLIENT, "utf8"));
  // 只找真正的调用（排除 hintText( / fetch( 这类同尾名）
  const calls = source.match(/(?:^|[^\w.$])h\(/gmu) ?? [];
  assert.equal(
    calls.length, 0,
    `还有 ${calls.length} 处手写 h(...)。源码是 JSX，新增元素请用 JSX 写`
      + `（产物里的 h(...) 是构建产生的，不要直接改 lib/client.js）。`,
  );
});

await test("样式在 styles.css 里，没有留在 JSX 源码中", () => {
  const jsx = stripComments(readFileSync(SRC_CLIENT, "utf8"));
  // JSX 侧只应保留占位符，不应再出现真实 CSS 规则
  assert.ok(jsx.includes("__CLIENT_CSS__"), "缺少 CSS 占位符，样式不会被注入");
  assert.ok(
    !/\.mbm-[a-z-]+\s*\{/u.test(jsx),
    "JSX 源码里出现了 CSS 规则 —— 样式应写在 src/client/styles.css",
  );
  const css = readFileSync(SRC_STYLES, "utf8");
  assert.ok(css.includes(".mbm-root"), "styles.css 里找不到面板根样式");
});

await test("构建配置守住两条易错项（utf8 与 jsxFactory=h）", () => {
  const source = stripComments(readFileSync(new URL("./scripts/build-client.mjs", import.meta.url), "utf8"));
  // esbuild 默认 charset=ascii，会把中文转义成 \uXXXX，产物没法读
  assert.ok(/charset:\s*"utf8"/u.test(source), "构建没设 charset=utf8，产物里的中文会被转义");
  // jsxFactory=h 让产物与改造前同构，既有断言测试才继续有效
  assert.ok(/jsxFactory:\s*"h"/u.test(source), "构建没把 JSX 编译成 h(...)");
  // 必须用 esbuild。
  //
  // ⚠️ 断言"用了 esbuild"这件事，**不要**钉死 import 写法：脚本里现在是
  // `await import("esbuild")`（动态导入，好让缺依赖时给出可读提示而不是裸栈）。
  // 只认 `from "esbuild"` 的话，改成动态导入就会无谓地变红 —— 实测踩过。
  assert.ok(
    /import\(\s*"esbuild"\s*\)|from "esbuild"/u.test(source),
    "构建没有用 esbuild",
  );
  // 必须是 transform（只转译），不是 build（会打包并试图解析 react）
  assert.ok(!/\bbuild\s*\(/u.test(source), "不要用 esbuild 的 build()：会把 react 打进产物，违反 bundle purity");
});

await test("lib 按职责分目录，且只有 client.js 留在根下", () => {
  // fs 直接接受 URL 对象，省掉 dirname(fileURLToPath(...)) 那串转换
  const loose = readdirSync(new URL("./lib", import.meta.url), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  assert.deepEqual(
    loose, ["client.js"],
    "lib/ 根下只应有构建产物 client.js；其余模块按 device/ stream/ agent/ 归位",
  );
  for (const dir of ["device", "stream", "agent"]) {
    assert.ok(existsSync(new URL(`./lib/${dir}`, import.meta.url)), `缺少 lib/${dir}/`);
  }
});

// ── 流参数与坐标换算 ─────────────────────────────────────────────────
//
// 背景（实测）：侧边栏画布后备存储只有 630×1400 物理像素，而设备是 1080×2376
// —— 2.9 倍过采样，解码与纹理上传都在为看不见的像素买单。按画布宽度给
// `--scale` 后编码器真的改分辨率（SPS 实测 1.0→1080×2376、0.5→540×1188）。
//
// 一旦按 scale 编码，客户端报的坐标就是**帧像素**，必须换回设备像素，
// 否则所有点击都会按 1/scale 的比例系统性偏移（0.5 时点右上角会点到屏幕外）。
// 这组用例锁的就是这个换算。

console.log("\n流参数与坐标换算");

await test("scale=1 时坐标原样透传", () => {
  const input = { action: "tap", x: 100, y: 200 };
  const out = toDeviceCoordinates(input, { scale: 1, deviceWidth: 1080, deviceHeight: 2376 });
  assert.deepEqual(out, { action: "tap", x: 100, y: 200 });
  assert.notEqual(out, input, "应当返回新对象，不要改调用方的输入");
});

await test("scale=0.5 时帧像素 ×2 换回设备像素", () => {
  const out = toDeviceCoordinates({ action: "tap", x: 315, y: 700 }, {
    scale: 0.5,
    deviceWidth: 1080,
    deviceHeight: 2376,
  });
  assert.equal(out.x, 630, "x=315 在 0.5 缩放下对应设备像素 630");
  assert.equal(out.y, 1400, "y=700 在 0.5 缩放下对应设备像素 1400");
});

await test("swipe 的四个点都要换算（少一个就会从错的位置起手）", () => {
  const out = toDeviceCoordinates(
    { action: "swipe", x1: 100, y1: 100, x2: 200, y2: 300, duration: 300 },
    { scale: 0.5, deviceWidth: 1080, deviceHeight: 2376 },
  );
  assert.deepEqual(
    { x1: out.x1, y1: out.y1, x2: out.x2, y2: out.y2 },
    { x1: 200, y1: 200, x2: 400, y2: 600 },
  );
  assert.equal(out.duration, 300, "duration 不是坐标，不该被动到");
});

await test("换算结果夹在屏幕范围内（点边缘不至于越界）", () => {
  // 帧宽 630 → 设备 x 上限 1079；x=700 会算出 1400，必须夹住
  const out = toDeviceCoordinates({ action: "tap", x: 700, y: 5 }, {
    scale: 0.5,
    deviceWidth: 1080,
    deviceHeight: 2376,
  });
  assert.equal(out.x, 1079, "x 应夹到 deviceWidth-1");
  assert.equal(out.y, 10, "未越界的坐标不该被改");

  const negative = toDeviceCoordinates({ action: "tap", x: -20, y: -20 }, { scale: 1, deviceWidth: 1080 });
  assert.deepEqual({ x: negative.x, y: negative.y }, { x: 0, y: 0 }, "负坐标夹到 0");
});

await test("屏幕高度未知时不能夹 y（否则下半屏点不到）", () => {
  // 只有 deviceWidth（例如 device.info 只回了宽）时，y 不做上界夹取：
  // 把 2376 高的屏按 1080 夹，等于"下半屏永远点不到"。
  const out = toDeviceCoordinates({ action: "tap", x: 10, y: 2000 }, { scale: 1, deviceWidth: 1080 });
  assert.equal(out.y, 2000, "y 不该被 deviceWidth 夹住");
});

await test("plan 缺失时按不缩放处理（流还没 grant 过）", () => {
  assert.deepEqual(
    toDeviceCoordinates({ action: "tap", x: 12, y: 34 }, null),
    { action: "tap", x: 12, y: 34 },
  );
  assert.deepEqual(
    toDeviceCoordinates({ action: "tap", x: 12, y: 34 }, { scale: 0 }),
    { action: "tap", x: 12, y: 34 },
    "非法 scale 不能当 0 去除（会除出 Infinity）",
  );
});

await test("control 路由按流的真实 plan 换算坐标（不是按请求体）", async () => {
  const rpcCalls = [];
  const client = {
    async listDevices() { return [{ id: "d1", name: "一加 12", platform: "android", state: "online" }]; },
    async runJson() { throw new Error("这条路径不该走 CLI"); },
  };
  const routes = new StreamRoutes({
    client,
    pool: { acquire: () => ({ sendInput: async () => {} }) },
    access: { mint: () => "t" },
    rpc: {
      available: true,
      async call(method, params) { rpcCalls.push({ method, params }); return {}; },
    },
    log: () => {},
  });
  routes.activeDeviceId = "d1";
  routes.streamPlans.set("d1", { scale: 0.5, deviceWidth: 1080, deviceHeight: 2376 });

  const { req, res } = latencyReqRes({ action: "tap", x: 315, y: 700 });
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 200, `应当成功，实际 ${res.statusCode} ${res.body}`);
  assert.equal(rpcCalls.length, 1, "应当走一次 RPC");
  assert.equal(rpcCalls[0].method, "device.io.tap");
  assert.deepEqual(
    rpcCalls[0].params,
    { deviceId: "d1", x: 630, y: 1400 },
    "坐标必须按流的 scale 换算成设备像素；按帧像素送给设备会点偏一半屏幕",
  );
});

// ── 自适应取流 ────────────────────────────────────────────────────────
//
// 真机 bug：`--scale` 只在 /grant 那一刻按 preferredWidth 算一次，之后永不重算。
// 用户把侧边栏拖宽、或把窗口从 1920×1080 外接屏（DPR 1）拖到内建 Retina（DPR 2），
// 需要的物理像素都变大了，流却还是老分辨率 —— 实测面板里手机屏幕区 598 物理像素，
// 编码进程只有 378×832（scale 0.35），被浏览器放大 1.58× 画上去，文字边缘全是插值糊。
//
// 判定数学（阈值 / 持续时间 / 冷却 / 设备宽封顶）全在 src/client/index.jsx 的
// 两个纯函数里，通过 plugin.__test 暴露出来。这里按 250ms 节拍喂时间戳，
// 断言"什么时候该重建流"，不需要渲染 React、也不需要等真实时间。

console.log("\n自适应取流");

const { decideRegrant, newRegrantStreak, neededPixelWidth, tuning } = client.plugin.__test;

/**
 * 把一段时间喂给判定器，返回**第一次**点头的时刻（never = null）。
 *
 * @param {{needPx: number, framePx: number, ms: number, lastAt?: number, start?: number}} spec
 */
function firstRegrantAt({ needPx, framePx, ms, lastAt = 0, start = 1000 }) {
  const streak = newRegrantStreak();
  for (let t = start; t <= start + ms; t += tuning.tickMs) {
    if (decideRegrant(streak, needPx, framePx, t, lastAt)) return t;
  }
  return null;
}

await test("帧宽比需要的小 15% 以上、且持续 600ms → 重建流（升档）", () => {
  // 真机那组数字：面板需要 630 物理像素，流只有 378 宽（≈0.6 倍）
  const at = firstRegrantAt({ needPx: 630, framePx: 378, ms: 3000 });
  assert.notEqual(at, null, "分辨率差 40% 还不重建，画面会一直是糊的");
  assert.ok(
    at - 1000 >= tuning.upscaleHoldMs,
    `必须持续 ${tuning.upscaleHoldMs}ms 才动手，否则拖动侧边栏会连续重建流（实际 ${at - 1000}ms）`,
  );
});

await test("帧比画布小 10% 就要重建（1.10× 放大正好把文字边缘抹平）", () => {
  // 真机现场那组数字：画布 596 物理像素、流 540 宽 → 596/540 ≈ 1.104。
  // 这里原来断言"差 10% 不动手"，正是它让文字一直糊着（旧阈值 1.15）。
  const at = firstRegrantAt({ needPx: 596, framePx: 540, ms: 3000 });
  assert.notEqual(at, null, "差 10% 就是浏览器放大 1.10×，必须补分辨率");
  assert.notEqual(firstRegrantAt({ needPx: 630, framePx: 573, ms: 5000 }), null);
});

await test("只差 1% 以内不动手（scale 量化与宏块对齐的回差）", () => {
  // Host 把 scale 截到 3 位小数、编码器再按宏块对齐，回包宽度常比请求小 1-2px。
  // 这种量级反复重建只会闪屏，什么也换不来。
  assert.equal(firstRegrantAt({ needPx: 596, framePx: 594, ms: 10000 }), null);
  assert.equal(firstRegrantAt({ needPx: 600, framePx: 596, ms: 10000 }), null);
});

await test("两次重建流之间至少隔 5 秒（grant 会杀进程重启，不能连打）", () => {
  // 假设 1000ms 那一刻刚 grant 过，之后立刻就该升档 —— 但要等到 6000 才允许
  const at = firstRegrantAt({ needPx: 630, framePx: 378, ms: 8000, lastAt: 1000 });
  assert.notEqual(at, null, "冷却过后应该还是会把欠缺的分辨率补回来");
  assert.ok(
    at - 1000 >= tuning.minIntervalMs,
    `冷却期内不许再 grant（实际间隔 ${at - 1000}ms，要求 ≥ ${tuning.minIntervalMs}ms）`,
  );
});

await test("首帧之前（framePx=0）不做任何判定，避免刚 grant 完就重复申请", () => {
  const streak = newRegrantStreak();
  for (let t = 1000; t <= 20000; t += tuning.tickMs) {
    assert.equal(decideRegrant(streak, 630, 0, t, 0), false);
  }
  // 面板宽高还没量出来（needPx=0）同理
  assert.equal(firstRegrantAt({ needPx: 0, framePx: 378, ms: 8000 }), null);
});

await test("流大于需要 1.6 倍且持续 3 秒才降档，1.3 倍落在死区不动", () => {
  // 700 / 400 = 1.75 > 1.6：该降档，但降档的持续时间门槛是 3 秒（升档只要 0.6 秒）
  assert.equal(
    firstRegrantAt({ needPx: 400, framePx: 700, ms: 2000 }),
    null,
    "降档只是省资源，2 秒就动手的话用户正把面板拖宽时会被反复打断",
  );
  assert.notEqual(firstRegrantAt({ needPx: 400, framePx: 700, ms: 5000 }), null);

  // 600 / 450 = 1.33，在 1.6 以下 —— 死区，永远不动（否则拖一格就升、拖回来就降）
  assert.equal(firstRegrantAt({ needPx: 450, framePx: 600, ms: 10000 }), null);
});

await test("需要的像素 = CSS 宽 × 当前 DPR，且被设备宽封顶", () => {
  // 面板 300 CSS 宽、Retina 2× → 600 物理像素
  assert.equal(neededPixelWidth(300, 2, 0), 600);
  assert.equal(neededPixelWidth(200, 2, 0), 400);
  // DPR 1 的外接屏：同样 300 CSS，物理像素只有 300
  assert.equal(neededPixelWidth(300, 1, 0), 300);
  // 设备宽 720 时，需要 800 也只能报 720 —— 报多了 Host 会 clamp 到 scale=1，
  // 像素一个都拿不到，却会让判定一直以为"还不够清晰"，每次冷却都白申请一遍。
  assert.equal(neededPixelWidth(400, 2, 720), 720);
  assert.equal(neededPixelWidth(300, 2, 720), 600, "没超过设备宽时不该被截短");
  // 没量到尺寸时返回 0（调用方据此不发 preferredWidth，让 Host 走默认）
  assert.equal(neededPixelWidth(0, 2, 0), 0);
});

await test("重新申请流不重挂画面组件（key 不含 token，否则每次都会黑一下）", () => {
  const bundle = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  assert.ok(
    /key: activeId (\?\?|!== null)/u.test(bundle),
    "StreamView 的 key 必须只由设备决定；把 token 拼进去会让每次重建流都重挂 canvas，"
      + "画布上留着的上一帧随之丢失（黑一下再出图）",
  );
});
await test("Host 不肯重建会话时冷却翻倍，别每 5 秒闪一次屏", () => {
  // Host 的 StreamPool 对已在跑的会话**不重启编码器**（新 scale 只对下一个会话生效），
  // 所以"拖宽面板 → 重新 grant"很可能什么都没换来，只换来一次重连闪屏。
  // 这种情况必须退避，否则就是每 5 秒把画面掐一次。
  const { nextCooldownMs, nextCooldownAfterGrant } = client.plugin.__test;

  // 申请 600px、Host 实际只给 378px（老会话的 scale=0.35）→ 明显没升上去
  let cooldown = tuning.minIntervalMs;
  cooldown = nextCooldownAfterGrant(cooldown, 600, 378);
  assert.ok(cooldown > tuning.minIntervalMs, `没升上去就该退避，实际仍是 ${cooldown}ms`);
  for (let i = 0; i < 10; i += 1) cooldown = nextCooldownAfterGrant(cooldown, 600, 378);
  assert.equal(cooldown, tuning.cooldownMaxMs, "退避要有上限，否则一次失败后永远不再尝试");
  assert.ok(tuning.cooldownMaxMs >= 30000, "上限太短等于还在闪屏");

  // Host 给了想要的宽度（或者更高）→ 回落到基准冷却
  assert.equal(nextCooldownAfterGrant(tuning.cooldownMaxMs, 600, 600), tuning.minIntervalMs);
  assert.equal(nextCooldownAfterGrant(tuning.cooldownMaxMs, 600, 720), tuning.minIntervalMs);
  // 回包比请求小 1% 以内 → 算成功（量化/宏块对齐的正常回差，不该退避）
  assert.equal(nextCooldownAfterGrant(tuning.cooldownMaxMs, 600, 596), tuning.minIntervalMs);
  // 但回包明显更小（600 只给 560）→ 就是没升上去，必须退避
  assert.ok(
    nextCooldownAfterGrant(tuning.cooldownMaxMs, 600, 560) > tuning.minIntervalMs,
    "欠 7% 仍然是浏览器放大，不能当成成功去重置冷却",
  );
  // 信息不全（旧 Host 不回 deviceWidth/scale）→ 不猜，按基准走
  assert.equal(nextCooldownAfterGrant(tuning.cooldownMaxMs, 600, 0), tuning.minIntervalMs);
  assert.equal(nextCooldownAfterGrant(tuning.cooldownMaxMs, 0, 378), tuning.minIntervalMs);
  // 翻倍函数本身：从 0 起步也要给出基准值，不能返回 0（否则再没有冷却）
  assert.equal(nextCooldownMs(0), tuning.minIntervalMs);
  assert.equal(nextCooldownMs(tuning.cooldownMaxMs), tuning.cooldownMaxMs);
});

await test("退避后的冷却期真的会推迟下一次申请", () => {
  const { decideRegrant: decide, newRegrantStreak: newStreak } = client.plugin.__test;
  const streak = newStreak();
  // 1000ms 刚 grant 过；按 60 秒冷却，5 秒时不该动手，61 秒才该
  let approvedAt = null;
  for (let t = 1000; t <= 62000; t += tuning.tickMs) {
    if (decide(streak, 630, 378, t, 1000, tuning.cooldownMaxMs)) { approvedAt = t; break; }
  }
  assert.notEqual(approvedAt, null, "退避不等于放弃，冷却过了还是要补分辨率");
  assert.ok(
    approvedAt - 1000 >= tuning.cooldownMaxMs,
    `冷却期是 ${tuning.cooldownMaxMs}ms，实际 ${approvedAt - 1000}ms 就动手了`,
  );
});


/**
 * 起一个只会回 `daemon.status` 的假 daemon。
 * @param {string} socketPath
 * @returns {Promise<{close: () => Promise<void>}>}
 */
function startFakeDaemon(socketPath) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newline));
      } catch {
        socket.destroy();
        return;
      }
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { version: "1.0.19" } })}\n`);
      // 与真 daemon 一致：回完就主动关（一请求一连接）
      socket.end();
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

await test("连接失败后按退避自动恢复（不必等 CLI 来救）", async () => {
  const home = mkdtempSync(join(import.meta.dirname, ".tmp-rpc-test-"));
  const socketPath = join(home, "daemon.sock");
  const logs = [];
  const rpc = new DaemonRpc({
    home,
    recoveryBackoffMs: [20, 40],
    log: (level, message) => logs.push(`${level}:${message}`),
  });

  try {
    // ① 没有 daemon：连接层失败 → 通道停用，但不该是"永久"
    await assert.rejects(rpc.call("device.io.tap", {}), /ENOENT|daemon/);
    assert.equal(rpc.available, false, "连接层失败后应标记不可用（避免每次点击白等）");

    // ② daemon 起来了（等价于 CLI 把它拉起来）
    const daemon = await startFakeDaemon(socketPath);

    // ③ 退避探测（20ms 档）应当自动把通道救回来
    const deadline = Date.now() + 2000;
    while (!rpc.available && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(rpc.available, true, "daemon 回来后通道应当自动恢复，否则整场会话都在走 CLI");
    assert.ok(
      logs.some((line) => line.includes("恢复")),
      `恢复应当留一条日志，实际日志：${logs.join(" | ") || "(空)"}`,
    );

    await daemon.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

await test("prewarm 让第一次点击就走 RPC（冷启动不再先吃一次 CLI）", async () => {
  const home = mkdtempSync(join(import.meta.dirname, ".tmp-rpc-warm-"));
  const socketPath = join(home, "daemon.sock");
  const rpc = new DaemonRpc({ home, log: () => {} });
  const daemon = await startFakeDaemon(socketPath);

  try {
    assert.equal(await rpc.prewarm(), true, "daemon 在跑时预热应当成功");
    assert.equal(rpc.available, true);
    const result = await rpc.call("device.io.tap", {});
    assert.deepEqual(result, { version: "1.0.19" });
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

await test("CLI 兜底成功后立刻恢复通道（下一次点击回到 RPC）", async () => {
  // 通道已标记不可用，但 CLI 能跑通 —— 说明 daemon 已经被 CLI 拉起来了。
  const resets = [];
  let cliCalls = 0;
  const client = {
    async listDevices() { return [{ id: "d1", name: "一加 12", platform: "android", state: "online" }]; },
    async runJson() { cliCalls += 1; return {}; },
  };
  const routes = new StreamRoutes({
    client,
    pool: { acquire: () => ({ sendInput: (run) => run(["io", "tap", "--device", "d1", "1,2"]) }) },
    access: { mint: () => "t" },
    rpc: {
      available: false,
      async call() { throw new Error("不该走 RPC"); },
      reset() { resets.push("reset"); this.available = true; },
    },
    log: () => {},
  });
  routes.activeDeviceId = "d1";

  const { req, res } = latencyReqRes({ action: "tap", x: 1, y: 2 });
  await routes.handle("control", req, res);

  assert.equal(res.statusCode, 200, `应当成功，实际 ${res.statusCode} ${res.body}`);
  assert.equal(cliCalls, 1, "通道不可用时应当走 CLI");
  assert.deepEqual(resets, ["reset"], "CLI 成功后必须恢复通道，否则永远退化在 CLI 上");
});

// ── 自适应取流：同一设备按新 scale 重建会话 ──────────────────────────────
//
// 用户最初的抱怨是"画面糊"。客户端把取流改成"按画布物理像素 1:1"之后，
// 拖宽面板会带着更大的 preferredWidth 重新 grant —— 但会话池原先对已存在的
// 会话一律"缩放变化延后生效"，于是 re-grant 换不来分辨率：真机现场跑着
// --scale 0.35（编码 378×832）铺 598×1322 的画布，放大 1.58×，文字必糊。
// 这一段锁的是"该重建时真重建、不该重建时一次也别多"。

console.log("\n自适应取流重建");

/** 造一个只记录 spawn 参数的池（进程用假替身，不碰设备）。 */
function restartPool(log = () => {}) {
  const spawnScales = [];
  const pool = new StreamSessionPool({
    spawnFor: (_deviceId, options) => {
      spawnScales.push(options?.scale);
      return fakeStream().proc;
    },
    idleStopMs: 100_000,
    log,
  });
  return { pool, spawnScales };
}

await test("acquire 不传 restart 时不会为新的 scale 换会话（现有行为不变）", () => {
  const { pool } = restartPool();
  const first = pool.acquire("dev-1", { scale: 0.35 });
  const second = pool.acquire("dev-1", { scale: 0.9 });

  assert.equal(second, first, "没有重启意图时必须复用旧会话");
  assert.equal(first.scale, 0.35, "旧会话的 scale 不能被悄悄改掉（坐标是按它换算的）");
  assert.equal(first.stopped, false);
  pool.stopAll();
});

await test("restart:true 且缩放差异 1.58× → 停旧会话、按新 scale 建新会话", () => {
  const { pool, spawnScales } = restartPool();
  const old = pool.acquire("dev-1", { scale: 0.35 });
  old.addConsumer(() => {});
  assert.deepEqual(spawnScales, [0.35], "旧会话应按旧 scale 起进程");

  const next = pool.acquire("dev-1", { scale: 0.554, restart: true });
  assert.notEqual(next, old, "差异 1.58× 且允许重启时必须重建");
  assert.ok(old.stopped, "旧会话必须进入终态，否则两路编码同时跑");
  assert.equal(pool.sessions.get("dev-1"), next);
  assert.equal(next.scale, 0.554, "新会话要带新 scale");

  next.addConsumer(() => {});
  assert.deepEqual(spawnScales, [0.35, 0.554], `两次 spawn 应分别拿到新旧 scale，实际 ${spawnScales.join(",")}`);
  pool.stopAll();
});

await test("restart:true 且新 scale 更大 10% → 真的重建（这是文字糊的直接成因）", () => {
  // 真机现场：会话在 0.5（编码 540 宽），画布却是 596 物理像素 → 放大 1.10×。
  // 旧阈值 1.15 让这次重建被拒，画面就一直糊着。
  const { pool, spawnScales } = restartPool();
  const old = pool.acquire("dev-1", { scale: 0.5 });
  old.addConsumer(() => {});
  const next = pool.acquire("dev-1", { scale: 0.552, restart: true }); // 1.104×
  assert.notEqual(next, old, "差 10% 就是浏览器放大 1.10×，必须重建");
  assert.ok(old.stopped, "旧会话要进终态，否则两路编码同时跑");
  assert.equal(next.scale, 0.552);
  next.addConsumer(() => {}); // spawn 是懒的：有消费者才起进程
  assert.deepEqual(spawnScales, [0.5, 0.552]);
  pool.stopAll();
});

await test("restart:true 但缩放差异 <1% → 不重启（量化回差，别为 1px 闪屏）", () => {
  const { pool } = restartPool();
  const old = pool.acquire("dev-1", { scale: 0.552 });
  const next = pool.acquire("dev-1", { scale: 0.554, restart: true }); // 1.004×
  assert.equal(next, old, "1% 以内的差异是 scale 量化/宏块对齐的正常回差");
  assert.equal(old.stopped, false);
  pool.stopAll();
});

await test("同一设备 3 秒内只重建一次（挡住拖宽抖动）", () => {
  const { pool } = restartPool();
  const first = pool.acquire("dev-1", { scale: 0.35 });
  const rebuilt = pool.acquire("dev-1", { scale: 0.554, restart: true });
  assert.notEqual(rebuilt, first, "第一次重建应当通过");

  const throttled = pool.acquire("dev-1", { scale: 0.8, restart: true });
  assert.equal(throttled, rebuilt, "3 秒内第二次重建必须被节流，否则编码器被反复杀");
  assert.equal(throttled.scale, 0.554);
  pool.stopAll();
});

await test("会话被主动终结时通知订阅者（否则旧 HTTP 响应要等看门狗）", () => {
  const { pool } = restartPool();
  const session = pool.acquire("dev-1", { scale: 0.35 });
  let notified = 0;
  const subscription = session.addConsumer(() => {}, () => { notified += 1; });

  // 另一个设备的消费者：stop 它时应当收到通知
  const other = pool.acquire("dev-2", { scale: 1 });
  let otherNotified = 0;
  other.addConsumer(() => {}, () => { otherNotified += 1; });
  pool.stop("dev-2");
  assert.equal(otherNotified, 1, "被 stop 的会话必须通知自己的订阅者");

  // 已经退订的消费者不该再收到通知
  subscription.remove();
  pool.stop("dev-1");
  assert.equal(notified, 0, "已经退订的消费者不该再收到通知");
  pool.stopAll();
});

/** 造一次 grant 请求（真 HTTP 语义的 req/res 替身，不建 socket）。 */
function grantReqRes(body) {
  const req = new Readable({ read() {} });
  req.method = "POST";
  req.url = "/grant";
  req.headers = {
    host: "127.0.0.1:19387",
    origin: "http://127.0.0.1:19387",
    "content-type": "application/json",
  };
  req.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" };
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; },
    end(payload) { this.body = payload ?? ""; },
    write() {},
    on() {},
    setHeader() {},
  };
  req.push(Buffer.from(JSON.stringify(body)));
  req.push(null);
  return { req, res };
}

/** grant 用的路由：真池子 + 假 spawn，scale = preferredWidth / 1080（三位小数）。 */
function regrantHarness(log = () => {}) {
  const { pool, spawnScales } = restartPool(log);
  const client = {
    async listDevices() { return [{ id: "d1", name: "一加 12", platform: "android", state: "online" }]; },
    async runJson() { return {}; },
  };
  const routes = new StreamRoutes({
    client,
    pool,
    access: { mint: () => "t" },
    log,
    resolveStreamPlan: async (_deviceId, preferredWidth) => {
      const width = typeof preferredWidth === "number" && preferredWidth > 0 ? preferredWidth : 1080;
      return {
        scale: Math.round((width / 1080) * 1000) / 1000,
        bitrate: null,
        deviceWidth: 1080,
        deviceHeight: 2376,
        preferredWidth: width,
      };
    },
  });

  const grant = async (preferredWidth) => {
    const { req, res } = grantReqRes({ preferredWidth });
    await routes.handle("grant", req, res);
    return { res, json: JSON.parse(res.body) };
  };

  return { routes, pool, spawnScales, grant };
}

await test("同设备 grant 更大的 preferredWidth → 真按新 scale 重建，回包也是新 scale", async () => {
  const { pool, spawnScales, grant } = regrantHarness();

  const first = await grant(378); // 0.35
  assert.equal(first.res.statusCode, 200, `第一次 grant 应当成功，实际 ${first.res.body}`);
  assert.equal(first.json.scale, 0.35, `回包 scale 应为 0.35，实际 ${first.json.scale}`);

  const session = pool.sessions.get("d1");
  session.addConsumer(() => {}); // 面板连上了流 → 编码器在跑
  assert.deepEqual(spawnScales, [0.35]);

  const second = await grant(598); // 0.554，比 0.35 大 1.58×
  assert.equal(second.res.statusCode, 200, `第二次 grant 应当成功，实际 ${second.res.body}`);
  assert.notEqual(pool.sessions.get("d1"), session, "面板变宽后必须重建会话，否则 re-grant 换不来分辨率");
  assert.ok(session.stopped, "旧会话要被停掉");
  assert.equal(second.json.scale, 0.554, `回包必须等于新会话的 scale，实际 ${second.json.scale}`);

  pool.sessions.get("d1").addConsumer(() => {});
  assert.deepEqual(spawnScales, [0.35, 0.554], `第二次 spawn 必须拿到新 scale，实际 ${spawnScales.join(",")}`);
  pool.stopAll();
});

await test("3 秒内第二次 re-grant 被节流：不重建，回包仍是当前流的 scale", async () => {
  const { pool, spawnScales, grant } = regrantHarness();

  await grant(378); // 0.35
  pool.sessions.get("d1").addConsumer(() => {});

  const rebuilt = await grant(598); // 0.554 → 重建（第一次）
  assert.equal(rebuilt.json.scale, 0.554);
  const rebuiltSession = pool.sessions.get("d1");
  // 模拟客户端重连：新会话的第一个消费者拉起新编码器
  rebuiltSession.addConsumer(() => {});
  assert.deepEqual(spawnScales, [0.35, 0.554]);

  // 继续变宽（0.554 → 0.8 是 1.44×，幅度够，但距上次重建不到 3 秒）
  const throttled = await grant(864);
  assert.equal(throttled.json.scale, 0.554, `节流期间回包必须如实反映当前流的 scale，实际 ${throttled.json.scale}`);
  assert.equal(pool.sessions.get("d1"), rebuiltSession, "节流期间不许换会话");
  assert.deepEqual(spawnScales, [0.35, 0.554], `节流期间不许再 spawn，实际 ${spawnScales.join(",")}`);
  pool.stopAll();
});

// 这条是给"重建会不会把用户卡在黑屏"一个真链路的答案：
// 旧 /stream 响应必须被 Host 主动 end（否则浏览器要等看门狗，画面冻住），
// 客户端随后带新 token 重连就能拿到新分辨率的流。
await test("按新缩放重建时旧 /stream 响应主动结束，重连即拿到新流", async () => {
  const PREFIX = "/_dsh/dsh-sidebar-mobile";
  const streams = [];
  const spawnScales = [];
  const pool = new StreamSessionPool({
    spawnFor: (_deviceId, options) => {
      spawnScales.push(options?.scale);
      const stream = fakeStream();
      streams.push(stream);
      return stream.proc;
    },
    idleStopMs: 100_000,
    log: () => {},
  });
  const access = new StreamAccessController({ key: prepareStreamAccessKey() });
  const client = {
    async listDevices() { return [{ id: "d1", name: "一加 12", platform: "android", state: "online" }]; },
    async runJson() { return {}; },
  };
  const routes = new StreamRoutes({
    client,
    pool,
    access,
    log: () => {},
    resolveStreamPlan: async (_deviceId, preferredWidth) => {
      const width = typeof preferredWidth === "number" && preferredWidth > 0 ? preferredWidth : 1080;
      return { scale: Math.round((width / 1080) * 1000) / 1000, bitrate: null, deviceWidth: 1080, deviceHeight: 2376, preferredWidth: width };
    },
  });

  let mounted = null;
  const dispose = mountRoutes(
    { webServer: { register(route) { mounted = route; return () => {}; } } },
    routes,
    PREFIX,
  );
  const server = http.createServer((req, res) => { void mounted.handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;

  /** 等到某个条件成立（HTTP 替身里只能用轮询等状态）。 */
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const mjpegHeader = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n");
  const mjpegFrame = Buffer.concat([mjpegHeader, Buffer.alloc(64, 7), Buffer.from("\r\n")]);

  try {
    // ① 面板第一次连流（画布 378 物理像素 → scale 0.35）
    {
      const { req, res } = grantReqRes({ preferredWidth: 378 });
      await routes.handle("grant", req, res);
      assert.equal(res.statusCode, 200, `首次 grant 应当成功，实际 ${res.body}`);
    }
    const firstUrl = `${base}/stream?token=${encodeURIComponent(access.mint("d1"))}`;
    const pendingFirst = fetch(firstUrl);
    await waitFor(() => pool.sessions.get("d1")?.consumers?.size === 1, "第一次 /stream 订阅");
    streams[0].push(mjpegFrame);
    const firstResponse = await pendingFirst;
    assert.equal(firstResponse.status, 200, "第一次取流应当成功");
    const firstReader = firstResponse.body.getReader();
    const head = await firstReader.read();
    assert.equal(head.done, false, "应当已经收到首块数据");

    // ② 面板变宽 → 重建会话（0.35 → 0.554）
    {
      const { req, res } = grantReqRes({ preferredWidth: 598 });
      await routes.handle("grant", req, res);
      assert.equal(res.statusCode, 200, `重建 grant 应当成功，实际 ${res.body}`);
      const json = JSON.parse(res.body);
      assert.equal(json.scale, 0.554, `重建后回包 scale 应为 0.554，实际 ${json.scale}`);
    }

    // ③ 旧响应必须自己结束：不结束的话浏览器要等看门狗，画面就冻住了
    const ended = await Promise.race([
      firstReader.read().then((r) => r.done),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);
    assert.equal(ended, true, "会话被重建后，旧 /stream 响应必须主动结束（否则画面要冻到看门狗超时）");

    // ④ 客户端带新 token 重连 → 新会话按新 scale 起进程
    const secondUrl = `${base}/stream?token=${encodeURIComponent(access.mint("d1"))}`;
    const pendingSecond = fetch(secondUrl);
    await waitFor(() => streams.length === 2 && pool.sessions.get("d1")?.consumers?.size === 1, "重连后的 /stream 订阅");
    streams[1].push(mjpegFrame);
    const secondResponse = await pendingSecond;
    assert.equal(secondResponse.status, 200, "重连应当拿到新流");
    const secondReader = secondResponse.body.getReader();
    const secondHead = await secondReader.read();
    assert.equal(secondHead.done, false, "新流应当马上出画面");
    assert.deepEqual(spawnScales, [0.35, 0.554], `重连后必须按新 scale 起编码器，实际 ${spawnScales.join(",")}`);

    await secondReader.cancel();
  } finally {
    dispose?.();
    await new Promise((resolve) => server.close(resolve));
    pool.stopAll();
  }
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
