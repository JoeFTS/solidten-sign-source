import { expect, type Page } from '@playwright/test';

/**
 * An old signing link after a handover: it explains what happened and never
 * opens the document.
 */
export const expectHandedOverLink = async (page: Page, token: string) => {
  const response = await page.goto(`/sign/${token}`);

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/sign/${token}/reassigned$`));
  await expect(page.getByRole('heading', { name: 'This request was passed to someone else' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Complete|Sign|Reject Document/ })).toHaveCount(0);
};
