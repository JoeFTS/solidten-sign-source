import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { Body, Button, Container, Head, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateFooter } from '../template-components/template-footer';

export type EmailLinkSigninTemplateProps = {
  signInLink?: string;
  assetBaseUrl?: string;
  expiresInMinutes?: number;
};

export const EmailLinkSigninTemplate = ({
  signInLink = 'http://localhost:3000',
  assetBaseUrl = 'http://localhost:3002',
  expiresInMinutes = 15,
}: EmailLinkSigninTemplateProps) => {
  const { _ } = useLingui();

  const previewText = msg`Your sign-in link`;

  return (
    <Html>
      <Head />

      <Body className="mx-auto my-auto bg-background font-sans">
        <Preview>{_(previewText)}</Preview>

        <Section>
          <Container className="mx-auto mt-8 mb-2 max-w-xl rounded-lg border border-border border-solid p-4 backdrop-blur-sm">
            <Section>
              <TemplateBrandingLogo assetBaseUrl={assetBaseUrl} className="mb-4 h-6" />

              <Section className="flex-row items-center justify-center">
                <Text className="mx-auto mb-0 max-w-[80%] text-center font-semibold text-foreground text-lg">
                  <Trans>Sign in to your account</Trans>
                </Text>

                <Text className="my-1 text-center text-base text-muted-foreground">
                  <Trans>
                    Use the button below to sign in. The link works one time and expires in {expiresInMinutes} minutes.
                  </Trans>
                </Text>

                <Section className="mt-8 mb-6 text-center">
                  <Button
                    className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-primary-foreground text-sm no-underline"
                    href={signInLink}
                  >
                    <Trans>Sign in</Trans>
                  </Button>
                </Section>

                <Text className="my-1 text-center text-muted-foreground text-sm">
                  <Trans>If you did not ask for this link, you can ignore this email. Nobody can sign in without it.</Trans>
                </Text>
              </Section>
            </Section>
          </Container>

          <div className="mx-auto mt-12 max-w-xl" />

          <Container className="mx-auto max-w-xl">
            <TemplateFooter isDocument={false} />
          </Container>
        </Section>
      </Body>
    </Html>
  );
};

export default EmailLinkSigninTemplate;
