import { formatHelpMediaUrl } from '@documenso/lib/constants/help/media';
import type { HelpVideo } from '@documenso/lib/constants/help/types';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';

export type HelpVideoPlayerProps = {
  video: HelpVideo | null;
  title: string;
};

/**
 * Solid Ten Sign: the walkthrough video of a help article. The files are not part of the app, so a
 * file may be missing: the player renders only in the browser and hides itself when the video
 * cannot load. No broken player is ever shown.
 */
export const HelpVideoPlayer = ({ video, title }: HelpVideoPlayerProps) => {
  const ref = useRef<HTMLVideoElement>(null);

  const [isMounted, setIsMounted] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const element = ref.current;

    // The error may have happened before React attached the handler. (Not networkState: it reads
    // NETWORK_NO_SOURCE for a moment while a good file starts to load.)
    if (element?.error) {
      setHasFailed(true);
    }
  }, [isMounted]);

  if (!video || !isMounted || hasFailed) {
    return null;
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-muted" data-testid="help-video">
      <video
        ref={ref}
        className="aspect-video w-full bg-black"
        src={formatHelpMediaUrl(video.file)}
        poster={formatHelpMediaUrl(video.poster)}
        controls
        playsInline
        muted
        preload="metadata"
        aria-label={title}
        onError={() => setHasFailed(true)}
      />
      <figcaption className="px-4 py-2 text-muted-foreground text-xs">
        <Trans>The video has no sound. The captions show each step.</Trans>
      </figcaption>
    </figure>
  );
};
