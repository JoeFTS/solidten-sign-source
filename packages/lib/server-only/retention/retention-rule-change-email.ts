import { SolidTenNoticeTemplate } from '@documenso/email/templates/solidten-notice';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import { OrganisationMemberRole, Prisma, TeamMemberRole } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import type { TRetentionSettings } from '../../utils/retention';
import { withoutServiceAccounts } from '../email/deliverable-recipients';
import { getEmailContext } from '../email/get-email-context';
import { RETENTION_PURGE_GRACE_DAYS, type RetentionScope } from './retention-governance';

/**
 * Solid Ten Sign (S-M3): tell the organisation admins, and for a team rule the team
 * admins, that the retention rule was changed and by whom.
 */
const describeRule = (rule: TRetentionSettings | null) => {
  if (!rule?.enabled) {
    return msg`Automatic deletion is off.`;
  }

  return rule.action === 'PURGE'
    ? msg`Finished documents are permanently deleted ${rule.days} days after they finish.`
    : msg`Finished documents are moved to the bin ${rule.days} days after they finish.`;
};

export const emailAdminsAboutRuleChange = async ({
  scope,
  organisationId,
  actor,
  next,
}: {
  scope: RetentionScope;
  organisationId: string;
  actor: { email: string; name: string | null };
  next: TRetentionSettings | null;
}) => {
  const admins = await prisma.organisationMember.findMany({
    where: {
      organisationId,
      OR: [
        { organisationGroupMembers: { some: { group: { organisationRole: OrganisationMemberRole.ADMIN } } } },
        ...(scope.type === 'team'
          ? [
              {
                organisationGroupMembers: {
                  some: {
                    group: { teamGroups: { some: { teamId: scope.teamId, teamRole: TeamMemberRole.ADMIN } } },
                  },
                },
              },
            ]
          : [
              // Solid Ten Sign (RT2-M1): an organisation rule also changes every team that
              // inherits it, so their admins hear about it too.
              {
                organisationGroupMembers: {
                  some: {
                    group: {
                      teamGroups: {
                        some: {
                          teamRole: TeamMemberRole.ADMIN,
                          team: {
                            organisationId,
                            OR: [
                              { teamGlobalSettings: { retentionSettings: { equals: Prisma.DbNull } } },
                              { teamGlobalSettings: { retentionSettings: { equals: Prisma.JsonNull } } },
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            ]),
      ],
    },
    select: { user: { select: { email: true, name: true } } },
  });

  if (admins.length === 0) {
    return;
  }

  const { branding, emailLanguage, senderEmail, emailsDisabled, emailTransport } = await getEmailContext({
    emailType: 'INTERNAL',
    source: scope.type === 'team' ? { type: 'team', teamId: scope.teamId } : { type: 'organisation', organisationId },
  });

  if (emailsDisabled) {
    return;
  }

  const i18n = await getI18nInstance(emailLanguage);
  const who = actor.name ? `${actor.name} (${actor.email})` : actor.email;
  const graceDays = RETENTION_PURGE_GRACE_DAYS;

  const template = createElement(SolidTenNoticeTemplate, {
    heading: i18n._(msg`The document retention rule was changed`),
    paragraphs: [
      i18n._(msg`${who} changed the rule for deleting finished documents.`),
      i18n._(describeRule(next)),
      i18n._(
        msg`A rule that deletes documents permanently starts ${graceDays} days after it is changed. If you did not expect this change, review the settings now.`,
      ),
    ],
    assetBaseUrl: NEXT_PUBLIC_WEBAPP_URL(),
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  await emailTransport.sendMail({
    to: withoutServiceAccounts(admins.map((admin) => ({ name: admin.user.name ?? '', address: admin.user.email }))),
    from: senderEmail,
    subject: i18n._(msg`The document retention rule was changed`),
    html,
    text,
  });
};
