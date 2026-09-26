// node-forge 1.4.0 没有自带类型，也未安装 @types/node-forge。
// 参考 packages/services/src/runtime-tools/node-forge.d.ts，只声明 web 服务自签
// 证书用到的最小子集；SAN 的 IP 地址扩展需要 ForgeCertExtension 支持 altNames。
declare module "node-forge" {
  interface ForgeKey {
    n?: unknown;
  }
  interface ForgeKeyPair {
    publicKey: ForgeKey;
    privateKey: ForgeKey;
  }
  interface ForgeCertAttr {
    name?: string;
    shortName?: string;
    type?: string;
    value?: string;
  }
  interface ForgeAltName {
    type: number;
    value?: string;
    ip?: string;
  }
  interface ForgeCertExtension {
    name: string;
    cA?: boolean;
    critical?: boolean;
    keyCertSign?: boolean;
    cRLSign?: boolean;
    digitalSignature?: boolean;
    keyEncipherment?: boolean;
    serverAuth?: boolean;
    clientAuth?: boolean;
    altNames?: ForgeAltName[];
  }
  interface ForgeMessageDigest {
    update(msg: string): ForgeMessageDigest;
  }
  interface ForgeCertificate {
    publicKey: ForgeKey;
    serialNumber: string;
    validity: { notBefore: Date; notAfter: Date };
    setSubject(attrs: ForgeCertAttr[]): void;
    setIssuer(attrs: ForgeCertAttr[]): void;
    setExtensions(exts: ForgeCertExtension[]): void;
    sign(key: ForgeKey, md?: ForgeMessageDigest): void;
  }
  interface ForgeStatic {
    pki: {
      rsa: { generateKeyPair(bits: number): ForgeKeyPair };
      createCertificate(): ForgeCertificate;
      certificateToPem(cert: ForgeCertificate): string;
      privateKeyToPem(key: ForgeKey): string;
    };
    md: { sha256: { create(): ForgeMessageDigest } };
  }
  const forge: ForgeStatic;
  export = forge;
}
