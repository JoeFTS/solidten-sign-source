import type { MessageDescriptor } from '@lingui/core';
import { afterEach, describe, expect, it } from 'vitest';

import { HELP_FAQ, HELP_FAQ_CATEGORIES } from './faq';
import {
  DEFAULT_HELP_MEDIA_URL,
  formatHelpMediaUrl,
  getHelpMediaCspSources,
  getHelpVideoPlayback,
  NEXT_PUBLIC_ST_HELP_MEDIA_URL,
  resolveHelpMediaUrl,
} from './media';
import { normalizeHelpText, searchHelp } from './search';
import { HELP_CATEGORIES, HELP_TOPIC_SLUG_PATTERN, HELP_TOPICS } from './topics';

/** No compiled catalogs needed: the macro keeps the source text on the descriptor in tests. */
const t = (descriptor: MessageDescriptor) => descriptor.message ?? descriptor.id;

const allTopicText = () =>
  HELP_TOPICS.flatMap((topic) => [
    t(topic.title),
    t(topic.summary),
    ...topic.steps.flatMap((step) => [t(step.text), step.tip ? t(step.tip) : '']),
  ]);

const allFaqText = () =>
  HELP_FAQ.flatMap((entry) => [t(entry.question), t(entry.answer), entry.link ? t(entry.link.label) : '']);

/** Names that must never reach a user: suppliers, internal tools, and words the brand rules ban. */
const BANNED = [
  /documenso/i,
  /\bresend\.com\b/i,
  /\bresend (api|smtp)\b/i,
  /hostinger/i,
  /playwright/i,
  /remotion/i,
  /twilio/i,
  /stripe/i,
  /gotenberg/i,
  /cloudflare/i,
  /turnstile/i,
  /zapier/i,
  /\bn8n\b/i,
  /integromat/i,
  /github/i,
  /docusign/i,
  /\bAI\b/,
  /artificial intelligence/i,
  /seamless/i,
  /cutting-edge/i,
  /revolutionary/i,
  /game-changing/i,
  /leverage/i,
  /synergy/i,
  /\btext messages? (are|is) sent\b/i,
  // Owner's decision (11/22): Help never mentions health documents.
  /\bhealth\b/i,
  /hipaa/i,
  /\bmedical\b/i,
  /\bpatients?\b/i,
];

describe('help topics', () => {
  it('has 40 to 60 topics with unique, well-formed slugs', () => {
    expect(HELP_TOPICS.length).toBeGreaterThanOrEqual(40);
    expect(HELP_TOPICS.length).toBeLessThanOrEqual(60);

    const slugs = HELP_TOPICS.map((topic) => topic.slug);

    expect(new Set(slugs).size).toBe(slugs.length);

    for (const slug of slugs) {
      expect(slug).toMatch(HELP_TOPIC_SLUG_PATTERN);
      // "faq" is its own page.
      expect(slug).not.toBe('faq');
    }
  });

  it('has 3 to 9 steps in every topic, each with text', () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.steps.length, topic.slug).toBeGreaterThanOrEqual(3);
      expect(topic.steps.length, topic.slug).toBeLessThanOrEqual(9);

      for (const step of topic.steps) {
        expect(t(step.text).trim().length, topic.slug).toBeGreaterThan(0);
      }
    }
  });

  it('links only to topics that exist, never to itself', () => {
    const slugs = new Set(HELP_TOPICS.map((topic) => topic.slug));

    for (const topic of HELP_TOPICS) {
      for (const related of topic.related) {
        expect(slugs.has(related), `${topic.slug} -> ${related}`).toBe(true);
        expect(related).not.toBe(topic.slug);
      }

      expect(new Set(topic.related).size, topic.slug).toBe(topic.related.length);
    }
  });

  it('puts every topic in a known category, and every category has topics', () => {
    const ids = HELP_CATEGORIES.map((category) => category.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const topic of HELP_TOPICS) {
      expect(ids).toContain(topic.category);
    }

    for (const id of ids) {
      expect(
        HELP_TOPICS.some((topic) => topic.category === id),
        id,
      ).toBe(true);
    }
  });

  it('names each video after its slug', () => {
    for (const topic of HELP_TOPICS) {
      if (topic.video) {
        expect(topic.video.file).toBe(`${topic.slug}.mp4`);
        expect(topic.video.poster).toBe(`${topic.slug}.jpg`);
        expect(topic.video.seconds).toBeGreaterThanOrEqual(20);
        expect(topic.video.seconds).toBeLessThanOrEqual(60);
      }
    }
  });

  it('sets a video only on topics whose file is rendered (today the two pilots)', () => {
    // Update this list when the video team ships a file and the topic's video is switched on.
    expect(HELP_TOPICS.filter((topic) => topic.video).map((topic) => topic.slug)).toEqual([
      'upload-and-send',
      'add-signers-and-signing-order',
      'place-fields',
      'how-to-sign',
      'adopt-a-signature',
      'fill-in-fields',
      'decline-to-sign',
      'no-account-needed',
    ]);
  });

  it('marks every rendered video as narrated (all batches are voiced)', () => {
    for (const topic of HELP_TOPICS) {
      if (topic.video) {
        expect(typeof topic.video.narrated, topic.slug).toBe('boolean');
      }
    }

    for (const topic of HELP_TOPICS.filter((item) => item.video)) {
      expect(topic.video?.narrated, topic.slug).toBe(true);
    }
  });

  it('starts a narrated video with sound and a silent one muted', () => {
    expect(getHelpVideoPlayback({ narrated: true })).toEqual({ muted: false, note: 'voiceover' });
    expect(getHelpVideoPlayback({ narrated: false })).toEqual({ muted: true, note: 'silent' });
    expect(getHelpVideoPlayback({})).toEqual({ muted: true, note: 'silent' });
  });

  it('has a "how-to-sign" article for the signing pages', () => {
    expect(HELP_TOPICS.find((topic) => topic.slug === 'how-to-sign')?.audience).toBe('signer');
  });
});

