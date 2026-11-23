import { AppError, AppErrorCode } from '../../errors/app-error';
import { ZDocumentAuthOptionsSchema, ZRecipientAuthOptionsSchema } from '../../types/document-auth';
import { isPasswordSigninAvailable } from '../../utils/password-signin-availability';

export const ACTION_AUTH_PERMISSION_MESSAGE = 'You do not have permission to set the action auth';

export const PASSWORD_ACTION_AUTH_REFUSED_MESSAGE =
  '"Require password" cannot be used on this server: password sign-in is turned off, so signers cannot have a password. Choose another option, such as an emailed code.';

const copyRefusedMessage = (what: 'template' | 'document') =>
  `This ${what} uses "Require password", which cannot be used on this server: password sign-in is turned off, so signers cannot have a password. Remove it from the ${what}, then try again.`;

export const TEMPLATE_PASSWORD_ACTION_AUTH_REFUSED_MESSAGE = copyRefusedMessage('template');

type TActionAuthList = readonly (string | null | undefined)[] | null | undefined;

export type AssertActionAuthAllowedOptions = {
  /** The action auth this change stores (document "globalActionAuth" or a recipient's "actionAuth"). */
  next: TActionAuthList;
  /** What is stored now; empty for something new. */
  previous?: TActionAuthList;
  /** The team's plan flags. Upstream allows action auth only with cfr21. */
  organisationClaim: { flags: { cfr21?: boolean | null } | Record<string, unknown> };
  /**
   * `input`: the caller chose it (web app, API v1, API v2). `template`: copied from a template into
   * a new document (Use Template, bulk send, API generate-document, direct link): the plan check
   * is not repeated, but a copy is new, so a PASSWORD copied with password sign-in off is refused.
   */
  source?: 'input' | 'template';
  /** What a copy is made from, for the message. */
  copiedFrom?: 'template' | 'document';
};

/**
 * Solid Ten Sign (O-F2): the one check for action-auth settings. Every path that creates or
 * changes a document's or a recipient's action auth calls it before writing:
 * - plan: a new action auth needs the cfr21 flag (401, upstream text);
 * - password sign-in off: no new PASSWORD (400, plain reason) (N-5).
 *
 * Taking action auth off, or saving what is already stored, is always allowed, so a sender can
 * clear a PASSWORD set earlier even without cfr21 (O-F7).
 */
export const assertActionAuthAllowed = ({
  next,
  previous = [],
  organisationClaim,
  source = 'input',
  copiedFrom = 'template',
}: AssertActionAuthAllowedOptions) => {
  const nextList = (next ?? []).filter((value): value is string => typeof value === 'string' && value !== '');

  if (nextList.length === 0) {
    return;
  }

  const previousList = source === 'template' ? [] : (previous ?? []);
  const added = nextList.filter((value) => !previousList.includes(value));

  if (added.length === 0) {
    return;
  }

  const flags = organisationClaim.flags as { cfr21?: boolean | null };

  if (source === 'input' && !flags.cfr21) {
    throw new AppError(AppErrorCode.UNAUTHORIZED, { message: ACTION_AUTH_PERMISSION_MESSAGE, statusCode: 401 });
  }

  if (added.includes('PASSWORD') && !isPasswordSigninAvailable()) {
    throw new AppError(AppErrorCode.INVALID_BODY, {
      message: source === 'template' ? copyRefusedMessage(copiedFrom) : PASSWORD_ACTION_AUTH_REFUSED_MESSAGE,
      statusCode: 400,
    });
  }
};

/**
 * The same check for a new document made from a template: the template's document action auth
 * and each recipient's action auth are copied, so they are new for the document.
 */
export const assertTemplateActionAuthCopyAllowed = (
  template: {
    authOptions: unknown;
    recipients: { authOptions: unknown }[];
  },
  copiedFrom: 'template' | 'document' = 'template',
) => {
  const organisationClaim = { flags: {} };
  const documentAuth = ZDocumentAuthOptionsSchema.safeParse(template.authOptions ?? {});

  assertActionAuthAllowed({
    next: documentAuth.success ? documentAuth.data.globalActionAuth : [],
    organisationClaim,
    source: 'template',
    copiedFrom,
  });

  for (const recipient of template.recipients) {
    const recipientAuth = ZRecipientAuthOptionsSchema.safeParse(recipient.authOptions ?? {});

    assertActionAuthAllowed({
      next: recipientAuth.success ? recipientAuth.data.actionAuth : [],
      organisationClaim,
      source: 'template',
      copiedFrom,
    });
  }
};
