/**
 * 工具契约的转发层。
 *
 * `defineTool` 与 `ToolArgsError` 都由宿主提供（`@deepseek-ai/dsh-tools`），
 * 不在这里重新实现。理由：
 *
 *   1. `defineTool` 会做参数与输出 schema 的编译和校验（把简写编译成 JSON
 *      Schema、按 schema 校验模型传来的参数、校验返回值）。自己实现一套必然
 *      与宿主的校验规则产生偏差，而偏差的表现是"工具在某些参数下静默失败"，
 *      非常难查。
 *   2. 这些符号是宿主运行时提供的，不在本包 dependencies 里——与 dsh-android
 *      的做法一致（它的 package.json 也刻意不声明 @deepseek-ai/* 依赖，
 *      只在 dshHostRuntime 里写注释说明）。
 *
 * 单独开一个文件而不是在 tools.js 里直接 import，是为了把"依赖宿主"这件事
 * 收敛到一处：将来宿主改名或调整导出，只改这里。
 *
 * ⚠️ 这个 import 在**没有宿主的环境**（比如只跑 npm test）会失败。
 * 所以测试 harness 不加载 tools.js，只测纯逻辑模块。
 *
 * @module dsh-sidebar-mobile/lib/tool-support
 */

import { defineTool, ToolArgsError } from "@deepseek-ai/dsh-tools";

export { defineTool, ToolArgsError };