describe('help FAQ', () => {
  it('has at least 30 questions with unique ids', () => {
    expect(HELP_FAQ.length).toBeGreaterThanOrEqual(30);

    const ids = HELP_FAQ.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const id of ids) {
      expect(id).toMatch(HELP_TOPIC_SLUG_PATTERN);
    }
  });

  it('points every relatedSlug at a topic that exists', () => {
    const slugs = new Set(HELP_TOPICS.map((topic) => topic.slug));

    for (const entry of HELP_FAQ) {
      if (entry.relatedSlug) {
        expect(slugs.has(entry.relatedSlug), `${entry.id} -> ${entry.relatedSlug}`).toBe(true);
      }
    }
  });

  it('puts every question in a known category, and every category has questions', () => {
    const ids = HELP_FAQ_CATEGORIES.map((category) => category.id);

    for (const entry of HELP_FAQ) {
      expect(ids).toContain(entry.category);
    }

    for (const id of ids) {
      expect(
        HELP_FAQ.some((entry) => entry.category === id),
        id,
      ).toBe(true);
    }
  });

  it('links to the configured source code and to support', () => {
    const sourceCode = HELP_FAQ.find((entry) => entry.id === 'source-code');

    expect(sourceCode?.link?.href()).toMatch(/^https?:\/\//);
    expect(HELP_FAQ.find((entry) => entry.id === 'contact-support')?.link?.href()).toBe('mailto:support@solidten.io');
  });

  it('gives no legal advice: the legal answer sends the reader to a lawyer', () => {
    const legal = HELP_FAQ.find((entry) => entry.id === 'is-it-legally-valid');

    if (!legal) {
      throw new Error('missing is-it-legally-valid');
    }

    expect(t(legal.answer)).toMatch(/lawyer/);
    expect(t(legal.answer)).toMatch(/do not give legal advice/);
  });
});

