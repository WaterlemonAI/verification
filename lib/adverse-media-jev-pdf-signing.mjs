import { readFileSync } from 'node:fs';
import { KeyVaultStore } from './api-store.mjs';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// An exportable Key Vault certificate has a same-named backing secret whose
// application/x-pkcs12 value is base64 PFX data. Keep it in memory only.
export async function loadJevPdfSigningFromKeyVault({ vaultUri, secretName,
  managedIdentityClientId, fetchImpl, store } = {}) {
  if (!secretName || !/^[a-zA-Z0-9-]{1,127}$/.test(secretName))
    throw new Error('pdf_signing_key_vault_secret_name_required');
  if (!store && (!vaultUri || !/^https:\/\/[^/]+\.vault\.azure\.net\/?$/i.test(vaultUri)))
    throw new Error('pdf_signing_key_vault_uri_required');
  const vault = store || new KeyVaultStore({ vaultUri, managedIdentityClientId, fetchImpl });
  const document = await vault.getSecretDocument(secretName, { fresh: true });
  if (!document?.value) throw new Error('pdf_signing_key_vault_secret_missing');
  if (document.contentType !== 'application/x-pkcs12')
    throw new Error('pdf_signing_key_vault_p12_required');
  const encoded = document.value.trim();
  if (!BASE64.test(encoded)) throw new Error('pdf_signing_key_vault_p12_invalid');
  const p12Bytes = Buffer.from(encoded, 'base64');
  if (p12Bytes.length < 100) throw new Error('pdf_signing_key_vault_p12_invalid');
  return { p12Bytes, passphrase: '', name: 'KYCProbe report signer' };
}

export async function loadIncidentReportSigningIdentity(env = process.env) {
  if (env.JEV_PDF_SIGNING_KEY_VAULT_URI || env.JEV_PDF_SIGNING_KEY_VAULT_SECRET_NAME)
    return loadJevPdfSigningFromKeyVault({
      vaultUri: env.JEV_PDF_SIGNING_KEY_VAULT_URI,
      secretName: env.JEV_PDF_SIGNING_KEY_VAULT_SECRET_NAME,
      managedIdentityClientId: env.RUNTIME_IDENTITY_CLIENT_ID
    });
  if (env.NODE_ENV !== 'production' && env.JEV_PDF_SIGNING_P12_PATH
    && typeof env.JEV_PDF_SIGNING_P12_PASSWORD === 'string')
    return { p12Bytes: readFileSync(env.JEV_PDF_SIGNING_P12_PATH),
      passphrase: env.JEV_PDF_SIGNING_P12_PASSWORD,
      name: env.JEV_PDF_SIGNING_NAME || 'KYCProbe report signer' };
  throw new Error('pdf_signing_certificate_required');
}
