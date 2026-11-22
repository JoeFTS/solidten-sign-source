import { prisma } from '@documenso/prisma';
import type { WebhookTriggerEvents } from '@prisma/client';

import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertNotPrivateUrl } from './assert-webhook-url';
import { assertWebhookUrlAllowed } from './webhook-url-rule';

export interface CreateWebhookOptions {
  webhookUrl: string;
  eventTriggers: WebhookTriggerEvents[];
  secret: string | null;
  enabled: boolean;
  userId: number;
  teamId: number;
}

export const createWebhook = async ({
  webhookUrl,
  eventTriggers,
  secret,
  enabled,
  userId,
  teamId,
}: CreateWebhookOptions) => {
  const team = await prisma.team.findFirst({
    where: buildTeamWhereQuery({
      teamId,
      userId,
      roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
    }),
  });

  if (!team) {
    throw new AppError(AppErrorCode.NOT_FOUND, {
      message: 'Team not found',
    });
  }

  // Solid Ten Sign (AUD-C7): the address check (with its DNS lookup) runs after the MANAGE_TEAM check.
  assertWebhookUrlAllowed(webhookUrl);
  // Solid Ten Sign (S-L4): a hostname that resolves to a private address is refused at save time too.
  await assertNotPrivateUrl(webhookUrl);

  return await prisma.webhook.create({
    data: {
      webhookUrl,
      eventTriggers,
      secret,
      enabled,
      userId,
      teamId,
    },
  });
};
