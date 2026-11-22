import { prisma } from '@documenso/prisma';
import { seedPendingDocument } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

/**
 * Solid Ten Sign: the public Help section (/help, /help/:slug, /help/faq) and its entry points.
 */

test.describe.configure({ mode: 'parallel' });

const uniqueEmail = (label: string) =>
  `help-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.documenso.com`;

/** Every request for a help video or poster answers 404, as on a server where the file is missing. */
const missingHelpMedia = async (page: Page) => {
  await page.route('**/help-media/**', async (route) => route.fulfill({ status: 404, body: 'Not found' }));
};

/** True when the element at the centre of the locator's box is the locator itself (or inside it). */
const isOnTop = async (locator: Locator) => {
  const box = await locator.boundingBox();

  if (!box) {
    return false;
  }

  return await locator.evaluate(
    (element, point) => {
      const top = document.elementFromPoint(point.x, point.y);

      return top !== null && (element === top || element.contains(top));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
};

const expectHowToSignLink = async (link: Locator) => {
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute('href', '/help/how-to-sign');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
};

const seedSigningLink = async (label: string, internalVersion: 1 | 2) => {
  const { user, team } = await seedUser();
  const document = await seedPendingDocument(user, team.id, [uniqueEmail(label)], { internalVersion });
  const recipient = await prisma.recipient.findFirstOrThrow({ where: { envelopeId: document.id } });

  return `/sign/${recipient.token}`;
};

test('the help index loads signed out, with categories, the signer block and the FAQ link', async ({ page }) => {
  const response = await page.goto('/help');

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  await expect(page.getByTestId('help-for-signers')).toBeVisible();
  await expect(page.getByTestId('help-topic-card-upload-and-send')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'For signers', exact: true })).toBeVisible();
  await expect(page.getByTestId('help-faq-link')).toHaveAttribute('href', '/help/faq');
});

test('search finds an article by its steps and a question by its answer', async ({ page }) => {
  await page.goto('/help');

  const search = page.getByTestId('help-search-input');

  await search.fill('signing order');
  await expect(page.getByTestId('help-topic-card-add-signers-and-signing-order')).toBeVisible();

  // A label that is only in the steps of one article.
  await search.fill('Copy Shareable Link');
  await expect(page.getByTestId('help-topic-card-direct-links')).toBeVisible();

  // A word that is only in an FAQ answer.
  await search.fill('lawyer');
  const question = page.getByTestId('help-faq-result-is-it-legally-valid');
  await expect(question).toBeVisible();

  await question.click();
  await expect(page).toHaveURL(/\/help\/faq#is-it-legally-valid$/);
  await expect(page.getByTestId('help-faq-is-it-legally-valid')).toHaveAttribute('open', '');

  await page.goto('/help');
  await page.getByTestId('help-search-input').fill('zzqqxx nothing');
  await expect(page.getByText('Nothing found.')).toBeVisible();
});

test('an article shows its numbered steps, related articles and the support address', async ({ page }) => {
  await missingHelpMedia(page);

  await page.goto('/help/how-to-sign');

  await expect(page.getByRole('heading', { level: 1, name: 'How to sign a document' })).toBeVisible();

  const steps = page.getByTestId('help-steps').locator('> li');
  await expect(steps).toHaveCount(7);
  await expect(steps.first()).toContainText('View Document to sign');

  await expect(page.getByTestId('help-related').getByRole('link').first()).toBeVisible();
  await expect(page.getByTestId('help-still-stuck').getByRole('link', { name: 'support@solidten.io' })).toHaveAttribute(
    'href',
    'mailto:support@solidten.io',
  );
});

test('a missing video file shows no player, and a topic without a video shows none', async ({ page }) => {
  await missingHelpMedia(page);

  const videoRequest = page.waitForRequest('**/help-media/upload-and-send.mp4');

  await page.goto('/help/upload-and-send');
  await expect(page.getByTestId('help-steps')).toBeVisible();

  // The browser asked for the file, got a 404, and the player went away.
  await videoRequest;
  await expect(page.getByTestId('help-video')).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);

  await page.goto('/help/no-account-needed');
  await expect(page.getByTestId('help-steps')).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});

