// ── 测试存储隔离 ──────────────────────────────────────────
// deviceStore / pairing 在「模块加载时」就把存储路径解析成真实的
// ~/.pocket-code(`process.env.POCKET_HOME || homedir()/.pocket-code`)。
// 若测试不隔离,addDevice/revokeDevice 等会直接写真实设备库,把用户已配对
// 的设备冲掉,导致重启后被迫重新配对。
//
// vitest 保证 setupFiles 先于测试文件(及其 import 的源码模块)执行,故在此
// 把 POCKET_HOME / DB_PATH 指向临时目录,确保测试绝不触碰真实 ~/.pocket-code。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "pocket-code-daemon-test-"));
process.env.POCKET_HOME = base;
process.env.DB_PATH = join(base, "pocket-code.db");
