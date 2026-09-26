import assert from "node:assert/strict";
import { once } from "node:events";
import { get as httpsGet } from "node:https";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { ServiceCollection } from "@zcode/services";
import { getAppConfigDir, setDataBaseDir } from "@zcode/services/node";
import { createHttpServer } from "../src/http.js";
import { ensureSelfSignedTlsMaterial, resolveWebServerTlsMaterial } from "../src/tls.js";

async function withTempBaseDir<T>(fn: (baseDir: string) => Promise<T>): Promise<T> {
  const baseDir = await mkdtemp(join(tmpdir(), "zcode-server-tls-test-"));
  setDataBaseDir(baseDir);
  try {
    return await fn(baseDir);
  } finally {
    setDataBaseDir(null);
    await rm(baseDir, { recursive: true, force: true });
  }
}

function httpsGetJson(url: string): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers,
        }),
      );
    });
    request.on("error", reject);
  });
}

function listenPort(server: { address(): unknown }): number {
  const address = server.address();
  assert.ok(address && typeof address === "object" && "port" in address);
  return address.port;
}

async function listenEphemeralPort(server: { address(): unknown }): Promise<number> {
  await once(server, "listening");
  return listenPort(server);
}

test("resolveWebServerTlsMaterial：未配置任何 TLS 材料时返回 undefined", async () => {
  assert.equal(await resolveWebServerTlsMaterial({}), undefined);
});

test("resolveWebServerTlsMaterial：只配置 CERT 或只配置 KEY 时启动失败并指明缺失项", async () => {
  await assert.rejects(
    () => resolveWebServerTlsMaterial({ certPath: "/tmp/only-cert.pem" }),
    /ZCODE_SERVER_TLS_KEY/,
  );
  await assert.rejects(
    () => resolveWebServerTlsMaterial({ keyPath: "/tmp/only-key.pem" }),
    /ZCODE_SERVER_TLS_CERT/,
  );
});

test("resolveWebServerTlsMaterial：显式证书对可用时返回材料，文件缺失时报错", async () => {
  await withTempBaseDir(async (baseDir) => {
    const certPath = join(baseDir, "cert.pem");
    const keyPath = join(baseDir, "key.pem");
    await writeFile(certPath, "CERT-PEM");
    await writeFile(keyPath, "KEY-PEM");
    const material = await resolveWebServerTlsMaterial({ certPath, keyPath });
    assert.deepEqual(material, { cert: "CERT-PEM", key: "KEY-PEM" });

    await assert.rejects(
      () => resolveWebServerTlsMaterial({ certPath: join(baseDir, "missing.pem"), keyPath }),
      /missing\.pem/,
    );
  });
});

test("自签证书幂等：两次生成返回同一证书，私钥权限收紧到 0600", async () => {
  await withTempBaseDir(async () => {
    const first = await ensureSelfSignedTlsMaterial();
    const second = await ensureSelfSignedTlsMaterial();
    assert.equal(first.cert, second.cert);
    assert.equal(first.key, second.key);

    const keyStat = await stat(join(getAppConfigDir(), "certs", "web-server-self-signed-key.pem"));
    assert.equal(keyStat.mode & 0o777, 0o600);
    const certStat = await stat(
      join(getAppConfigDir(), "certs", "web-server-self-signed-cert.pem"),
    );
    assert.ok(certStat.isFile());
  });
});

test("HTTPS 监听：server-info 可访问，WSS 可完成 upgrade", async () => {
  await withTempBaseDir(async () => {
    const tls = await ensureSelfSignedTlsMaterial();
    const server = createHttpServer(new ServiceCollection(), 0, {
      host: "127.0.0.1",
      tls,
    });
    const port = await listenEphemeralPort(server);

    try {
      const response = await httpsGetJson(`https://127.0.0.1:${port}/api/server-info`);
      assert.equal(response.status, 200);
      const info = JSON.parse(response.body) as { serverId: string };
      assert.ok(info.serverId);

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { rejectUnauthorized: false });
        ws.once("open", () => {
          ws.close();
          resolve();
        });
        ws.once("error", reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("TLS + 访问令牌：?token 换取的 cookie 带 Secure 属性", async () => {
  await withTempBaseDir(async () => {
    const tls = await ensureSelfSignedTlsMaterial();
    const server = createHttpServer(new ServiceCollection(), 0, {
      host: "127.0.0.1",
      authToken: "test-token",
      authRequired: true,
      tls,
    });
    const port = await listenEphemeralPort(server);

    try {
      const response = await httpsGetJson(
        `https://127.0.0.1:${port}/api/server-info?token=test-token`,
      );
      assert.equal(response.status, 200);
      const setCookie = response.headers["set-cookie"];
      assert.ok(Array.isArray(setCookie) && setCookie.length > 0);
      assert.match(setCookie[0]!, /zcode_lite_token=test-token/);
      assert.match(setCookie[0]!, /;\s*Secure/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
