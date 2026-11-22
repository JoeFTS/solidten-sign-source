import { HELP_FAQ, HELP_SUPPORT_EMAIL } from '@documenso/lib/constants/help/faq';
import { findHelpTopic, HELP_CATEGORIES } from '@documenso/lib/constants/help/topics';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft, MailIcon, SearchIcon } from 'lucide-react';
import { isRouteErrorResponse, Link, useParams } from 'react-router';

import { GenericErrorLayout } from '~/components/general/generic-error-layout';

import { HelpTopicCard } from '~/components/general/help/help-topic-card';
import { HelpVideoPlayer } from '~/components/general/help/help-video-player';
import { appMetaTags } from '~/utils/meta';

import type { Route } from './+types/help.$slug';

export function loader({ params }: Route.LoaderArgs) {
  const topic = findHelpTopic(params.slug);

  if (!topic) {
    throw new Response('Not found', { status: 404 });
  }

  return { slug: topic.slug };
}

export function meta({ data }: Route.MetaArgs) {
  const topic = data ? findHelpTopic(data.slug) : undefined;

  return appMetaTags(topic?.title ?? msg`Help`);
}

export default function HelpArticlePage({ loaderData }: Route.ComponentProps) {
  const { _ } = useLingui();

  const topic = findHelpTopic(loaderData.slug);

  if (!topic) {
    return null;
  }

  const category = HELP_CATEGORIES.find((item) => item.id === topic.category);
  const relatedTopics = topic.related.map((slug) => findHelpTopic(slug)).filter((item) => item !== undefined);
  const relatedQuestions = HELP_FAQ.filter((entry) => entry.relatedSlug === topic.slug);

  return (
    <article className="mx-auto max-w-3xl" data-testid="help-article">
      <nav aria-label={_(msg`Breadcrumb`)} className="text-muted-foreground text-sm">
        <Link to="/help" className="inline-flex items-center hover:text-foreground">
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          <Trans>Help</Trans>
        </Link>
        {category && (
          <>
            <span aria-hidden="true"> / </span>
            <span>{_(category.title)}</span>
          </>
        )}
      </nav>

      <h1 className="mt-4 font-semibold text-2xl text-foreground md:text-3xl">{_(topic.title)}</h1>
      <p className="mt-2 text-lg text-muted-foreground">{_(topic.summary)}</p>

      <div className="mt-6">
        <HelpVideoPlayer key={topic.slug} video={topic.video} title={_(topic.title)} />
      </div>

      <h2 className="mt-8 font-semibold text-foreground text-lg">
        <Trans>Steps</Trans>
      </h2>
      <ol className="mt-4 space-y-4" data-testid="help-steps">
        {topic.steps.map((step, index) => (
          <li key={index} className="flex gap-3">
            <span
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground text-sm"
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-foreground">{_(step.text)}</p>
              {step.tip && (
                <p className="mt-1 rounded-md border-primary/40 border-l-2 bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
                  {_(step.tip)}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {relatedQuestions.length > 0 && (
        <section className="mt-10">
          <h2 className="font-semibold text-foreground text-lg">
            <Trans>Questions about this</Trans>
          </h2>
          <ul className="mt-3 space-y-2">
            {relatedQuestions.map((entry) => (
              <li key={entry.id}>
                <Link to={`/help/faq#${entry.id}`} className="text-primary underline-offset-2 hover:underline">
                  {_(entry.question)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {relatedTopics.length > 0 && (
        <section className="mt-10" data-testid="help-related">
          <h2 className="font-semibold text-foreground text-lg">
            <Trans>Related articles</Trans>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {relatedTopics.map((related) => (
              <HelpTopicCard key={related.slug} topic={related} />
            ))}
          </div>
        </section>
      )}

      <aside
        className="mt-10 flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-5"
        data-testid="help-still-stuck"
      >
        <MailIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" aria-hidden="true" />
        <p className="text-foreground text-sm">
          <Trans>
            Still stuck? Email{' '}
            <a className="font-medium text-primary underline" href={`mailto:${HELP_SUPPORT_EMAIL}`}>
              {HELP_SUPPORT_EMAIL}
            </a>
            . Signers: for questions about the document itself, contact the person who sent it.
          </Trans>
        </p>
      </aside>
    </article>
  );
}

/** Solid Ten Sign: an unknown help slug keeps its 404 status but shows a help page, not "Oops!". */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const params = useParams();

  const words = (params.slug ?? '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .slice(0, 80);

  if (!isRouteErrorResponse(error) || error.status !== 404) {
    return <GenericErrorLayout errorCode={isRouteErrorResponse(error) ? error.status : 500} />;
  }

  return (
    <div className="mx-auto max-w-3xl py-8 text-center" data-testid="help-not-found">
      <h1 className="font-semibold text-2xl text-foreground md:text-3xl">
        <Trans>We could not find that help page</Trans>
      </h1>
      <p className="mt-3 text-muted-foreground">
        <Trans>The link may be old or mistyped. Search the help, or start from the list of articles.</Trans>
      </p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link
          to={words ? `/help?q=${encodeURIComponent(words)}` : '/help'}
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-primary/90"
          data-testid="help-not-found-search"
        >
          <SearchIcon className="h-4 w-4" aria-hidden="true" />
          <Trans>Search the help</Trans>
        </Link>
        <Link
          to="/help"
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border px-4 py-2 text-foreground text-sm hover:bg-muted"
          data-testid="help-not-found-back"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <Trans>Back to Help</Trans>
        </Link>
      </div>
    </div>
  );
}
