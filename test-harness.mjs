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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { Mobilecli, resolveBinary } from "./lib/mobilecli.js";
import { StreamRoutes } from "./lib/stream-routes.js";
import {
  resolveSocketPath,
  callDaemon,
  rpcForInput,
  rpcForDeviceAction,
  DaemonRpc,
} from "./lib/daemon-rpc.js";

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
} = await import("./lib/stream-access.js");

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

const { sniffStreamFormat } = await import("./lib/stream-session.js");

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

const { validateInput } = await import("./lib/stream-routes.js");

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

const { matchRouteName } = await import("./lib/stream-routes.js");
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
  await import("./lib/stream-routes.js");

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
  await import("./lib/android-toolchain.js");

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
  const { findAdbOutsideEnv } = await import("./lib/android-toolchain.js");
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

const { parseFrontmatter, loadBundledSkill } = await import("./lib/skills.js");

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
  return { types, slots, shortcuts, opened, id: loaded.id };
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

/** 把 client.js 里的 CSS 模板取出来做断言。 */
function panelCss() {
  const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
  const match = source.match(/const CSS = `([\s\S]*?)`;/u);
  if (match === null) throw new Error("client.js 里找不到 CSS 模板");
  return match[1];
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
  await import("./lib/stream-session.js");

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
  assert.ok(source.includes("tabIndex: interactive ? 0 : undefined"), "画面元素缺 tabIndex，无法聚焦");
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
  const source = stripComments(readFileSync(new URL("./lib/tools.js", import.meta.url), "utf8"));

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

  // 被删的 5 个不得回流
  const REMOVED = ["tap", "swipe", "text", "button", "launchApp"];
  for (const key of REMOVED) {
    assert.ok(!entries.includes(key), `TOOL_NAMES.${key} 是薄包装，不该被注册`);
  }
  // 它们必须出现在 REMOVED_TOOL_NAMES 里（让调用方能分辨"删了"和"打错了"）
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
  const { loadBundledSkill } = await import("./lib/skills.js");
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
  const source = stripComments(readFileSync(new URL("./lib/stream-session.js", import.meta.url), "utf8"));
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
// 交互指令优先走 daemon 的 unix socket：实测 device.io.tap 7.3ms
// vs CLI 的 104.2ms（省掉每条命令约 66ms 的 node 进程启动）。
// daemon 本来就在运行，所以不需要新起进程、不需要端口、没有会话过期。
//
// 下面用**本地假 socket 服务器**验证协议，不依赖真机或真 daemon。
// 守的都是实测得来的事实 —— 错了会让交互静默变慢或失败。

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
  assert.equal(resolveSocketPath("/tmp/custom"), "/tmp/custom/daemon.sock");
  assert.equal(resolveSocketPath(null).endsWith("daemon.sock"), true);
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

await test("callDaemon 发的是 newline-delimited JSON（不是 HTTP）", async () => {
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

await test("JSON-RPC error 会抛出，且优先用 error.data 里的具体原因", async () => {
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

await test("daemon 不回就关闭 → 报错而不是永久挂起", async () => {
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
  await assert.rejects(() => rpc.call("device.io.tap", {}), (e) => e.code === "ENOENT");
  assert.equal(rpc.available, false, "连接层失败后应标记不可用，避免每次交互都白等一次超时");
  assert.ok(logs.some((l) => l.includes("daemon socket 不可用")), "应记录日志");

  // 再调一次：立即失败，不再尝试连接
  await assert.rejects(() => rpc.call("device.io.tap", {}), /已标记为不可用/u);

  // reset 后可以重试（daemon 重启的场景）
  rpc.reset();
  assert.equal(rpc.available, true);
});

await test("业务失败不标记通道不可用（否则一次设备错误就永久降级）", async () => {
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

await test("超时会抛错（设备卡住时不至于无限等）", async () => {
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

await test("RPC 失败要回退 CLI，而不是让交互失败", async () => {
  const cliCalls = [];
  const stubRpc = {
    available: true,
    async call() { throw new Error("daemon 挂了"); },
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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
