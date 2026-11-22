/**
 * Solid Ten: a loader that throws a 429 Response sets Retry-After on it. React Router hands the
 * thrown Response's headers to the route's `headers` export as `errorHeaders`; this passes the
 * Retry-After on to the page response.
 */
export const retryAfterRouteHeaders = ({ errorHeaders }: { errorHeaders?: Headers }) => {
  const headers = new Headers();
  const retryAfter = errorHeaders?.get('Retry-After');

  if (retryAfter) {
    headers.set('Retry-After', retryAfter);
  }

  return headers;
};
