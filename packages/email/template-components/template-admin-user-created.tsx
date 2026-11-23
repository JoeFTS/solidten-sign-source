import { Trans } from '@lingui/react/macro';

import { Button, Link, Section, Text } from '../components';
import { TemplateDocumentImage } from './template-document-image';

export type TemplateAdminUserCreatedProps = {
  resetPasswordLink?: string;
  /**
   * Solid Ten Sign (M): set when password sign-in is off. The email then sends the user to the
   * sign-in page (sign-in by emailed link) and says nothing about a password.
   */
  signInLink?: string;
  assetBaseUrl: string;
};

export const TemplateAdminUserCreated = ({
  resetPasswordLink,
  signInLink,
  assetBaseUrl,
}: TemplateAdminUserCreatedProps) => {
  if (signInLink) {
    return (
      <>
        <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

        <Section className="flex-row items-center justify-center">
          <Text className="mx-auto mb-0 max-w-[80%] text-center font-semibold text-foreground text-lg">
            <Trans>Welcome to Solid Ten Sign!</Trans>
          </Text>

          <Text className="my-1 text-center text-base text-muted-foreground">
            <Trans>An administrator has created a Solid Ten Sign account for you.</Trans>
          </Text>

          <Text className="my-1 text-center text-base text-muted-foreground">
            <Trans>
              To sign in, open the sign-in page and enter your email address. We email you a link that signs you in.
            </Trans>
          </Text>

          <Section className="mt-8 mb-6 text-center">
            <Button
              className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-primary-foreground text-sm no-underline"
              href={signInLink}
            >
              <Trans>Go to sign in</Trans>
            </Button>
            <Text className="mt-8 text-center text-muted-foreground text-sm italic">
              <Trans>You can also copy and paste this link into your browser: {signInLink}</Trans>
            </Text>
          </Section>

          <Section className="mt-8">
            <Text className="text-center text-muted-foreground text-sm">
              <Trans>
                If you didn't expect this account or have any questions, please{' '}
                <Link href="mailto:support@solidten.io" className="text-primary">
                  contact support
                </Link>
                .
              </Trans>
            </Text>
          </Section>
        </Section>
      </>
    );
  }

  return (
    <>
      <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

      <Section className="flex-row items-center justify-center">
        <Text className="mx-auto mb-0 max-w-[80%] text-center font-semibold text-foreground text-lg">
          <Trans>Welcome to Solid Ten Sign!</Trans>
        </Text>

        <Text className="my-1 text-center text-base text-muted-foreground">
          <Trans>An administrator has created a Solid Ten Sign account for you.</Trans>
        </Text>

        <Text className="my-1 text-center text-base text-muted-foreground">
          <Trans>To get started, please set your password by clicking the button below:</Trans>
        </Text>

        <Section className="mt-8 mb-6 text-center">
          <Button
            className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-primary-foreground text-sm no-underline"
            href={resetPasswordLink}
          >
            <Trans>Set Password</Trans>
          </Button>
          <Text className="mt-8 text-center text-muted-foreground text-sm italic">
            <Trans>
              You can also copy and paste this link into your browser: {resetPasswordLink} (link expires in 24 hours)
            </Trans>
          </Text>
        </Section>

        <Section className="mt-8">
          <Text className="text-center text-muted-foreground text-sm">
            <Trans>
              If you didn't expect this account or have any questions, please{' '}
              <Link href="mailto:support@solidten.io" className="text-primary">
                contact support
              </Link>
              .
            </Trans>
          </Text>
        </Section>
      </Section>
    </>
  );
};
