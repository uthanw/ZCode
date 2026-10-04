# ZCode Web 自托管部署指南（v3.14.3 / 本 fork）

本指南描述把本仓库部署成一台**自托管 Web IDE 服务器**的完整流程：从源码构建、systemd 常驻、TLS/鉴权配置，到 agent 子进程行为与数据目录布局。所有命令都已在生产机（Ubuntu + systemd）上验证过。

与官方 README 的分工：README 面向开发者（bootstrap/dev 命令），本指南面向**部署与运维**——官方发行包路径（`pnpm build:zcode` → tar → install.sh）见 README「打包」章节，这里只讲**从 git 检出直接跑源码部署**的路线，这也是本 fork 当前的生产形态。

---

## 1. 架构总览

```
浏览器 ──https──▶ node dist/entry-http.js (packages/server, :3030)
                     │  ├─ 静态渲染器 packages/web/dist（ZCODE_WEB_STATIC_ROOT）
                     │  ├─ WebSocket /ws（RPC，走 cookie 鉴权）
                     │  └─ /login 门户（token 兑换 HttpOnly cookie）
                     │
                     └─ 按工作区懒 spawn agent 子进程：
                        node apps/zcode-cli/packages/cli/dist/zcode.cjs app-server --stdio
                        （进程常驻，每个 ~400–700MB RSS）
```

三条关键事实：

1. **服务端与 agent 是两份产物**：`packages/server/dist/entry-http.js`（tsup 打包）承载 HTTP/WS；每个工作区的 agent 是独立子进程，跑 CLI 单文件 bundle `apps/zcode-cli/packages/cli/dist/zcode.cjs`（esbuild 打包）。
2. **agent 是懒启动、常驻的**：第一次有请求触达某工作区才 spawn（`zcodeAgentProcessManager.ts` 的 `getClient`），之后进程复用直到服务重启或协议异常回收。chat 泳道**没有空闲回收**——10 个最近工作区就可能同时驻留 10 个 agent 进程，内存预算要按这个算。
3. **agent 命令解析顺序**（`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` `resolveDefaultZCodeAgentCommand`）：
   `ZCODE_AGENT_SERVER_COMMAND` env → **monorepo 里的 `dist/zcode.cjs`（构建出来即自动优先）** → tsx 跑源码（`src/main.ts`，未构建时的开发态兜底） → Electron 打包态 → 已部署原生 binary。

   > ⚠️ 部署关键点：**不构建 `dist/zcode.cjs`，agent 就以 tsx 源码模式跑，冷启动 14–20 秒**（还要吃 tsx 常驻编译内存），Web UI 上表现为「点开任务一直加载不出来」。构建出产物后同一进程管理器自动切换，冷启动降到 ~3 秒。这是本机生产环境踩过的最大的坑。

---

## 2. 环境要求

| 项 | 要求 |
|---|---|
| OS | Linux x64（systemd 发行版；也可用其他 init 手动守护） |
| Node.js | ≥ 24（`engines.node`；构建用 24.x，运行 server 的 node 不限小版本） |
| pnpm | 10.33.2（`packageManager` 钉死；可用 corepack/mise） |
| 内存 | 基础 ~500MB（server）+ 每个活跃工作区 agent 400–700MB |
| 磁盘 | 仓库 + node_modules ~15GB；会话数据库随使用量增长（本机 320 会话 ≈ 630MB） |

