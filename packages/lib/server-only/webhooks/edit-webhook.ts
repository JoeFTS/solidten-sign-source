import { prisma } from '@documenso/prisma';
import type { Prisma } from '@prisma/client';

import { TEAM_MEMBER_ROLE_PERMISSIONS_MAP } from '../../constants/teams';
import { AppError, AppErrorCode } from '../../errors/app-error';
import { buildTeamWhereQuery } from '../../utils/teams';
import { assertNotPrivateUrl } from './assert-webhook-url';
import { assertWebhookUrlAllowed } from './webhook-url-rule';

export type EditWebhookOptions = {
  id: string;
  data: Omit<Prisma.WebhookUpdateInput, 'id' | 'userId' | 'teamId'>;
  userId: number;
  teamId: number;
};

export const editWebhook = async ({ id, data, userId, teamId }: EditWebhookOptions) => {
  const teamWhere = buildTeamWhereQuery({
    teamId,
    userId,
    roles: TEAM_MEMBER_ROLE_PERMISSIONS_MAP['MANAGE_TEAM'],
  });

  // Solid Ten Sign (AUD-C7): the address check (with its DNS lookup) runs after the MANAGE_TEAM check.
  const webhook = await prisma.webhook.findFirst({ where: { id, team: teamWhere }, select: { id: true } });

  if (!webhook) {
    throw new AppError(AppErrorCode.NOT_FOUND, { message: 'Webhook not found' });
  }

  if (typeof data.webhookUrl === 'string') {
    assertWebhookUrlAllowed(data.webhookUrl);
    // Solid Ten Sign (S-L4): a hostname that resolves to a private address is refused at save time too.
    await assertNotPrivateUrl(data.webhookUrl);
  }

  return await prisma.webhook.update({
    where: {
      id,
      team: teamWhere,
    },
    data: {
      ...data,
    },
  });
};
