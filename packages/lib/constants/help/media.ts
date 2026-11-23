import { env } from '../../utils/env';
import { resolveHelpMediaUrl } from './media-url';
import type { HelpVideo } from './types';

export { DEFAULT_HELP_MEDIA_URL, getHelpMediaCspSources, resolveHelpMediaUrl } from './media-url';

/** The help media base (NEXT_PUBLIC_ST_HELP_MEDIA_URL). Works on server and client. */
export const NEXT_PUBLIC_ST_HELP_MEDIA_URL = () => resolveHelpMediaUrl(env('NEXT_PUBLIC_ST_HELP_MEDIA_URL'));

/** The URL of one file under the help media base, for example `how-to-sign.mp4`. */
export const formatHelpMediaUrl = (file: string, base: string = NEXT_PUBLIC_ST_HELP_MEDIA_URL()) =>
  `${base}/${encodeURIComponent(file)}`;

/** How the player starts for a video: a narrated file has sound on, a silent one is muted. */
export const getHelpVideoPlayback = (video: Pick<HelpVideo, 'narrated'>) => {
  const isNarrated = video.narrated === true;

  return { muted: !isNarrated, note: isNarrated ? ('voiceover' as const) : ('silent' as const) };
};