工具链可用 [mise](https://mise.jdx.dev/)（仓库自带 `mise.toml` 钉 node 24.14.0 / pnpm 10.33.2）：`mise install` 即装齐。

---

## 3. 构建

### 3.1 一次性格式化（首次检出）

```bash
git clone <本 fork> && cd zcode
pnpm install                # 或 mise exec -- pnpm install
node scripts/bootstrap.mjs  # git submodule + prepare + build:bootstrap
```

`bootstrap.mjs` 会初始化 `apps/zcode-cli` 子模块、安装依赖并跑 `build:bootstrap`（packages/* 基础构建）。给它留 10–20 分钟。

### 3.2 部署产物构建（本指南的路线）

需要的最终产物是三样：

| 产物 | 构建命令 | 作用 |
|---|---|---|
| `apps/zcode-cli/packages/cli/dist/zcode.cjs` | `pnpm --filter "@zcode/cli..." build` | agent 后端（核心！） |
| `packages/server/dist/entry-http.js` | `pnpm --filter @zcode/server build` | HTTP/WS 服务端 |
| `packages/web/dist/` | `pnpm --filter @zcode/web build` | 浏览器渲染器静态资源 |

推荐按序执行（turbo 的 `^build` 会自动处理 `apps/zcode-cli/packages/*` 内部依赖顺序）：

```bash
pnpm --filter "@zcode/cli..." build   # shared-types/core/adapters/bootstrap→cli bundle
pnpm --filter @zcode/server build     # tsup 入 entry-http.js（另产 remote/ 子文件，自托管用不到）
pnpm --filter @zcode/web build        # vite build
```

注意事项（都是本机实际踩过的）：

- **`@zcode/cli...` 的依赖链必须先于 CLI bundle 出 dist**：`shared-types`、`core`、`adapters`、`bootstrap`、`contracts`、`tui`、`i18n` 的 `exports` 都指向各自的 `dist/index.js`，任何一个过期会导致 CLI bundle 阶段类型错误（例如 `dynamic-workflow` 引擎未先构建时报 `setMaxConcurrency` 类型缺失）。turbo 正常会处理，**但如果某天你改了其中某个包的源码**，重跑上述命令前先确认 `find <pkg>/src -name "*.ts" -newer <pkg>/dist/index.js` 为空。
- `packages/shared` 是**源码级内联**（alias 直接指 `src/*.ts`），不需要预先 build。
- CLI bundle 构建参数：`format=cjs, target=node22, bundle=true`，external 只有 `@zcode/tui / playwright-core / koffi`（运行时从 node_modules 加载）。产物 ~30MB（含内联 provider 配置），另有 50MB 的 `.map`（可删）。

构建完成的验收：

```bash
node apps/zcode-cli/packages/cli/dist/zcode.cjs --version   # 应输出版本号（如 0.16.9）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | timeout 30 node apps/zcode-cli/packages/cli/dist/zcode.cjs app-server --stdio \
  | head -1   # 3 秒左右应吐出 startup/storageState 帧；>10s 说明还是 tsx 模式
```

> 备选路线：`pnpm build:zcode` 走官方发行包（tar + install.sh，见 README），或在别的机器构建后只拷 tar 解压。生产上只要保证「server 能找到 agent 的 zcode.cjs + node_modules 外置依赖」即可，路线不唯一。本文主线是从源码直接跑，升级 = `git pull && 重新执行 3.2`。

---

## 4. 环境变量与数据目录

### 4.1 服务端（packages/server/src/entry-http.ts）

| 变量 | 必填 | 作用 |
|---|---|---|
| `PORT` | 建议 | 监听端口，默认 3030。**注意：是 `PORT`，不是 `ZCODE_WEB_PORT`**（后者在代码里不存在，历史 unit 里写过是无效的） |
| `ZCODE_SERVER_HOST` / `HOST` | 公网部署 | 监听地址；不设只绑 localhost 侧。公网需 `0.0.0.0` |
| `ZCODE_WEB_STATIC_ROOT` | 是 | 指向 `packages/web/dist`，未设则无页面 |
| `ZCODE_SERVER_AUTH_TOKEN` | 强烈建议 | 访问令牌；设置后启用门户 + 全路径鉴权 |
| `ZCODE_SERVER_TLS_CERT` + `ZCODE_SERVER_TLS_KEY` | 二选一方案 A | 自备 PEM 证书（**必须成对**，只配其一启动即失败、绝不静默回退 HTTP） |
| `ZCODE_SERVER_TLS_SELF_SIGNED=1` | 二选一方案 B | 自动生成自签证书（详见 §5） |
| `ZCODE_SERVER_WORKSPACE` | 后端默认工作区 | 缺省 `process.cwd()`；影响「不在工作区」的会话落点 |
| `ZCODE_DATA_BASE_DIR` | 建议 | 数据根隔离（见 4.2） |
| `ZCODE_DESKTOP_HOME_DIR` | 建议 | setting.json 的 home（与数据根配对设置，见 4.2） |
| `ZCODE_LOG_DIR` | 可选 | agent 侧 jsonl 日志目录（默认 `~/.zcode/cli/log/`）；server 与 agent 子进程共用此变量 |

未用的名字提前排雷：`ZCODE_WEB_PORT`、`ZCODE_WEB_HOST`、`ZCODE_SERVER_TOKEN`（仅展示用）不是启动配置。

### 4.2 数据目录布局

CLI/agent 侧路径遵循两个「home」概念，部署时**两个变量指向同一个根**可避免数据分家：

```
$ZCODE_DATA_BASE_DIR/.zcode/
├── cli/db/db.sqlite          # 会话/消息/part 全量库（agent 子进程写；大头）
├── cli/log/zcode-*.jsonl     # 结构化日志（按天轮转，可用 ZCODE_LOG_DIR 移走）
├── v2/setting.json           # 经 $ZCODE_DESKTOP_HOME_DIR 解析（默认 ~/.zcode/v2/）
├── v2/tasks-index.sqlite     # 任务索引
├── v2/sessions/{hash}/       # 会话快照
├── workspace/default/        # 「不在工作区」的默认对话目录
├── certs/                    # TLS 自签证书（自签方案时）
└── cli/plugins/              # 官方插件缓存
```

上传文件落在主工作区 `的 .uploads/` 下。

`db.sqlite` 是全局单库，跨所有工作区共享（表内按 directory 区分）；日积月累会很大，备份策略盯住它。

### 4.3 鉴权行为（http.ts）

`ZCODE_SERVER_AUTH_TOKEN` 设置后：

- **保护范围**：`/ws*`、`/api/*`、`/upload*`、页面路径；`/login`、`/logout`、`/share*` 免鉴权。
- **令牌传递只有两种**：URL `?token=xxx`（命中后兑换 HttpOnly cookie 30 天）和 cookie `zcode_lite_token`。**没有 Authorization Bearer 方案**——API 调用也走 cookie。
- 浏览器首次访问 302 到 `/login` 门户；fetch/XHR 未认证返回 401 JSON。
- TLS 开启时 cookie 自动带 `Secure`。
- WebSocket `/ws` 握手同样要求已认证（终端登录页种 cookie 后再连）。

---

## 5. TLS（HTTPS）

两种方案，实现于 `packages/server/src/tls.ts`（行为规范 `packages/server/spec/web-server-tls.md`）：

- **方案 A 自备证书**：`ZCODE_SERVER_TLS_CERT` + `ZCODE_SERVER_TLS_KEY` 指向 PEM 文件（如 Let's Encrypt / 企业 CA）。
- **方案 B 自签（推荐内网/个人用）**：`ZCODE_SERVER_TLS_SELF_SIGNED=1`。首次启动生成 RSA 2048、**10 年有效期**证书，落盘 `{ZCODE_DATA_BASE_DIR}/.zcode/certs/web-server-self-signed-{cert,key}.pem`（私钥 0600）；幂等复用，指纹稳定——浏览器点一次「继续前往」后不漂移。SAN 覆盖 localhost、hostname、127.0.0.1、::1。

同端口直接从 HTTP 切 HTTPS（无双栈并存）——切换后旧 `http://` 地址报协议错误属预期；浏览器改用 `https://IP:3030`。公网正规证书场景若有前置 Nginx/Caddy，也可在反代层终止 TLS、server 维持 HTTP，本部署未采用该路线。

---

## 6. systemd 部署

固定假设：仓库在 `/root/zcode`，数据根 `/root/zcode-home`（按需替换）。

**`/etc/zcode-official.env`**（token 独立存放，权限 600）：

```ini
ZCODE_SERVER_AUTH_TOKEN=<强随机串>
```

**`/etc/systemd/system/zcode-official.service`**：

```ini
[Unit]
Description=ZCode Web (official fork, self-hosted)
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/zcode/packages/server
Environment=PATH=/root/.nvm/versions/node/v24.14.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=ZCODE_DATA_BASE_DIR=/root/zcode-home
Environment=ZCODE_DESKTOP_HOME_DIR=/root/zcode-home
Environment=ZCODE_SERVER_WORKSPACE=/root/ws
Environment=ZCODE_WEB_HOST=0.0.0.0
Environment=ZCODE_WEB_PORT=3030
Environment=ZCODE_RUNTIME_ENV=production
Environment=ZCODE_LOG_DIR=/root/.zcode/cli/log
Environment=ZCODE_WEB_STATIC_ROOT=/root/zcode/packages/web/dist
Environment=ZCODE_SERVER_TLS_SELF_SIGNED=1
EnvironmentFile=/etc/zcode-official.env
ExecStart=/root/.nvm/versions/node/v22.23.2/bin/node dist/entry-http.js
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

要点：

- **`WorkingDirectory` 必须是 `packages/server`**：其一是 `ExecStart` 的相对路径 `dist/entry-http.js` 依赖它；其二是 agent 命令解析的 `findUpward` 从 `process.cwd()` 向上找 `apps/zcode-cli/packages/cli/dist/zcode.cjs`——**同一份仓库树上，cwd 在哪一层都能命中**（`/root/zcode/packages/server` 向上即仓库根），这是「dist 产物自动优先」能生效的前提。若把产物拷到别处运行，需改用 `ZCODE_AGENT_SERVER_COMMAND` 显式指定。
- `KillMode=control-group` 保证 systemd 停止时把 agent 子进程树一并收干净（agent 在 POSIX 下是 detached 进程组）。
- `PATH` 里放上 nvm 的 node 路径，agent spawn 与 MCP 子进程要用。
- `ZCODE_WEB_HOST/ZCODE_WEB_PORT` 两行在本版本是**无效的摆设**（生效的是默认 3030 + `hostname: undefined` 的全网卡绑定），无害；若用非默认端口必须设 **`PORT`**。
- `Restart=always` + 5 秒退避。调试期可 `journalctl -u zcode-official -f` 看启动日志。

启用：

```bash
systemctl daemon-reload
systemctl enable --now zcode-official
curl -sk https://127.0.0.1:3030/api/server-info   # 期望 401（未带 token）即活
```

### 已知行为（非 bug，但要有预期）

- **agent 首次冷启动仍要等 ~3 秒**：某工作区的第一个订阅请求会失败一次（订阅不等懒启动），客户端 UI 重试后即成功。dist 产物模式整体表现为「第一次打开一个工作区慢 3 秒，之后秒开」。
- 若长期只用少数工作区，热身后进程常驻，体验与桌面端一致。

---

## 7. 升级流程

```bash
cd /root/zcode
git pull
pnpm install
pnpm --filter "@zcode/cli..." build && pnpm --filter @zcode/server build && pnpm --filter @zcode/web build
systemctl restart zcode-official     # 会断当前 Web 会话几秒，自动恢复
```

重启不影响已持久化的会话数据（db.sqlite + 快照），浏览器重连即可继续历史会话。

验证升级（agent 确实换成新产物）：

```bash
journalctl -u zcode-official --since "-10 min" | grep -A4 "spawn preflight" | grep zcode.cjs
# 应看到 args: [ '/root/zcode/apps/zcode-cli/packages/cli/dist/zcode.cjs', 'app-server', '--stdio' ]
```

## 8. 故障排查速查

| 症状 | 定位 | 处置 |
|---|---|---|
| Web 点开任务一直转圈 | journalctl 里 `subscribeSessionsIndexV4 FAIL: runtime is not running` + spawn 命令是 `tsx` | 没构建 CLI dist → 执行 3.2；已构建则等 3 秒冷启动重试 |
| 页面 401 循环 | 未带 token | 浏览器开 `https://host:3030/?token=<token>` 兑换 cookie，或走 `/login` 输入 |
| 启动即退且报 TLS 读取失败 | cert/key 只配了一个或路径错 | 成对配置或改用 `ZCODE_SERVER_TLS_SELF_SIGNED=1` |
| agent 内存高 | `ps --ppid <server-pid>` | 常驻设计使然；控制同时活跃的工作区数量 |
| 数据库过大 | `~/.zcode/cli/db/db.sqlite` | 归档旧会话（官方暂无清理命令） |
| 改了某 packages/* 源码后 CLI 构建报类型错 | 该包 dist 过期 | 先 `npx tsc`（在该包内）再重跑 CLI bundle 构建 |

---

## 9. 本 fork 相对上游的自有改动

以 `git diff upstream/main..HEAD` 为准（基准：上游 `zai-org/ZCode` main = v3.14.3，`29628c9`）。fork 共多 12 个提交、28 个文件、约 +4200 行。改动集中在四个主题，**均为上游没有的能力**，合并上游时是重点关照对象：

### 9.1 Web 自托管核心（移植自 zcode-web-next 垫片，`8e2d2ba`）

上游的 web server 是无鉴权、无上传、断线即断言的裸 HTTP 入口。fork 从旧垫片项目 TypeScript 重写移植了完整自托管层：

| 能力 | 文件 | 说明 |
|---|---|---|
| 文件上传桥接 | `packages/web/src/webUpload.ts`（616 行）+ `packages/server/src/uploadRegistry.ts`（656 行） | 乐观路径/XHR 断点续传；服务端内容寻址落盘、sha256 校验、去重 |
| 非 HTTPS 环境哈希 | `packages/web/src/sha256Core.ts` + `sha256Worker.ts` | 纯 JS 流式 SHA-256（自签/明文时无 SubtleCrypto）；含一个 fork 修复：compress() 原只处理首个 64 字节块，公网非安全上下文曾致 sha_mismatch |
| 可恢复 WebSocket | `packages/client/src/resumableWebSocket.ts`（560 行）+ `packages/server/src/resumable.ts`（508 行） + `packages/client/src/websocket.ts`（+57 行接线） | 断线按 cid 复用同一 ChannelServer，帧编号 + 缺口重放；不可恢复时整页重载（订阅已失效，假装连着比掉线更糟）；含休眠唤醒/网络恢复探测 |
| 鉴权门户 | `packages/server/src/http.ts` 内 token 中间件 + `packages/server/inject/login.html`（235 行） | 见 §4.3；上游完全没有 |
| web 端桌面化 | `packages/web/src/main.tsx`（+42 行） | 透传桌面平台标志，复用桌面标题栏/侧栏折叠 UI |
| vite dev 配置 | `packages/web/vite.config.ts`（+11 行） | dev server 的 host/allowedHosts 由环境变量驱动（`ZCODE_WEB_DEV_HOST` / `ZCODE_WEB_DEV_ALLOWED_HOSTS`），去除本机特征 |
| 集成测试探针 | `probe-client.mts` | RPC 探针客户端（调试用，非产品依赖） |

### 9.2 HTTPS（`d09ef0d` + `64d852b`）

- `packages/server/src/tls.ts`（138 行）+ `tls-forge.d.ts`：显式 cert/key 或自动自签（§5）；规范文档 `packages/server/spec/web-server-tls.md`；测试 `packages/server/test/web-server-tls.test.ts`（node:test，覆盖 TLS 解析、自签幂等、HTTPS/WSS 握手、Secure cookie）。
- `entry-http.ts` 接线 +6 行；`http.ts` TLS 时 cookie 加 `Secure`。
- README 双语补充环境变量说明。

### 9.3 Window Controller 非桌面宿主注册（`f2464f9`）

上游把 Window Host Controller 运行时（pin/timeline/archived 列表聚合、sessions-index 观察）装配在 Desktop Host 里，standalone server **从未注册** `IWindowControllerService`——后果是 Web 端的全局任务列表和 header 计数静默为空（只有项目内任务走 zcodeTaskService 另一条路径能显示）。

fork 做了一次**跨包迁移**：运行时从 `packages/desktop/src/host/` 迁入 `packages/services/src/window-controller/`（4 个文件，desktop 只改 import 指向新 `@zcode/services/node` 出口），并新增 `registerLocalWindowControllerService`——只认本地 source、远端身份 fail closed（server 没有 `windowRemoteConnectionRegistry` 可路由），挂进 `createLocalServices` 的非桌面 authority 分支，用 WeakMap 侧表保证 dispose 释放。

### 9.4 文档与仓库卫生（其余提交）

- `edecf49` / `2af7092`：从共享 .gitignore 移除机器特定路径（`ws-official/`、上传目录），改由各机 `.git/info/exclude` 自理。
- `ff80c6f`：本文件 DEPLOY.md。
- `10b6522` / `26d05bd`:合并 origin（fork 远端）与上游 main 的合并提交，无实质改动。

**不在上游也不在本清单的**：工作区内未提交内容（如 `storage-startup.ts` 的首帧顺序修正等本地实验）不属于 fork 历史的一部分，详见 `git status`。

---

## 10. 合并上游升级流程

上游仓库 `https://github.com/zai-org/ZCode`；本地以 `upstream` 远端跟踪它的 main（fork 自身远端 `origin` 是 GitHub 上的个人 fork）。节奏不固定——历史上游 v3.14.3（2026-09-23 开源更新）至今无新提交，但流程按每次都要走一遍准备。

### 10.1 合并前：摸清碰撞面

fork 的改动都是「上游没有的功能粘贴」，**不是侵入式改写上游代码**，所以大部分文件是纯新增（new file），git 能自动合并。真正的碰撞面只有 5 个「上游文件 + fork 增量」：

| 上游文件 | fork 增量 | 冲突风险 |
|---|---|---|
| `packages/server/src/http.ts` | +450 行（鉴权中间件、上传路由、登录页） | **最高**——fork 改动横跨鉴权/路由/静态托管/WS 注入多个区域，上游动了 server 层几乎必撞 |
| `packages/server/src/entry-http.ts` | +8 行（TLS 解析接线） | 低——入口函数尾部追加 |
| `packages/web/src/main.tsx` | +42/-11 | 中——bootstrap 逻辑，上游常改 |
| `packages/client/src/websocket.ts` | +57 行（文件尾新增函数） | 低 |
| `packages/services/src/node.ts` | +29 行（window-controller 导出与注册） | 低——但模式聚合大文件，上游新增导出时会有同类行冲突 |

另外注意 `packages/desktop/src/host/index.ts` 的 import 改向（window controller 迁移的配套，2 行）——若上游重构 desktop host，`9.3` 的迁移可能要重做（路径重新搬一次）。

### 10.2 合并操作

```bash
cd /root/zcode-official
git fetch origin                        # 先同步自己的远端（如果别处推过）
git fetch upstream
git log HEAD..upstream/main --oneline   # 看上游有什么新东西（当前为空 = 无需合并）

# 建议留一条可回退的分支线，不要直接在 main 上合：
git switch main
git merge upstream/main

# 若冲突（预期集中在 10.1 表格的文件）：
git status                        # 逐个解决
git mergetool                     # 或手动
git merge --continue
```

冲突解决原则：**fork 侧的鉴权/上传/TLS/resumable WebSocket 的逻辑块一律保留**，把它当补丁重新贴到上游的新代码结构上，而不是接受任一侧的整文件版本。`http.ts` 冲突时优先看上游是否也新增了中间件或路由常量（比如新的 protection path），fork 的 `isTokenProtectedPath`/`hasValidLiteToken`/`registerUploadRoutes` 三块是核心，别丢。

### 10.3 合并后：验证与重建（可直接复用 §3.2 / §7 的命令）

```bash
pnpm install                                # 依赖可能变了
pnpm --filter "@zcode/cli..." build          # 注意 §3.2 的坑：上游若动了 workspace
pnpm --filter @zcode/server build            #   内部包，dist 过期链会报类型错
pnpm --filter @zcode/web build

node packages/server/test/web-server-tls.test.ts   # 或 npx tsx 跑——确保 9.2 的测试还过
git push origin main                         # 确认无误后推 fork 远端
systemctl restart zcode-official             # 走 §7 升级重启
```

功能冒烟（Web 端，2 分钟清单）：

1. `https://host:3030/?token=<token>` 能进且 cookie 生效（登出门户正常出 302）。
2. 首页打开一个**旧工作区的任务**——验证 9.3 的全局任务列表非空（这个功能静默失效，不冒烟不会发现）。
3. 拖一个文件上传到会话——验证上传桥接链路。
4. 刷新页面时 WebSocket 重连（Network 面板 /ws 帧重放）——验证 resumable 层。
5. `journalctl -u zcode-official | grep "command resolved"` 后续 spawn 仍是 `dist/zcode.cjs`。

### 10.4 回退

合并出问题未推远端时：`git reset --hard ORIG_HEAD`。已重启服务发现问题：`git reset --hard <旧提交> && 重建 §3.2 && systemctl restart`。数据目录（`ZCODE_DATA_BASE_DIR`）与代码完全分离，任何代码层回退不动数据；但**跳版本降级**（上游若带来 db schema 迁移）时旧代码可能读不了新库——回退前备份 `~/.zcode/cli/db/db.sqlite` 与 `~/.zcode/v2/`（约 700MB，闭眼备份即可）。
