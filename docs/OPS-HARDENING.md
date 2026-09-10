# ZCode Web Service 运维手册（公网部署加固）

> 服务运行在 `0.0.0.0:8080`（网关 NAT → 公网 `egent.de5.net:21673`），
> **token 鉴权已开启**（systemd drop-in 注入 `ZCODE_WEB_TOKEN`，见下文）。
> 其余加固项已实现/验证，按需开启。

## 一、Token 鉴权（已开启 ✅）

服务端通过 `ZCODE_WEB_TOKEN` 环境变量开启鉴权，覆盖三种访问方式（实现见 `server/web-server.mjs`）：
- HTTP 头：`Authorization: Bearer <token>`
- Cookie：`zcode-web-token=<token>`（由登录门户 `POST /login` 种下，之后浏览器自动携带）
- URL 参数：`http://host:8080/?token=<token>`（仅当次请求有效，**不种 cookie**）

### 开启步骤

```bash
# 1. 生成 token
TOKEN=$(openssl rand -hex 24)
echo "你的访问 token: $TOKEN"

# 2. 写入 systemd（drop-in 覆盖，不改主单元文件）
sudo mkdir -p /etc/systemd/system/zcode-web.service.d
sudo tee /etc/systemd/system/zcode-web.service.d/token.conf <<EOF
[Service]
Environment=ZCODE_WEB_TOKEN=$TOKEN
EOF

# 3. 应用
sudo systemctl daemon-reload
sudo systemctl restart zcode-web.service

# 4. 验证：无 token 应 401，带 token 应 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/          # 期望 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/  # 期望 200
```

浏览器访问：`http://egent.de5.net:21673/` —— 未认证会自动跳转 **登录门户**（shadcn 风格），
粘贴 token 提交后服务端种下 HttpOnly cookie（30 天有效），后续访问无需再次输入。
`http://egent.de5.net:21673/?token=<token>` 也可直达，但该方式不种 cookie，仅当次有效。

- 登录门户：`GET /login`（已登录访问会直接跳回工作台）
- 登录接口：`POST /login`，JSON body `{"token":"<token>"}`，成功种 `zcode-web-token` HttpOnly cookie
- 退出：`GET /logout` 清 cookie 回门户页
- API/脚本路径不受影响：`Authorization: Bearer <token>` 与 `?token=` 仍然直通
- cookie 为 HttpOnly + SameSite=Lax：JS 不可读（防 XSS 窃取），WS `/rpc` 升级同样认 cookie

WebSocket `/rpc` 同样要求鉴权（port-shim 自动从 cookie/URL 继承 token）。
回归脚本：`/tmp/ws-auth-test.mjs`（无 token WS 握手被拒、带 token 正常收发）、
`/tmp/e2e-login-portal.mjs`（真实浏览器全流程：门户渲染 → 错误 token → 正确 token → 进工作台 → RPC 握手 → cookie 持久化）。

### 关闭鉴权（回到无鉴权测试模式）

```bash
sudo rm /etc/systemd/system/zcode-web.service.d/token.conf
sudo systemctl daemon-reload && sudo systemctl restart zcode-web.service
```

## 二、HTTPS / 反代说明（本机现状）

本机 nginx（1.18.0）的 `8443` 已被 DSH Web 占用（**明文 HTTP** + Basic Auth，配置在
`/etc/nginx/sites-enabled/dsh-web`），`/etc/nginx/ssl/` 下有 `dsh-web.crt/key` 但未启用 TLS。
若要给 ZCode Web 上 HTTPS/反代：

1. 新建独立站点（换端口如 `8444`，勿动 dsh-web）：

```nginx
# /etc/nginx/sites-available/zcode-web.conf
server {
    listen 8444 ssl;
    server_name egent.de5.net;

    ssl_certificate     /etc/nginx/ssl/dsh-web.crt;   # 若证书 SAN 覆盖该域名
    ssl_certificate_key /etc/nginx/ssl/dsh-web.key;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;          # 保留完整 host:port
        proxy_set_header Upgrade $http_upgrade;    # WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_buffering off;                       # agent 流式帧不缓冲
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

2. `ln -s /etc/nginx/sites-available/zcode-web.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx`
3. 网关把新公网端口 NAT 到内网 8444。

**提醒**：token 鉴权已开启，但公网目前仍是明文 HTTP —— token 与 cookie 在传输中可被中间人截获，
且服务持有你的 DeepSeek API key。要彻底加固，按本章配置 HTTPS 反代（并在开启后给 cookie 补 `Secure` 标记）。

## 三、进程守护（已开启 ✅）

- systemd 单元：`/etc/systemd/system/zcode-web.service`（`enabled`，开机自启）
- 双层守护：systemd（单元级 `Restart=always` 兜底）→ `scripts/serve.sh`（进程级崩溃
  1s 重启 + 10 分钟 20 次风暴保护）
- 已验证：node 崩溃自动恢复、stop/start 干净往返、serve.sh trap 重入 bug 已修

```bash
systemctl status zcode-web.service     # 状态
systemctl restart zcode-web.service   # 部署新代码后重启
tail -f /tmp/web-server.log           # 浏览器 beacon + RPC 诊断日志
```

## 四、数据落盘位置（持久化已实现 ✅）

| 数据 | 文件 |
|---|---|
| Provider + API key | `~/.zcode/cli/config.json`（与 CLI 共享） |
| 首启标记 / provider 展示顺序 | `~/.zcode/web-ide-state.json` |
| IDE 设置（主题/语言等） | `~/.zcode/web-ide-settings.json` |
| 远程凭据 | `~/.zcode/web-ide-credentials.json` |
| 会话/任务 | app-server 管理（`~/.zcode/` 下） |

## 五、验证脚本清单

| 脚本 | 覆盖 |
|---|---|
| `/tmp/e2e-browser-test.mjs` | 真实 Chromium 端到端：工作台挂载、刷新持久化、零异常 |
| `/tmp/e2e-live-probe.mjs` | 实时启动过程探针（加载文本采样 + debug beacon） |
| `/tmp/ws-persistence-test.mjs` | 持久化 29 项断言（save/getAll 回填/registry/首启/凭据/displayOrder） |
| `/tmp/ws-v4-test.mjs` | V4 会话协议（createSession/sendText/流式帧，期望 ANSWER "8"） |
| `/tmp/ws-channel-test.mjs` | 旧路径 smoke（期望 "2"） |
| `/tmp/ws-full-shape-test.mjs` | provider 全形状契约（of()/BT() 模拟） |
| `/tmp/ws-auth-test.mjs` | token 鉴权开关行为 |
| `/tmp/probe-appserver.mjs` | app-server updateProviderRegistry 直接探测 |
