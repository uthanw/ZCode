# ZCode Web Service

把 ZCode 桌面版（Electron 应用）**原样逆向部署为纯 Web 服务**：不做任何前端改造，
直接托管其渲染器产物，在浏览器里复刻 Electron 的 main ↔ renderer IPC 语义，
让完整的 ZCode 工作台（会话、任务、终端、文件树、Diff 预览）跑在浏览器中。

```
浏览器（原版渲染器 + port-shim 注入）
    │  WebSocket /rpc（二进制 channel 协议）
    ▼
server/web-server.mjs ── 静态托管 renderer/ + 登录门户 + 压缩缓存
    │  ChannelServer（每条 WS 连接一个）
    ▼
server/services/* ──── 37 个 RPC channel（File/Terminal/Git/Setting/...）
    │  stdio JSON-RPC（换行分隔）
    ▼
bin/zcode.cjs app-server ── v4/* 会话协议 ── 模型 API（DeepSeek 等）
```

## 工作原理

桌面版渲染器通过 Electron `MessagePortMain` 与主进程通信。Web 版的关键在于
**渲染器一行不改**，三层桥接把 IPC 语义原样搬到浏览器：

1. **port-shim 注入**（`server/inject/port-shim.js`，入口同步执行）：创建真实
   `MessageChannel`，port2 经 `window.postMessage` 转移给渲染器（它拿到的就是原生
   `MessagePort`，语义 100% 一致），自己持有 port1 与 WebSocket 之间双向搬运字节。
   同时补齐 120 个 `window.zcode` preload API（66 个刻意保持 `undefined` 供渲染器
   特性探测，51 个必须存在）。
2. **二进制 channel 协议**（`server/lib/rpc.js`）：逆向还原的 VSCode 风格
   ChannelServer/ChannelClient —— VQL varint 长度前缀 + 类型标签
   （Undefined/String/Buffer/VSBuffer/Array/Object/Int）+ 消息类型码
   （100-103 客户端方向，200-204 服务端方向）。渲染器自身的 ChannelClient 原样
   跑在这套协议之上。
3. **app-server 适配**（`server/lib/zcode-app-server.js`）：常驻
   `bin/zcode.cjs app-server` 子进程，通过换行分隔的 stdio JSON-RPC 通信；
   V4 会话协议（`server/services/v4-protocol.js`）把渲染器的 `*V4` channel 方法
   代理到 app-server 的 `v4/*` 方法，并把 `v4/conversation/frame` 等流式帧
   **原样转发**（渲染器端装配器直接消费 wire 帧，服务端不解包）。

协议逆向过程中的关键实测结论都写在对应源码的头部注释里（如：v4 会话必须用
`v4/command {type:'createSession'}` 创建，否则外键失败；subscribe 前必须先
`workspace/updateProviderRegistry` 同步 provider）。

## 快速开始

```bash
# 依赖：Node.js ≥ 20（当前部署用 v22），需要构建 node-pty 的工具链
npm install

# 前台运行（默认 0.0.0.0:8080，serve.sh 会导出端口默认值）
./scripts/serve.sh

# 开启鉴权
ZCODE_WEB_TOKEN=$(openssl rand -hex 24) ./scripts/serve.sh
```

浏览器打开 `http://<host>:8080/` 即进入工作台（未认证时跳转登录门户）。

生产部署用 systemd 双层守护（systemd `Restart=always` 兜底 → serve.sh 进程级
1s 重启 + 10 分钟 20 次风暴保护）：

```bash
systemctl status zcode-web.service   # 状态
systemctl restart zcode-web.service  # 部署新代码后重启
tail -f /tmp/web-server.log          # 运行日志（含浏览器 beacon 诊断）
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ZCODE_WEB_PORT` | `8080`（serve.sh）/ `8443`（裸起 web-server.mjs） | 监听端口 |
| `ZCODE_WEB_HOST` | `0.0.0.0` | 监听地址 |
| `ZCODE_WEB_TOKEN` | 空（**不鉴权**） | 访问令牌，见下节 |
| `ZCODE_WEB_WORKSPACE` | `<项目根>/workspace` | 默认工作区路径 |
| `ZCODE_WEB_DEBUG` | 未设置 | 开启服务端 debug 日志 |

## 鉴权

设置 `ZCODE_WEB_TOKEN` 后，三种访问方式（实现见 `server/web-server.mjs`）：

