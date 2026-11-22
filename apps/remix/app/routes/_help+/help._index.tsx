import { HELP_FAQ, HELP_SUPPORT_EMAIL } from '@documenso/lib/constants/help/faq';
import { searchHelp } from '@documenso/lib/constants/help/search';
import { HELP_CATEGORIES, HELP_TOPICS } from '@documenso/lib/constants/help/topics';
import { Input } from '@documenso/ui/primitives/input';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ArrowRightIcon, PenLineIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { HelpTopicCard } from '~/components/general/help/help-topic-card';
import { appMetaTags } from '~/utils/meta';

export function meta() {
  return appMetaTags(msg`Help`);
}

const SIGNER_QUICK_LINKS = [
  { to: '/help/how-to-sign', label: msg`How to sign a document` },
  { to: '/help/no-account-needed', label: msg`You do not need an account` },
  { to: '/help/faq#lost-link', label: msg`I cannot find my signing link` },
];

export default function HelpIndexPage() {
  const { _ } = useLingui();

  const [searchParams] = useSearchParams();

  // ?q= prefills the search (used by the help not-found page).
  const [query, setQuery] = useState(() => searchParams.get('q')?.slice(0, 100) ?? '');

  const results = useMemo(
    () => searchHelp(query, { topics: HELP_TOPICS, faq: HELP_FAQ, t: (descriptor) => _(descriptor) }),
    [query, _],
  );

  const isSearching = query.trim().length > 0;
  const hasResults = results.topics.length > 0 || results.faq.length > 0;

  return (
    <div>
      <h1 className="font-semibold text-3xl text-foreground md:text-4xl">
        <Trans>Help</Trans>
      </h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        <Trans>
          Short guides for every part of Solid Ten Sign, for the people who send documents and for the people who sign
          them.
        </Trans>
      </p>

      <form role="search" className="relative mt-6 max-w-2xl" onSubmit={(event) => event.preventDefault()}>
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={_(msg`Search, for example: signing order`)}
          aria-label={_(msg`Search help`)}
          className="h-11 pl-9 text-base"
          data-testid="help-search-input"
        />
      </form>

      {isSearching ? (
        <section className="mt-8" aria-live="polite" data-testid="help-search-results">
          {!hasResults && (
            <p className="text-muted-foreground">
              <Trans>
                Nothing found. Try other words, or email{' '}
                <a className="text-primary underline" href={`mailto:${HELP_SUPPORT_EMAIL}`}>
                  {HELP_SUPPORT_EMAIL}
                </a>
                .
              </Trans>
            </p>
          )}

          {results.topics.length > 0 && (
            <>
              <h2 className="font-semibold text-foreground text-lg">
                <Trans>Articles</Trans>
              </h2>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {results.topics.map((topic) => (
                  <HelpTopicCard key={topic.slug} topic={topic} />
                ))}
              </div>
            </>
          )}

          {results.faq.length > 0 && (
            <>
              <h2 className="mt-8 font-semibold text-foreground text-lg">
                <Trans>Questions</Trans>
              </h2>
              <ul className="mt-3 space-y-2">
                {results.faq.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      to={`/help/faq#${entry.id}`}
                      className="text-primary underline-offset-2 hover:underline"
                      data-testid={`help-faq-result-${entry.id}`}
                    >
                      {_(entry.question)}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : (
        <>
          <section
            className="mt-8 rounded-xl border border-border bg-muted/40 p-5 md:p-6"
            aria-labelledby="help-for-signers"
            data-testid="help-for-signers"
          >
            <div className="flex items-center gap-2">
              <PenLineIcon className="h-5 w-5 text-primary" aria-hidden="true" />
              <h2 id="help-for-signers" className="font-semibold text-foreground text-lg">
                <Trans>Asked to sign a document?</Trans>
              </h2>
            </div>
            <p className="mt-1 text-muted-foreground text-sm">
              <Trans>Open the link in your email. You need no account and nothing to install.</Trans>
            </p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-3">
              {SIGNER_QUICK_LINKS.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="flex min-h-11 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm hover:border-primary/50"
                  >
                    {_(link.label)}
                    <ArrowRightIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>

          {HELP_CATEGORIES.map((category) => (
            <section key={category.id} className="mt-10" aria-labelledby={`help-category-${category.id}`}>
              <h2 id={`help-category-${category.id}`} className="font-semibold text-foreground text-xl">
                {_(category.title)}
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">{_(category.description)}</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {HELP_TOPICS.filter((topic) => topic.category === category.id).map((topic) => (
                  <HelpTopicCard key={topic.slug} topic={topic} />
                ))}
              </div>
            </section>
          ))}

          <section className="mt-10 flex flex-col items-start justify-between gap-4 rounded-xl border border-border p-5 md:flex-row md:items-center md:p-6">
            <div>
              <h2 className="font-semibold text-foreground text-lg">
                <Trans>Questions and answers</Trans>
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">
                <Trans>Legal questions, security, limits, and what to do when something goes wrong.</Trans>
              </p>
            </div>
            <Link
              to="/help/faq"
              className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm hover:bg-primary/90"
              data-testid="help-faq-link"
            >
              <Trans>Read the FAQ</Trans>
              <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
            </Link>
          </section>
        </>
      )}
    </div>
  );
}
