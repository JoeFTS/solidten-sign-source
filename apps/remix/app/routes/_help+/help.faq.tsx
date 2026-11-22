import { HELP_FAQ, HELP_FAQ_CATEGORIES, HELP_SUPPORT_EMAIL } from '@documenso/lib/constants/help/faq';
import { findHelpTopic } from '@documenso/lib/constants/help/topics';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ChevronDownIcon, ChevronLeft } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';

import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Questions and answers`);
}

/** Open the question named in the URL hash (/help/faq#lost-link) and bring it into view. */
const useOpenQuestionFromHash = () => {
  const location = useLocation();

  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));

      if (!id) {
        return;
      }

      const element = document.getElementById(id);

      if (element instanceof HTMLDetailsElement) {
        element.open = true;
        element.scrollIntoView({ block: 'start' });
        element.querySelector('summary')?.focus({ preventScroll: true });
      }
    };

    open();

    window.addEventListener('hashchange', open);

    return () => window.removeEventListener('hashchange', open);
  }, [location.hash]);
};

export default function HelpFaqPage() {
  const { _ } = useLingui();

  useOpenQuestionFromHash();

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/help" className="inline-flex items-center text-muted-foreground text-sm hover:text-foreground">
        <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
        <Trans>Help</Trans>
      </Link>

      <h1 className="mt-4 font-semibold text-2xl text-foreground md:text-3xl">
        <Trans>Questions and answers</Trans>
      </h1>
      <p className="mt-2 text-muted-foreground">
        <Trans>
          Select a question to see the answer. No answer here? Email{' '}
          <a className="text-primary underline" href={`mailto:${HELP_SUPPORT_EMAIL}`}>
            {HELP_SUPPORT_EMAIL}
          </a>
          .
        </Trans>
      </p>

      {HELP_FAQ_CATEGORIES.map((category) => (
        <section key={category.id} className="mt-10" aria-labelledby={`faq-category-${category.id}`}>
          <h2 id={`faq-category-${category.id}`} className="font-semibold text-foreground text-xl">
            {_(category.title)}
          </h2>

          <div className="mt-3 divide-y divide-border rounded-xl border border-border">
            {HELP_FAQ.filter((entry) => entry.category === category.id).map((entry) => {
              const relatedTopic = entry.relatedSlug ? findHelpTopic(entry.relatedSlug) : undefined;

              return (
                <details
                  key={entry.id}
                  id={entry.id}
                  className="group scroll-mt-24"
                  data-testid={`help-faq-${entry.id}`}
                >
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span>{_(entry.question)}</span>
                    <ChevronDownIcon
                      className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>

                  <div className="px-4 pb-4 text-muted-foreground">
                    <p>{_(entry.answer)}</p>

                    {(entry.link || relatedTopic) && (
                      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                        {entry.link && (
                          <a
                            href={entry.link.href()}
                            className="text-primary underline"
                            {...(entry.link.href().startsWith('http')
                              ? { target: '_blank', rel: 'noopener noreferrer' }
                              : {})}
                          >
                            {_(entry.link.label)}
                          </a>
                        )}
                        {relatedTopic && (
                          <Link to={`/help/${relatedTopic.slug}`} className="text-primary underline">
                            <Trans>Read: {_(relatedTopic.title)}</Trans>
                          </Link>
                        )}
                      </p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