- **登录门户**（浏览器推荐路径）：未认证的页面请求 302 到 `/login`（shadcn 风格，
  零依赖），粘贴 token 提交后服务端种下 `zcode-web-token` HttpOnly + SameSite=Lax
  cookie（30 天），后续访问无需再次输入；`GET /logout` 清 cookie 回门户。
- **HTTP 头**：`Authorization: Bearer <token>`（API/脚本用；非浏览器的未认证请求
  返回 401 JSON，不跳登录页）。
- **URL 参数**：`http://<host>:<port>/?token=<token>`。注意：URL 方式**不种
  cookie**，仅当次请求有效，长效登录请走门户。

WebSocket `/rpc` 升级同样校验（Bearer / cookie / `?token=` 任一即可，port-shim
自动继承）。生产开启方式（systemd drop-in，不动主单元文件）：

```bash
sudo mkdir -p /etc/systemd/system/zcode-web.service.d
sudo tee /etc/systemd/system/zcode-web.service.d/token.conf <<EOF
[Service]
Environment=ZCODE_WEB_TOKEN=$(openssl rand -hex 24)
EOF
sudo systemctl daemon-reload && sudo systemctl restart zcode-web.service
```

## 目录结构

```
├── bin/zcode.cjs          # vendored：ZCode CLI 打包产物（app-server 后端）
├── renderer/              # vendored：未修改的 Electron 渲染器产物（~58MB 构建资产）
├── server/
│   ├── web-server.mjs     # 主服务器：静态托管 + 登录门户 + 压缩缓存 + WS /rpc + 会话池
│   ├── inject/
│   │   ├── port-shim.js   # 浏览器端注入：MessagePort → WebSocket 桥（可恢复传输
│   │   │                  #   + 业务就绪门 + 连接状态徽标）+ preload 桩
│   │   └── login.html     # 令牌登录门户页
│   ├── lib/
│   │   ├── rpc.js         # 二进制 channel 协议（ChannelServer/VSBuffer/VQL 编解码）
│   │   ├── resumable.js   # 可恢复 RPC 会话：按 cid 常驻、断线缓冲、重连重放
│   │   └── zcode-app-server.js  # stdio JSON-RPC 客户端（app-server 子进程）
│   └── services/
│       ├── index.js       # 37 个 RPC channel 的装配与协议桥
│       ├── agent-services.js    # File/System/Terminal/Git/Setting/... 通道实现
│       └── v4-protocol.js       # V4 会话协议代理与流式帧转发
├── scripts/
│   ├── serve.sh           # 守护启动脚本（崩溃重启 + 风暴保护）
│   └── e2e/               # 回归测试：编解码对拍 / WS 断线重连 / 浏览器 E2E
├── docs/OPS-HARDENING.md  # 运维加固手册（鉴权、HTTPS 反代、可恢复会话协议、脚本清单）
└── workspace/             # 默认工作区（运行时用户数据，已 gitignore）
```

`bin/` 与 `renderer/` 是从桌面版原样取出的产物，**不要手工修改**；本项目的全部
自有逻辑都在 `server/` 下。

## 断线重连与连接状态徽标

渲染器的 MessagePort 一生只派发一次，因此重连不换端口、只换端口底下的
WebSocket；服务端按 `cid` 保住同一个 ChannelServer（事件订阅、进行中请求全部存活）。
「连接成功」是**业务层谓词**：WS 通了之后还要完成一次真实 RPC 往返
（`zcode-web-health.ping`），确认 app-server 存活且事件订阅仍在，才宣布已连接；
否则显示「服务未就绪」而非谎称连上。序号缺口、缓冲溢出、订阅丢失、服务重启等
不可恢复情形一律整页重载。详见 `docs/OPS-HARDENING.md` §四B。

界面右上角（标题栏之下）有一枚 Next.js devtools 风格的常驻徽标：正常时缩为
半透明小点，断线/校验/未就绪时弹性放大高亮（带脉冲），点击展开浮动状态卡
（延迟/订阅数/倒计时/重试按钮）。徽标可拖动到任意位置（位移阈值区分点按与
拖动，位置写入 localStorage 跨会话记忆，面板自动跟随并在贴边时翻转）。

## 性能与静态资源

renderer 资源总量约 58MB（最大单文件 4.5MB），服务端做了三层优化
（`server/web-server.mjs`）：

- brotli/gzip 压缩，内存 LRU（96MB）+ 磁盘缓存（`.cache/compressed/`，已
  gitignore）+ 预压缩
