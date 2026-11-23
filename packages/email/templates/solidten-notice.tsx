import { Body, Button, Container, Head, Hr, Html, Preview, Section, Text } from '../components';
import { TemplateBrandingLogo } from '../template-components/template-branding-logo';
import { TemplateDocumentImage } from '../template-components/template-document-image';
import { TemplateFooter } from '../template-components/template-footer';

export type SolidTenNoticeTemplateProps = {
  heading: string;
  paragraphs: string[];
  actionLabel?: string;
  actionLink?: string;
  assetBaseUrl?: string;
  /** A server notice to the operators: no "This document was sent using" line. */
  isOperatorNotice?: boolean;
};

/**
 * A plain notice email. The caller passes text it has already translated, so
 * one template serves every Solid Ten Sign notice.
 */
export const SolidTenNoticeTemplate = ({
  heading = 'Your document was not sent',
  paragraphs = ['The scheduled send for "Contract.pdf" could not run.'],
  actionLabel,
  actionLink,
  assetBaseUrl = 'http://localhost:3002',
  isOperatorNotice = false,
}: Partial<SolidTenNoticeTemplateProps>) => {
  return (
    <Html>
      <Head />

      <Body className="mx-auto my-auto bg-background font-sans">
        <Preview>{heading}</Preview>

        <Section>
          <Container className="mx-auto mt-8 mb-2 max-w-xl rounded-lg border border-border border-solid p-4 backdrop-blur-sm">
            <Section>
              <TemplateBrandingLogo assetBaseUrl={assetBaseUrl} className="mb-4 h-6" />

              <TemplateDocumentImage className="mt-6" assetBaseUrl={assetBaseUrl} />

              <Section>
                <Text className="mx-auto mb-0 max-w-[80%] text-center font-semibold text-foreground text-lg">
                  {heading}
                </Text>

                {paragraphs.map((paragraph) => (
                  <Text key={paragraph} className="my-1 text-center text-base text-muted-foreground">
                    {paragraph}
                  </Text>
                ))}

                {actionLabel && actionLink && (
                  <Section className="my-4 text-center">
                    <Button
                      className="inline-flex items-center justify-center rounded-lg bg-primary px-6 py-3 text-center font-medium text-primary-foreground text-sm no-underline"
                      href={actionLink}
                    >
                      {actionLabel}
                    </Button>
                  </Section>
                )}
              </Section>
            </Section>
          </Container>

          <Hr className="mx-auto mt-12 max-w-xl" />

          <Container className="mx-auto max-w-xl">
            <TemplateFooter isDocument={!isOperatorNotice} />
          </Container>
        </Section>
      </Body>
    </Html>
  );
};

export default SolidTenNoticeTemplate;
