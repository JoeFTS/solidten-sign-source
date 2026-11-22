import { getSignerReassignOptions } from '@documenso/lib/server-only/recipient-reassign/get-signer-reassign-options';

import { procedure } from '../trpc';
import {
  ZGetSignerReassignOptionsRequestSchema,
  ZGetSignerReassignOptionsResponseSchema,
} from './reassign-recipient.types';

export const getSignerReassignOptionsRoute = procedure
  .input(ZGetSignerReassignOptionsRequestSchema)
  .output(ZGetSignerReassignOptionsResponseSchema)
  .query(async ({ input }) => {
    return await getSignerReassignOptions({ token: input.token });
  });
