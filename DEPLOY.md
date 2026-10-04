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
