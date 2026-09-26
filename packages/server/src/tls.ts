import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "@zcode/services/node";

// Web 服务的 TLS 材料解析，行为规范见 spec/web-server-tls.md：
// 显式证书/私钥文件优先，其次自动自签，都未配置则返回 undefined 保持纯 HTTP。

const SELF_SIGNED_CERT_FILE = "web-server-self-signed-cert.pem";
const SELF_SIGNED_KEY_FILE = "web-server-self-signed-key.pem";
const SELF_SIGNED_VALIDITY_YEARS = 10;
const SELF_SIGNED_KEY_BITS = 2048;

export interface TlsMaterial {
  cert: string;
  key: string;
}

export interface WebServerTlsInput {
  certPath?: string;
  keyPath?: string;
  selfSigned?: boolean;
}

async function readTlsMaterialFiles(certPath: string, keyPath: string): Promise<TlsMaterial> {
  try {
    const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
    return { cert, key };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 TLS 证书材料 (cert: ${certPath}, key: ${keyPath}): ${reason}`);
  }
}

async function selfSignedCertPaths(): Promise<{ certPath: string; keyPath: string }> {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, SELF_SIGNED_CERT_FILE),
    keyPath: join(certDir, SELF_SIGNED_KEY_FILE),
  };
}

/**
 * 确保自签证书存在；缺失时生成。幂等：证书与私钥都已存在时直接复用，
 * 保证指纹稳定、浏览器「仍然继续」信任后不漂移（事实源是文件系统）。
 */
export async function ensureSelfSignedTlsMaterial(): Promise<TlsMaterial> {
  const { certPath, keyPath } = await selfSignedCertPaths();
  try {
    const [cert, key] = await Promise.all([readFile(certPath, "utf8"), readFile(keyPath, "utf8")]);
    return { cert, key };
  } catch {
    // 文件缺失或不可读时重新生成；生成后写盘保证下次启动复用。
  }

  const { certPem, keyPem } = generateSelfSignedCert();
  await mkdir(dirname(certPath), { recursive: true });
  // 私钥含敏感材料，权限收紧到 0600；证书公钥可读。
  await writeFile(certPath, certPem, { mode: 0o644 });
  await writeFile(keyPath, keyPem, { mode: 0o600 });
  return { cert: certPem, key: keyPem };
}

function generateSelfSignedCert(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(SELF_SIGNED_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // 用密码学随机数做序列号，首字节清零避免被解析成负数。
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + SELF_SIGNED_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Web Server (self-signed)" },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // 自签：issuer == subject
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: true,
      keyEncipherment: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" }, // DNS
        { type: 2, value: hostname() },
        { type: 7, ip: "127.0.0.1" },
        { type: 7, ip: "::1" },
      ],
    },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * 按优先级解析 TLS 材料：显式证书对 > 自动自签 > 纯 HTTP。
 * 配置不完整或不可用时抛错，由调用方决定 fail fast，绝不静默回退 HTTP。
 */
export async function resolveWebServerTlsMaterial(
  input: WebServerTlsInput,
): Promise<TlsMaterial | undefined> {
  const certPath = input.certPath?.trim();
  const keyPath = input.keyPath?.trim();
  if (certPath && keyPath) {
    return readTlsMaterialFiles(certPath, keyPath);
  }
  if (certPath || keyPath) {
    throw new Error(
      certPath
        ? `设置了 ZCODE_SERVER_TLS_CERT (${certPath}) 但缺少 ZCODE_SERVER_TLS_KEY，两项必须同时配置`
        : `设置了 ZCODE_SERVER_TLS_KEY (${keyPath}) 但缺少 ZCODE_SERVER_TLS_CERT，两项必须同时配置`,
    );
  }
  if (input.selfSigned) {
    return ensureSelfSignedTlsMaterial();
  }
  return undefined;
}