describe('help words', () => {
  it('names no vendor and uses no banned word', () => {
    for (const text of [...allTopicText(), ...allFaqText(), ...HELP_CATEGORIES.map((c) => t(c.title))]) {
      for (const pattern of BANNED) {
        expect(text, `"${text}" matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('has balanced double quotes and no ICU braces in any string', () => {
    for (const text of [...allTopicText(), ...allFaqText()]) {
      expect((text.match(/"/g) ?? []).length % 2, text).toBe(0);
      expect(text, text).not.toMatch(/[{}]/);
    }
  });

  it('says what this server does: 5 MB PDFs, emailed sign-in links, no text messages', () => {
    const everything = [...allTopicText(), ...allFaqText()].join('\n');

    expect(everything).toMatch(/5 MB/);
    expect(everything).not.toMatch(/\b(10|50) MB\b/);
    expect(everything).not.toMatch(/\bpassword\b.*\bsign in\b.*\btype your password\b/i);
    // Sign-up is closed: never tell a reader to sign up or to make an account themselves.
    expect(everything).not.toMatch(/sign up for an account|select "(sign up|create account)"|create your account and/i);
  });
});

describe('help search', () => {
  it('finds articles by title, step text and tip, and FAQ answers', () => {
    expect(searchHelp('signing order', { topics: HELP_TOPICS, faq: HELP_FAQ, t }).topics[0]?.slug).toBe(
      'add-signers-and-signing-order',
    );

    const byStep = searchHelp('Copy Shareable Link', { topics: HELP_TOPICS, faq: HELP_FAQ, t });

    expect(byStep.topics.map((topic) => topic.slug)).toContain('direct-links');

    const byFaq = searchHelp('lawyer', { topics: HELP_TOPICS, faq: HELP_FAQ, t });

    expect(byFaq.faq.map((entry) => entry.id)).toContain('is-it-legally-valid');
  });

  it('needs every word, ignores case and accents, and returns nothing for an empty query', () => {
    expect(searchHelp('   ', { topics: HELP_TOPICS, faq: HELP_FAQ, t })).toEqual({ topics: [], faq: [] });
    expect(searchHelp('SIGNATURE zzzqqq', { topics: HELP_TOPICS, faq: HELP_FAQ, t }).topics).toEqual([]);
    expect(normalizeHelpText('  Résumé   ÉTÉ ')).toBe('resume ete');
  });
});

describe('help media URL', () => {
  const previous = process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL;
    } else {
      process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL = previous;
    }
  });

  it('uses /help-media when unset or empty', () => {
    expect(resolveHelpMediaUrl(undefined)).toBe(DEFAULT_HELP_MEDIA_URL);
    expect(resolveHelpMediaUrl(null)).toBe(DEFAULT_HELP_MEDIA_URL);
    expect(resolveHelpMediaUrl('  ')).toBe(DEFAULT_HELP_MEDIA_URL);
  });

  it('accepts a same-origin path and an absolute http(s) URL, without a trailing slash', () => {
    expect(resolveHelpMediaUrl('/media/help/')).toBe('/media/help');
    expect(resolveHelpMediaUrl('https://cdn.example.org/help/')).toBe('https://cdn.example.org/help');
    expect(resolveHelpMediaUrl('http://localhost:3000/help-media')).toBe('http://localhost:3000/help-media');
  });

  it('refuses everything else', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:video/mp4;base64,AAAA',
      'ftp://example.org/help',
      '//evil.example.org/help',
      '/\\evil.example.org',
      'help-media',
      'https://user:pass@example.org/help',
      'https://example.org/help?x=1',
      '/help media',
      '/',
    ]) {
      expect(resolveHelpMediaUrl(value), value).toBe(DEFAULT_HELP_MEDIA_URL);
    }
  });

  it('gives the CSP media sources: self, plus the origin of an absolute base', () => {
    expect(getHelpMediaCspSources('/help-media')).toBe("'self'");
    expect(getHelpMediaCspSources('https://media.example.org/sign')).toBe("'self' https://media.example.org");
    expect(getHelpMediaCspSources('http://localhost:8519/help')).toBe("'self' http://localhost:8519");

    expect(getHelpMediaCspSources('https://cdn.example.org:8443/x/')).toBe("'self' https://cdn.example.org:8443");
    expect(getHelpMediaCspSources(undefined)).toBe("'self'");
    expect(getHelpMediaCspSources('//evil.example.org')).toBe("'self'");
    expect(getHelpMediaCspSources('javascript:alert(1)')).toBe("'self'");
  });

  it('reads NEXT_PUBLIC_ST_HELP_MEDIA_URL and builds file URLs', () => {
    process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL = 'https://media.example.org/sign/';

    expect(NEXT_PUBLIC_ST_HELP_MEDIA_URL()).toBe('https://media.example.org/sign');
    expect(formatHelpMediaUrl('how-to-sign.mp4')).toBe('https://media.example.org/sign/how-to-sign.mp4');

    process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL = 'javascript:alert(1)';

    expect(formatHelpMediaUrl('a b.jpg')).toBe('/help-media/a%20b.jpg');
  });
});
