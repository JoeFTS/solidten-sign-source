import { describe, expect, it } from 'vitest';

import { buildPdfChildEnv, PDF_CHILD_ENV_NAMES } from './child-env';

describe('PDF child environment (SEC3-M1)', () => {
  it('passes only the exact names on the list: basics, temp folder, signing certificate', () => {
    const env = buildPdfChildEnv({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      NEXT_PRIVATE_ST_PDF_TEMP_DIR: '/var/tmp/pdf',
      NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH: '/opt/documenso/cert.p12',
      NEXT_PRIVATE_SIGNING_PASSPHRASE: 'secret',
      NEXT_PUBLIC_WEBAPP_URL: 'https://sign.example',
    });

    expect(env).toEqual({
      NODE_ENV: 'production',
      PATH: '/usr/bin',
      NEXT_PRIVATE_ST_PDF_TEMP_DIR: '/var/tmp/pdf',
      NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH: '/opt/documenso/cert.p12',
      NEXT_PRIVATE_SIGNING_PASSPHRASE: 'secret',
      NEXT_PUBLIC_WEBAPP_URL: 'https://sign.example',
    });
  });

  it('never passes the database, the keys, the auth secret or other credentials (the security review list)', () => {
    const env = buildPdfChildEnv({
      NEXT_PRIVATE_DATABASE_URL: 'postgres://db',
      NEXT_PRIVATE_DIRECT_DATABASE_URL: 'postgres://db',
      NEXT_PRIVATE_DATABASE_REPLICA_URLS: 'postgres://replica',
      NEXT_PRIVATE_ENCRYPTION_KEY: 'k1',
      NEXT_PRIVATE_ENCRYPTION_SECONDARY_KEY: 'k2',
      NEXT_PRIVATE_TELEMETRY_KEY: 't',
      NEXT_PRIVATE_TELEMETRY_HOST: 'h',
      NEXTAUTH_SECRET: 'auth',
      NEXT_PRIVATE_SMTP_PASSWORD: 'mail',
      NEXT_PRIVATE_INTERNAL_WEBAPP_URL: 'http://localhost:3000',
      NEXT_PRIVATE_ST_HEALTH_TOKEN: 'health',
      NEXT_PRIVATE_UPLOAD_SECRET_ACCESS_KEY: 's3',
      NEXT_PRIVATE_STRIPE_API_KEY: 'pay',
      NEXT_PRIVATE_ST_SMS_ALLOW_FAKE_IN_PRODUCTION: 'true',
      DOCUMENSO_DISABLE_TELEMETRY: 'true',
      AWS_SECRET_ACCESS_KEY: 'aws',
      SSH_AUTH_SOCK: '/tmp/agent',
    });

    expect(env).toEqual({});
  });

  it('the list holds no prefix and no database or key name', () => {
    for (const name of PDF_CHILD_ENV_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*[A-Z0-9]$/);
      expect(name).not.toMatch(/DATABASE|ENCRYPTION|SECRET_ACCESS|NEXTAUTH|TELEMETRY|SMTP|HEALTH_TOKEN/);
    }
  });
});
