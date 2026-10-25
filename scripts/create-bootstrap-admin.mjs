import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outputPath = resolve(process.argv[2] || 'bootstrap-credentials.json');
if (existsSync(outputPath)) {
  console.error(`Refusing to overwrite existing credential file: ${outputPath}`);
  process.exit(1);
}

const adminApiKey = `ai7_admin_${randomBytes(36).toString('base64url')}`;
const document = {
  admin_url: 'https://api.ai7uae.com/admin',
  admin_api_key: adminApiKey,
  admin_api_key_sha256: createHash('sha256').update(adminApiKey).digest('hex'),
  created_at: new Date().toISOString(),
  handling: 'Store the API key in a password manager, then remove this local file.'
};

writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
chmodSync(outputPath, 0o600);
console.log(`Created restricted bootstrap credential file: ${outputPath}`);
