import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';

import { Body, Container, Head, Html, Img, Preview, Section } from '../components';
import type { TemplateAdminUserCreatedProps } from '../template-components/template-admin-user-created';
import { TemplateAdminUserCreated } from '../template-components/template-admin-user-created';
import { TemplateFooter } from '../template-components/template-footer';
import { getEmailAssetUrl } from '../utils/asset-url';

export const AdminUserCreatedTemplate = ({
  resetPasswordLink,
  signInLink,
  assetBaseUrl = 'http://localhost:3002',
}: TemplateAdminUserCreatedProps) => {
  const { _ } = useLingui();

  const previewText = signInLink
    ? msg`Your Solid Ten Sign account is ready`
    : msg`Set your password for Solid Ten Sign`;

  return (
    <Html>
      <Head />
      <Body className="mx-auto my-auto bg-background font-sans">
        <Preview>{_(previewText)}</Preview>

        <Section>
          <Container className="mx-auto mt-8 mb-2 max-w-xl rounded-lg border border-border border-solid p-4 backdrop-blur-sm">
            <Section>
              <Img
                src={getEmailAssetUrl(assetBaseUrl, 'static/logo.png')}
                alt="Solid Ten Sign Logo"
                className="mb-4 h-6"
              />

              <TemplateAdminUserCreated
                resetPasswordLink={resetPasswordLink}
                signInLink={signInLink}
                assetBaseUrl={assetBaseUrl}
              />
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

export default AdminUserCreatedTemplate;
