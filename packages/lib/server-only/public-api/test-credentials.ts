import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import { getApiTokenByToken } from '@documenso/lib/server-only/public-api/get-api-token-by-token';

export const testCredentialsHandler = async (req: Request) => {
  try {
    const authorization = req.headers.get('authorization');

    // Support for both "Authorization: Bearer api_xxx" and "Authorization: api_xxx"
    const [token] = (authorization || '').split('Bearer ').filter((s) => s.length > 0);

    // Solid Ten Sign (F5): a missing, unknown or expired token is a 401, as on the other v1 routes.
    if (!token) {
      return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }

    const result = await getApiTokenByToken({ token, bypassRateLimit: true });

    return Response.json({
      name: result.team?.name ?? result.user.name,
    });
  } catch (err) {
    const error = AppError.parseError(err);

    if (error.code === AppErrorCode.UNAUTHORIZED || error.code === AppErrorCode.EXPIRED_CODE) {
      return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }

    return Response.json(
      {
        message: 'Internal Server Error',
      },
      { status: 500 },
    );
  }
};
