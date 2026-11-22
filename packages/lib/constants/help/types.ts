import type { MessageDescriptor } from '@lingui/core';

/**
 * Solid Ten Sign: the in-app Help section (/help). These types are the contract between the help
 * pages and the team that makes the walkthrough videos.
 */

export type HelpAudience = 'sender' | 'signer' | 'admin';

export type HelpCategoryId = 'getting-started' | 'sending' | 'templates' | 'signers' | 'after-sending' | 'settings';

export type HelpCategory = {
  id: HelpCategoryId;
  title: MessageDescriptor;
  description: MessageDescriptor;
};

export type HelpStep = {
  /** One action. On-screen labels are in double quotes, exactly as the screen shows them. */
  text: MessageDescriptor;
  tip?: MessageDescriptor;
};

/**
 * A walkthrough video. The files are not in git or in the image: the app reads them from
 * NEXT_PUBLIC_ST_HELP_MEDIA_URL (default /help-media), as `<base>/<file>` and `<base>/<poster>`.
 * When a file is missing the article shows the steps only.
 */
export type HelpVideo = {
  file: string;
  poster: string;
  /** Planned length in seconds. The video team replaces it with the real length. */
  seconds: number;
};

export type HelpTopic = {
  slug: string;
  category: HelpCategoryId;
  title: MessageDescriptor;
  summary: MessageDescriptor;
  audience: HelpAudience;
  steps: HelpStep[];
  /** Slugs of other topics. */
  related: string[];
  video: HelpVideo | null;
};

export type HelpFaqCategoryId =
  | 'signing'
  | 'legal-and-proof'
  | 'security-and-privacy'
  | 'documents-and-limits'
  | 'account-and-support';

export type HelpFaqCategory = {
  id: HelpFaqCategoryId;
  title: MessageDescriptor;
};

export type HelpFaqEntry = {
  /** Stable anchor: /help/faq#<id>. */
  id: string;
  category: HelpFaqCategoryId;
  question: MessageDescriptor;
  answer: MessageDescriptor;
  relatedSlug?: string;
  /** A link shown under the answer. `href` runs at render time (it may read the environment). */
  link?: { label: MessageDescriptor; href: () => string };
};
