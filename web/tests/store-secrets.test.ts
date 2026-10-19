// Secrets en DB cifrada (issue #20): cripto pura + overlay sin BD.
// Corre con: npm test (node:test stdlib vía tsx, sin dependencias nuevas).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  isEncryptedValue,
  maskSecret,
  overlaySecret,
  parseEncryptionKey,
} from "@/lib/secrets-crypto";

const KEY = randomBytes(32);
const OTHER = randomBytes(32);

describe("parseEncryptionKey", () => {
  it("acepta base64 de 32 bytes", () => {
    const raw = randomBytes(32).toString("base64");
    assert.equal(parseEncryptionKey(raw).length, 32);
  });
  it("acepta hex64", () => {
    const raw = randomBytes(32).toString("hex");
    assert.equal(parseEncryptionKey(raw).length, 32);
  });
  it("rechaza claves cortas", () => {
    assert.throws(() => parseEncryptionKey("corta"), /inválida/);
    assert.throws(() => parseEncryptionKey(""), /vacía/);
  });
});

describe("encrypt/decrypt (AES-256-GCM)", () => {
  it("roundtrip", () => {
    const ct = encryptSecret("SG.mi-key-secreta", KEY);
    assert.equal(decryptSecret(ct, KEY), "SG.mi-key-secreta");
  });
  it("el cifrado nunca es plaintext ni determinista", () => {
    const a = encryptSecret("mismo", KEY);
    const b = encryptSecret("mismo", KEY);
    assert.ok(!a.includes("mismo"));
    assert.ok(isEncryptedValue(a));
    assert.notEqual(a, b);
  });
  it("key incorrecta falla", () => {
    const ct = encryptSecret("x", KEY);
    assert.throws(() => decryptSecret(ct, OTHER), /descifrado falló/);
  });
  it("payload alterado falla (tag GCM)", () => {
    const ct = encryptSecret("hola", KEY);
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered-tampered!!").toString("base64url");
    assert.throws(() => decryptSecret(parts.join("."), KEY), /descifrado falló/);
  });
  it("formato inválido falla sin pánico", () => {
    assert.throws(() => decryptSecret("plaintext", KEY), /no es un secreto cifrado/);
    assert.throws(() => decryptSecret("v1.solo.dos", KEY), /no es un secreto cifrado/);
    assert.equal(isEncryptedValue("plaintext"), false);
    assert.equal(isEncryptedValue(null), false);
  });
  it("soporta vacío y unicode", () => {
    assert.equal(decryptSecret(encryptSecret("", KEY), KEY), "");
    assert.equal(decryptSecret(encryptSecret("🔑 ñoño S/65", KEY), KEY), "🔑 ñoño S/65");
  });
});

describe("maskSecret / fingerprintSecret", () => {
  it("nunca muestra la key completa", () => {
    const m = maskSecret("SG.abcdefgh1234");
    assert.ok(!m.includes("abcdefgh"));
    assert.ok(m.endsWith("1234"));
    assert.equal(maskSecret(""), "••••••••");
    assert.equal(maskSecret(null), "••••••••");
    assert.equal(maskSecret("corta"), "••••••••");
  });
  it("fingerprint estable y sin el secreto", () => {
    const f1 = fingerprintSecret("SG.abc");
    const f2 = fingerprintSecret("SG.abc");
    const f3 = fingerprintSecret("SG.abd");
    assert.equal(f1, f2);
    assert.notEqual(f1, f3);
    assert.ok(!f1.includes("SG.abc"));
    assert.equal(f1.length, 16);
  });
});

describe("overlaySecret (DB manda, JSON es fallback dev)", () => {
  it("DB no vacía manda", () => {
    assert.equal(overlaySecret("json-old", "db-new"), "db-new");
  });
  it("DB vacía cae al JSON (migración pendiente)", () => {
    assert.equal(overlaySecret("json-old", ""), "json-old");
    assert.equal(overlaySecret("json-old", null), "json-old");
    assert.equal(overlaySecret("json-old", undefined), "json-old");
  });
  it("ambos vacíos → vacío", () => {
    assert.equal(overlaySecret("", ""), "");
  });
});
