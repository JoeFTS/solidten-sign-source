/**
 * Solid Ten: the environment the PDF child gets (SEC3-M1).
 *
 * The child only runs PDF operations on files (pdf-operations.ts): normalise an upload, read a
 * page size, and the PDF part of a seal, which signs. It never opens the database. So it gets an
 * exact list of names: the signing certificate settings (it signs), its temp folder, the public
 * app URL, and a few basics. Not the database URLs, the encryption keys, the auth secret, mail,
 * payment, sign-in, text-message, telemetry or AI credentials, nor anything else of the machine.
 * Before, it got every NEXT_PRIVATE_ variable (the database URL and both encryption keys among
 * them), readable from /proc/<pid>/environ.
 */
export const PDF_CHILD_ENV_NAMES: readonly string[] = [
  // Basics.
  'NODE_ENV',
  'PATH',
  'HOME',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',

  // Its temp folder (temp-files.ts).
  'NEXT_PRIVATE_ST_PDF_TEMP_DIR',

  // The app URL the PDF code may print (public).
  'NEXT_PUBLIC_WEBAPP_URL',

  // Signing (packages/signing): the seal's PDF part signs in the child.
  'NEXT_PRIVATE_SIGNING_TRANSPORT',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_PATH',
  'NEXT_PRIVATE_SIGNING_LOCAL_FILE_CONTENTS',
  'NEXT_PRIVATE_SIGNING_PASSPHRASE',
  'NEXT_PRIVATE_SIGNING_TIMESTAMP_AUTHORITY',
  'NEXT_PRIVATE_SIGNING_REASON',
  'NEXT_PRIVATE_SIGNING_CSC_SIGNATURE_LEVEL',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_KEY_PATH',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_PUBLIC_CRT_FILE_PATH',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_PUBLIC_CRT_FILE_CONTENTS',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_CERT_CHAIN_FILE_PATH',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_CERT_CHAIN_CONTENTS',
  'NEXT_PRIVATE_SIGNING_GCLOUD_HSM_SECRET_MANAGER_CERT_PATH',
  'NEXT_PRIVATE_SIGNING_GCLOUD_APPLICATION_CREDENTIALS_CONTENTS',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NEXT_PUBLIC_SIGNING_CONTACT_INFO',
  'NEXT_PUBLIC_SIGNING_TRANSPORT_IS_CSC',
];

const ALLOWED = new Set(PDF_CHILD_ENV_NAMES);

export const buildPdfChildEnv = (source: Record<string, string | undefined> = process.env): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED.has(name)) {
      result[name] = value;
    }
  }

  return result;
};
