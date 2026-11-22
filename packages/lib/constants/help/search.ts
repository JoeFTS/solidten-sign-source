import type { MessageDescriptor } from '@lingui/core';

import type { HelpFaqEntry, HelpTopic } from './types';

type Translate = (descriptor: MessageDescriptor) => string;

export type HelpSearchResults = {
  topics: HelpTopic[];
  faq: HelpFaqEntry[];
};

/** Lower case, no accents, single spaces. */
export const normalizeHelpText = (value: string) =>
  value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const toWords = (query: string) => normalizeHelpText(query).split(' ').filter(Boolean);

const topicText = (topic: HelpTopic, t: Translate) =>
  normalizeHelpText(
    [
      t(topic.title),
      t(topic.summary),
      ...topic.steps.flatMap((step) => [t(step.text), step.tip ? t(step.tip) : '']),
    ].join(' '),
  );

const faqText = (entry: HelpFaqEntry, t: Translate) => normalizeHelpText(`${t(entry.question)} ${t(entry.answer)}`);

/**
 * Client-side search over titles, summaries, steps, tips and the FAQ. Every word of the query must
 * appear. A topic whose title holds every word comes first.
 */
export const searchHelp = (
  query: string,
  { topics, faq, t }: { topics: HelpTopic[]; faq: HelpFaqEntry[]; t: Translate },
): HelpSearchResults => {
  const words = toWords(query);

  if (words.length === 0) {
    return { topics: [], faq: [] };
  }

  const matchesAll = (text: string) => words.every((word) => text.includes(word));

  const matchedTopics = topics
    .filter((topic) => matchesAll(topicText(topic, t)))
    .map((topic, index) => ({ topic, index, inTitle: matchesAll(normalizeHelpText(t(topic.title))) }))
    .sort((a, b) => Number(b.inTitle) - Number(a.inTitle) || a.index - b.index)
    .map(({ topic }) => topic);

  return {
    topics: matchedTopics,
    faq: faq.filter((entry) => matchesAll(faqText(entry, t))),
  };
};