- 文件名带内容哈希的资源走 `Cache-Control: immutable` 一年强缓存
- HTML 入口动态注入 port-shim 后再返回

## 运行时数据落盘

| 数据 | 位置 |
|---|---|
| Provider + API key | `~/.zcode/cli/config.json`（与 CLI 共享） |
| IDE 设置 / 首启标记 | `~/.zcode/web-ide-settings.json` 等 |
| 会话与任务 | app-server 管理（`~/.zcode/` 下） |
| 服务日志 | `/tmp/web-server.log` |

## 文件上传 / 下载（Web 桥接语义）

桌面版把「本地文件进对话」和「打开文件」建立在**本地绝对路径**之上（拖入的文件
`getPathForFile` 同步返回路径 → 零拷贝引用；「在文件管理器中打开」直接调系统程序）。
Web 版无法拿到用户机器的路径，桥接层做了语义替换（渲染器零修改）：

- **拖拽 / 回形针 / 粘贴长文本** → 文件经 `POST /upload` 传到服务器
  `WORKSPACE_ROOT/.uploads/`，返回服务器路径，渲染器按零拷贝语义引用它。
  乐观路径：拖拽时 `getPathForFile` 同步返回预测落盘路径（渲染器要求同步），
  字节后台传输，`sendText` 服务端闸门**等待字节真正落盘后**才转发 app-server，
  不存在「引用了但文件还没到」的竞态。上传过程右下角有自绘进度条。
- **内容寻址去重（秒传）**：客户端先算 SHA-256（内置纯 JS 实现，兼容非 HTTPS
  部署——`crypto.subtle` 仅安全上下文可用）→ `POST /upload-dedupe` 查询 →
  命中则服务器直接硬链接已有 blob，零字节传输，进度条显示「服务器已有 · 秒传」。
  存储层为 `.uploads/.blobs/<sha256>` 内容寻址 + `<token>__<name>` 硬链接别名，
  相同内容只存一份；上传时服务端强校验哈希（防谎报骗秒传）。
- **先发后到（占位文件）**：拖拽瞬间垫片即注册（带文件大小），服务器立刻在预测
  路径写占位文本。此后任意时刻点发送都有完备语义：上传完成 → 直接放行真文件；
  8 秒宽限内完成 → 闸门等落地再放行（小文件无感）；大文件未完 → 放行占位路径，
  占位文本里带着文件名、大小和一条现成的阻塞等待命令，模型自己
  `until [ "$(stat -c %s …)" = 大小 ]` 等字节落盘（等待成本交给唯一消费文件的一方）。
  字节落地用 link+rename 原子替换占位，读侧无空窗；上传失败占位改写为失败说明，
  模型的等待循环因文件大小变化退出并告知用户。
- **「在文件管理器中打开」/「用编辑器打开」** → 触发浏览器下载（`GET /download`）。
- **图片/视频/PDF**（≤20MB）仍走渲染器原生的 v4 attachment 内联上传（base64 分块，
  带原生进度 UI），与桌面远程会话行为一致。
- 上传落点 `.uploads/` 为隐藏目录（不出现在文件树）；未引用的上传 1 小时后自动清理，
  已被会话引用的保留 24 小时。单文件上限默认 512MB（`ZCODE_WEB_UPLOAD_MAX_BYTES`）。
- 验证：`node scripts/e2e/file-upload.mjs`（HTTP 层闭环 + 闸门时序 + 鉴权）。

## 已知限制

- 单工作区部署：v4 帧广播按默认工作区键路由，多工作区并发场景未设计。
- 公网裸 HTTP 下 cookie 无 `Secure` 标记，上 HTTPS 反代后应补上；
  `POST /login` 无速率限制，建议配合反代限流。
- `?token=` URL 参数会留在浏览器历史/服务端访问日志中，仅作入口便利，
  长效访问请用门户种 cookie。
- 渲染器（只读 Electron bundle）的 code-viewer 组件对 `multi-file-diff` 类型
  source 的 `beforeContent` 直接取 `.length`，而 app-server schema 允许
  `beforeContent: null`（新建文件场景）。持久化的右侧面板 tab 恢复时若快照
  数据不可用会触发一次 React 渲染错误（ErrorBoundary 兜底，不影响整体 UI）。
  服务端无法修复只读渲染器，属上游 bug，升级 bundle 时关注。

更多运维细节（HTTPS/nginx 配置模板、验证脚本清单）见 [docs/OPS-HARDENING.md](docs/OPS-HARDENING.md)。
