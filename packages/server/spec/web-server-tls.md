# Web 服务 TLS（HTTPS）规范

`packages/server` 的通用 Web 服务入口（`src/entry-http.ts` → `src/http.ts`）默认以纯 HTTP 监听。本规范定义其 HTTPS/TLS 支持的产品规则、配置、接口与验收场景。实现位于 `src/tls.ts`。

## 产品规则

1. TLS 是可选项：未配置任何 TLS 材料时服务保持纯 HTTP，行为与历史版本完全一致。
2. TLS 材料有两个来源，优先级从高到低：
   1. **显式证书**：同时提供 PEM 证书与私钥文件路径。
   2. **自动自签**：由程序生成一张自签证书并缓存复用。
   3. 都未提供 → 纯 HTTP。
3. **fail fast，不静默降级**：配置了 TLS 但材料不可用（只配了 cert/key 之一、文件不存在或不可读、生成失败）时启动必须失败并输出明确错误。静默回退 HTTP 会让用户在以为有加密的链路上明文传输访问令牌，比启动失败更危险。
4. 自签证书幂等：首次启用时生成，之后复用同一份文件，保证证书指纹稳定、被浏览器「仍然继续」信任后不漂移。复用判断的唯一事实源是文件系统（证书与私钥文件都存在即复用）。
5. TLS 生效时，访问令牌 cookie（`zcode_lite_token`）必须带 `Secure` 属性；纯 HTTP 时不带，避免本地开发 cookie 无法写入。
6. WebSocket（`/ws`、`/ws/host`、`/ws/remote/:id`）复用同一 TLS 监听，浏览器端按页面协议自动选择 `wss:`，服务端不需要为 WS 单独配置。

## 环境变量

| 变量 | 用途 | 默认 | 错误行为 |
| --- | --- | --- | --- |
| `ZCODE_SERVER_TLS_CERT` | PEM 证书文件路径 | 未设置 | 与 KEY 同时设置才生效 |
| `ZCODE_SERVER_TLS_KEY` | PEM 私钥文件路径 | 未设置 | 与 CERT 同时设置才生效 |
| `ZCODE_SERVER_TLS_SELF_SIGNED` | 设为 `1` 启用自动自签 | 未设置 | 生成/读写失败时启动失败 |

- 只设置 CERT 或 KEY 之一 → 启动失败，报错指出缺少哪一项。
- CERT/KEY 与 SELF_SIGNED 同时设置 → CERT/KEY 优先，忽略 SELF_SIGNED。
- 自签证书与私钥缓存于 `<应用配置目录>/certs/web-server-self-signed-cert.pem` 与 `web-server-self-signed-key.pem`，私钥文件权限收紧为 `0600`。

## 接口

- `TlsMaterial { cert: string; key: string }`：PEM 文本，直接传给 `node:https.createServer`。
- `readTlsMaterialFiles(certPath, keyPath)`：读取显式证书文件，读不到或不可读时抛出含路径的错误。
- `ensureSelfSignedTlsMaterial()`：确保自签证书存在并返回材料；CN 为占位身份，SAN 覆盖 `localhost`、本机 hostname、`127.0.0.1`、`::1`，有效期 10 年，2048 位 RSA。
- `resolveWebServerTlsMaterial(input)`：按上述优先级解析 TLS 材料，未配置时返回 `undefined`。
- `createHttpServer(services, port, options)` 新增 `options.tls?: TlsMaterial`；内部据此用 `node:https` 创建监听，并决定日志协议前缀与 cookie `Secure` 属性。

## 状态与所有权

- TLS 材料是启动时一次性解析的不可变输入；服务运行期不重新加载证书。
- 自签证书文件的所有者是 `packages/server` 的 TLS 模块；其他模块（如 `packages/services` 的出口代理 CA）各自维护独立证书，互不共享。

## 验收场景

1. 无任何 TLS 配置：服务以 `http://` 启动，行为不变。
2. 同时配置 CERT/KEY：服务以 `https://` 启动，HTTPS 请求返回 `/api/server-info`，WSS 可完成 upgrade。
3. 只配置 CERT 或只配置 KEY：启动失败，错误信息指明缺少项。
4. 证书文件路径不存在：启动失败，错误信息包含路径。
5. `ZCODE_SERVER_TLS_SELF_SIGNED=1`：首次启动生成自签证书；重启后复用同一证书（指纹不变）。
6. TLS + `ZCODE_SERVER_AUTH_TOKEN`：通过 `?token=` 换取的 cookie 带 `Secure` 属性。
7. 浏览器访问 HTTPS 页面后 WebSocket 以 `wss://` 连接（客户端 `packages/web/src/main.tsx` 已按页面协议切换，服务端无需改动）。
