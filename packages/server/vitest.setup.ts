// ── 测试存储隔离 ──────────────────────────────────────────
// db.ts 在「模块加载时」就把 DB_PATH 解析成真实的 ~/.pocket-code/pocket-code.db
// (`process.env.DB_PATH || homedir()/.pocket-code/pocket-code.db`)。原先
// resourceLimits.test.ts 在 beforeAll 里设置 DB_PATH 已经太晚(const 早已捕获),
// 导致测试实际读写真实项目库;若测试与 daemon 同时运行,sql.js 的全文件覆盖式
// 持久化会互相覆盖、丢失会话/项目数据。
//
// vitest 保证 setupFiles 先于测试文件(及其 import 的源码模块)执行,故在此把
// DB_PATH / POCKET_HOME 指向临时目录,确保测试绝不触碰真实 ~/.pocket-code。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "pocket-code-server-test-"));
process.env.POCKET_HOME = base;
process.env.DB_PATH = join(base, "pocket-code.db");
