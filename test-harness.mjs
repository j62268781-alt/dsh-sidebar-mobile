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
 * @module dsh-client-ui-sidebar-mobile/test-harness
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

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
