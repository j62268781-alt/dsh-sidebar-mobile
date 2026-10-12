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
import { Mobilecli, resolveBinary } from "./lib/mobilecli.js";

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
  }
}

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

// ── 流会话与多播 ────────────────────────────────────────────────────────
//
// 这一段用假的 spawn 替身，不需要设备。它锁住的是两个真实踩到过的 bug：
//   ① 首块消费者不注销 → consumers.size 永不归零 → 空闲自停永不触发
//   ② 首块转发两次 → 码流里多一个重复 NAL
// 两者都不会报错，只会表现为"设备一直编码"和"画面偶发花屏"，极难定位。

console.log("\n流会话");

const { StreamSession, StreamSessionPool } = await import("./lib/stream-session.js");

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

  await session.sendInput(run, { action: "swipe", x1: 1, y1: 2, x2: 3, y2: 4 });
  assert.deepEqual(seen[1], ["io", "swipe", "--device", "dev-1", "1,2,3,4"]);

  await session.sendInput(run, { action: "longpress", x: 5, y: 6, duration: 800 });
  assert.deepEqual(seen[2], ["io", "longpress", "--device", "dev-1", "5,6", "--duration", "800"]);

  await session.sendInput(run, { action: "button", name: "HOME" });
  assert.deepEqual(seen[3], ["io", "button", "--device", "dev-1", "HOME"]);

  await assert.rejects(() => session.sendInput(run, { action: "nope" }), /不支持的操作/);
  session.stop();
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