test('a video file that loads shows the player (needs E2E_HELP_VIDEO_FILE)', async ({ page }) => {
  // biome-ignore lint/nursery/noUndeclaredEnvVars: test-only switch, never read by the app.
  const file = process.env.E2E_HELP_VIDEO_FILE;

  test.skip(!file, 'Set E2E_HELP_VIDEO_FILE to a real .mp4 to run this test.');

  await page.route('**/help-media/how-to-sign.mp4', async (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', path: file }),
  );
  await page.route('**/help-media/how-to-sign.jpg', async (route) => route.fulfill({ status: 404 }));

  await page.goto('/help/how-to-sign');

  const video = page.getByTestId('help-video').locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('src', '/help-media/how-to-sign.mp4');
  await expect(video).toHaveAttribute('preload', 'metadata');
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('playsinline', '');

  // The metadata loads, the player stays, and it is muted.
  await expect.poll(async () => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);
  await expect(page.getByTestId('help-video')).toBeVisible();
});

test('an unknown article answers 404 with a help page and a search link', async ({ page }) => {
  const response = await page.goto('/help/sign-the-contrakt');

  expect(response?.status()).toBe(404);

  const notFound = page.getByTestId('help-not-found');
  await expect(notFound.getByRole('heading', { name: 'We could not find that help page' })).toBeVisible();
  await expect(page.getByText('Oops! Something went wrong.')).toHaveCount(0);
  await expect(page.getByTestId('help-not-found-back')).toHaveAttribute('href', '/help');

  // The search link carries the words of the bad address into the search box.
  await page.getByTestId('help-not-found-search').click();
  await expect(page).toHaveURL(/\/help\?q=sign%20the%20contrakt$/);
  await expect(page.getByTestId('help-search-input')).toHaveValue('sign the contrakt');
});

test('an article without a video asks for no media at all', async ({ page }) => {
  const mediaRequests: string[] = [];

  page.on('request', (request) => {
    if (request.url().includes('/help-media/')) {
      mediaRequests.push(request.url());
    }
  });

  await page.goto('/help/place-fields');
  await expect(page.getByTestId('help-steps')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(mediaRequests).toEqual([]);
  await expect(page.locator('video')).toHaveCount(0);
});

test('the CSP allows media only from this site (and the help media origin)', async ({ page }) => {
  for (const path of ['/help/how-to-sign', '/signin']) {
    const response = await page.goto(path);
    const csp = response?.headers()['content-security-policy'] ?? '';
    const mediaSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('media-src'));

    expect(mediaSrc, path).toBeDefined();
    expect(mediaSrc?.split(' ')[1], path).toBe("'self'");

    const base = process.env.NEXT_PUBLIC_ST_HELP_MEDIA_URL;

    if (base && /^https?:\/\//.test(base)) {
      expect(mediaSrc, path).toContain(new URL(base).origin);
    } else {
      expect(mediaSrc, path).toBe("media-src 'self'");
    }
  }
});

test('the code input style is in the page with the CSP nonce, so the browser applies it', async ({ page }) => {
  const cspErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  await page.goto('/signin');

  // A refused <style> has no rules; this one must have all five.
  const ruleCount = await page.evaluate(() => {
    const element = document.getElementById('input-otp-style');

    return element instanceof HTMLStyleElement ? (element.sheet?.cssRules.length ?? 0) : -1;
  });

  expect(ruleCount).toBe(5);
  expect(cspErrors).toEqual([]);
});

test('an FAQ deep link opens that question', async ({ page }) => {
  await page.goto('/help/faq#lost-link');

  const item = page.getByTestId('help-faq-lost-link');
  await expect(item).toHaveAttribute('open', '');
  await expect(item).toContainText('ask the sender to send it again');

  // The other questions stay closed.
  await expect(page.getByTestId('help-faq-file-size-limit')).not.toHaveAttribute('open', '');

  // The source-code answer links to the source.
  await page.getByTestId('help-faq-source-code').locator('summary').click();
  await expect(page.getByTestId('help-faq-source-code').getByRole('link', { name: 'Source code' })).toHaveAttribute(
    'href',
    /^https?:\/\//,
  );
});

test('the sign-in page has a Help link in the footer', async ({ page }) => {
  await page.goto('/signin');

  const link = page.getByTestId('help-footer-link').first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/help');
  await expect(link).toHaveAttribute('target', '_blank');
});

test('the account menu of the signed-in app has Help', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

  const link = page.getByTestId('menu-help-link');

  // The menu can take a click before the page is ready in a cold dev server: open it until it shows.
  await expect(async () => {
    if (!(await link.isVisible())) {
      await page.getByTestId('menu-switcher').click();
    }

    await expect(link).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(link).toHaveAttribute('href', '/help');

  await link.click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
});

test('V1 and V2 signing pages show "Need help signing?" and the footer Help link', async ({ page }) => {
  await page.goto(await seedSigningLink('v1', 1));
  await expectHowToSignLink(page.getByTestId('signing-help-link'));
  await expect(page.getByTestId('help-footer-link').last()).toHaveAttribute('href', '/help');

  await page.goto(await seedSigningLink('v2', 2));
  // Desktop: in the sidebar footer.
  await expectHowToSignLink(page.getByTestId('signing-help-link'));
});

test.describe('phone width (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the signed-in phone menu has Help and Source code', async ({ page }) => {
    const { user, team } = await seedUser();

    await apiSignin({ page, email: user.email, redirectPath: `/t/${team.url}/documents` });

    const help = page.getByTestId('mobile-menu-help-link');

    // Open the phone menu (the hamburger button in the header) until the sheet shows.
    await expect(async () => {
      if (!(await help.isVisible())) {
        await page.locator('button:has(svg.lucide-menu)').first().tap();
      }

      await expect(help).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await expect(help).toHaveAttribute('href', '/help');

    const source = page.getByTestId('mobile-menu-source-code-link');
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', /^https?:\/\//);
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('/help works by touch and has no sideways scroll', async ({ page }) => {
    await missingHelpMedia(page);

    await page.goto('/help');

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);

    await page.getByTestId('help-search-input').tap();
    await page.getByTestId('help-search-input').fill('reject');

    const card = page.getByTestId('help-topic-card-decline-to-sign');
    await expect(card).toBeVisible();
    expect(await isOnTop(card)).toBe(true);

    await card.tap();
    await expect(page).toHaveURL(/\/help\/decline-to-sign$/);
    await expect(page.getByTestId('help-steps')).toBeVisible();
  });

  test('V1 signing page: "Need help signing?" takes a tap; the sign panel is not covered', async ({ page }) => {
    await page.goto(await seedSigningLink('phone-v1', 1));

    // The help page is served locally so the test needs no second page load.
    await page
      .context()
      .route('**/help/how-to-sign', async (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: '<p>help</p>' }),
      );

    const link = page.getByTestId('signing-help-link');
    await expectHowToSignLink(link);
    await link.scrollIntoViewIfNeeded();
    expect(await isOnTop(link)).toBe(true);

    const [popup] = await Promise.all([page.context().waitForEvent('page'), link.tap({ timeout: 5_000 })]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).pathname).toBe('/help/how-to-sign');
    await popup.close();

    // The fixed sign panel still lies on top at the bottom of the page.
    const panelTitle = page.getByText('Sign Document', { exact: true }).last();
    await expect(panelTitle).toBeVisible();
    expect(await isOnTop(panelTitle)).toBe(true);

    const complete = page.getByRole('button', { name: 'Complete' }).last();
    await expect(complete).toBeVisible();
    expect(await isOnTop(complete)).toBe(true);

    await page.screenshot({ path: test.info().outputPath('v1-390-help-link.png') });
  });

  test('V2 signing page: "Need help signing?" is in the Actions menu', async ({ page }) => {
    await page.goto(await seedSigningLink('phone-v2', 2));

    await page.getByRole('button', { name: 'Actions' }).tap();

    await expectHowToSignLink(page.getByTestId('signing-help-menu-link'));
  });
});
