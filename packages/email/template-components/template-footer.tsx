import { NEXT_PUBLIC_ST_SOURCE_URL } from '@documenso/lib/constants/source-code';
import { Trans } from '@lingui/react/macro';
import { Fragment } from 'react';

import { Link, Section, Text } from '../components';
import { useBranding } from '../providers/branding';
import { getSafeBrandingUrl } from '../utils/branding-url';

export type TemplateFooterProps = {
  isDocument?: boolean;
  reportUrl?: string;
};

export const TemplateFooter = ({ isDocument = true, reportUrl }: TemplateFooterProps) => {
  const branding = useBranding();

  const sourceCodeUrl = NEXT_PUBLIC_ST_SOURCE_URL();

  const safeBrandingUrl = branding.brandingEnabled ? getSafeBrandingUrl(branding.brandingUrl) : null;

  return (
    <Section>
      {reportUrl && (
        <Text className="my-4 text-base text-muted-foreground">
          <Trans>
            Did not expect this email?{' '}
            <Link className="text-primary" href={reportUrl}>
              Click here to report the sender
            </Link>
            . Never sign a document you don't recognize or weren't expecting.
          </Trans>
        </Text>
      )}

      {isDocument && !branding.brandingHidePoweredBy && (
        <Text className="my-4 text-base text-muted-foreground">
          <Trans>
            This document was sent using{' '}
            <Link className="text-primary" href="https://solidten.io">
              Solid Ten Sign
            </Link>
            .
          </Trans>{' '}
          <Link className="text-muted-foreground underline" href={sourceCodeUrl} target="_blank">
            <Trans>Source code</Trans>
          </Link>
        </Text>
      )}

      {/* Solid Ten Sign (AGPL-3.0): the source link also when the "sent using" line is hidden. */}
      {(!isDocument || branding.brandingHidePoweredBy) && (
        <Text className="my-4 text-muted-foreground text-sm">
          <Trans>Solid Ten Sign is open source (AGPL-3.0).</Trans>{' '}
          <Link className="text-muted-foreground underline" href={sourceCodeUrl} target="_blank">
            <Trans>Source code</Trans>
          </Link>
        </Text>
      )}

      {branding.brandingEnabled && branding.brandingCompanyDetails && (
        <Text className="my-8 text-muted-foreground text-sm">
          {branding.brandingCompanyDetails.split('\n').map((line, idx) => {
            return (
              <Fragment key={idx}>
                {idx > 0 && <br />}
                {line}
              </Fragment>
            );
          })}
        </Text>
      )}

      {branding.brandingEnabled && safeBrandingUrl && (
        <Text className="my-8 text-muted-foreground text-sm">
          <Link href={safeBrandingUrl} target="_blank">
            {safeBrandingUrl}
          </Link>
        </Text>
      )}

      {!branding.brandingEnabled && (
        <Text className="my-8 text-muted-foreground text-sm">
          Solid Ten
          <br />
          solidten.io
        </Text>
      )}
    </Section>
  );
};

export default TemplateFooter;
