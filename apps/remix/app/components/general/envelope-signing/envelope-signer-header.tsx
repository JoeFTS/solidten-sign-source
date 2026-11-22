import { NEXT_PUBLIC_ST_SOURCE_URL } from '@documenso/lib/constants/source-code';
import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { Badge } from '@documenso/ui/primitives/badge';
import { Button } from '@documenso/ui/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@documenso/ui/primitives/dropdown-menu';
import { Separator } from '@documenso/ui/primitives/separator';
import { Plural, Trans } from '@lingui/react/macro';
import { EnvelopeType, RecipientRole } from '@prisma/client';
import { BanIcon, CircleHelpIcon, DownloadCloudIcon, MessageSquareIcon, UserRoundPenIcon } from 'lucide-react';
import { Link } from 'react-router';
import { match } from 'ts-pattern';

import { EnvelopeDownloadDialog } from '~/components/dialogs/envelope-download-dialog';
import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';
import { BrandingLogo } from '~/components/general/branding-logo';
import { HOW_TO_SIGN_HELP_PATH } from '~/components/general/help/help-links';
import { PublicLegalLinksDropdownMenuItems } from '~/components/general/public-legal-links';

import { BrandingLogoIcon } from '../branding-logo-icon';
import { SignerCommentsDialog } from '../comments/signer-comments-dialog';
import { DocumentSigningRejectDialog } from '../document-signing/document-signing-reject-dialog';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';
import { SignerReassignDialog } from '../recipient-reassign/recipient-reassign-dialog';
import { EnvelopeSignerCompleteDialog } from './envelope-signing-complete-dialog';

export const EnvelopeSignerHeader = () => {
  const { envelopeData, envelope, recipientFieldsRemaining, recipient } = useRequiredEnvelopeSigningContext();

  const isEmbedSigning = useEmbedSigningContext() !== null;
  const hasCustomBrandingLogo = envelopeData.settings.brandingEnabled && Boolean(envelopeData.settings.brandingLogo);

  return (
    <nav className="embed--DocumentWidgetHeader flex max-w-screen flex-row justify-between border-border border-b bg-background px-4 py-3 md:px-6">
      {/* Left side - Logo and title */}
      <div className="flex min-w-0 flex-1 items-center space-x-2 md:w-auto md:flex-none">
        {!isEmbedSigning &&
          (hasCustomBrandingLogo ? (
            <img
              src={`/api/branding/logo/team/${envelope.teamId}`}
              alt={`${envelope.team.name}'s Logo`}
              className="h-6 w-auto flex-shrink-0"
            />
          ) : (
            <Link to="/" className="flex-shrink-0">
              <BrandingLogo className="hidden h-6 w-auto md:block" />
              <BrandingLogoIcon className="h-6 w-auto md:hidden" />
            </Link>
          ))}

        <h1 title={envelope.title} className="min-w-0 truncate font-semibold text-base text-foreground md:hidden">
          {envelope.title}
        </h1>

        {!isEmbedSigning && <Separator orientation="vertical" className="hidden h-6 md:block" />}

        <div className="hidden items-center space-x-2 md:flex">
          <h1 className="whitespace-nowrap font-medium text-foreground text-sm">{envelope.title}</h1>

          <Badge className="bg-documenso-100 text-documenso-700 ring-documenso-700/10 dark:bg-documenso-300/10 dark:text-documenso-300 dark:ring-documenso-300/30">
            {match(recipient.role)
              .with(RecipientRole.VIEWER, () => <Trans>Viewer</Trans>)
              .with(RecipientRole.SIGNER, () => <Trans>Signer</Trans>)
              .with(RecipientRole.APPROVER, () => <Trans>Approver</Trans>)
              .with(RecipientRole.ASSISTANT, () => <Trans>Assistant</Trans>)
              .otherwise(() => null)}
          </Badge>
        </div>
      </div>

      {/* Right side - Desktop content */}
      <div className="hidden items-center space-x-2 lg:flex">
        <p className="mr-2 flex-shrink-0 text-muted-foreground text-sm">
          <Plural one="1 Field Remaining" other="# Fields Remaining" value={recipientFieldsRemaining.length} />
        </p>

        <EnvelopeSignerCompleteDialog />
      </div>

      {/* Mobile Actions button */}
      <div className="flex-shrink-0 lg:hidden">
        <MobileDropdownMenu />
      </div>
    </nav>
  );
};

const MobileDropdownMenu = () => {
  const { envelope, recipient } = useRequiredEnvelopeSigningContext();

  const embedSigningContext = useEmbedSigningContext();

  const isEmbedSigning = embedSigningContext !== null;
  const { allowDocumentRejection, allowDownloadPDF, onDocumentRejected } = embedSigningContext || {};

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Trans>Actions</Trans>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end">
        {allowDownloadPDF !== false && (
          <EnvelopeDownloadDialog
            envelopeId={envelope.id}
            envelopeStatus={envelope.status}
            envelopeItems={envelope.envelopeItems}
            token={recipient.token}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <DownloadCloudIcon className="mr-2 h-4 w-4" />
                  <Trans>Download PDF</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {envelope.type === EnvelopeType.DOCUMENT && allowDocumentRejection !== false && (
          <DocumentSigningRejectDialog
            documentId={mapSecondaryIdToDocumentId(envelope.secondaryId)}
            token={recipient.token}
            onRejected={
              onDocumentRejected &&
              ((reason) =>
                onDocumentRejected({
                  token: recipient.token,
                  documentId: mapSecondaryIdToDocumentId(envelope.secondaryId),
                  envelopeId: envelope.id,
                  recipientId: recipient.id,
                  reason,
                }))
            }
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <BanIcon className="mr-2 h-4 w-4" />
                  <Trans>Reject</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {envelope.type === EnvelopeType.DOCUMENT && !isEmbedSigning && (
          <SignerReassignDialog
            token={recipient.token}
            trigger={
              <DropdownMenuItem asChild onSelect={(e) => e.preventDefault()}>
                <div>
                  <UserRoundPenIcon className="mr-2 h-4 w-4" />
                  <Trans>Reassign</Trans>
                </div>
              </DropdownMenuItem>
            }
          />
        )}

        {envelope.type === EnvelopeType.DOCUMENT && (
          <SignerCommentsDialog
            token={recipient.token}
            renderTrigger={(onOpen) => (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  onOpen();
                }}
              >
                <MessageSquareIcon className="mr-2 h-4 w-4" />
                <Trans>Questions and comments</Trans>
              </DropdownMenuItem>
            )}
          />
        )}

        {/* Solid Ten Sign: the signing help article (not in embeds). */}
        {!isEmbedSigning && (
          <DropdownMenuItem asChild>
            <a href={HOW_TO_SIGN_HELP_PATH} target="_blank" rel="noopener noreferrer" data-testid="signing-help-menu-link">
              <CircleHelpIcon className="mr-2 h-4 w-4" />
              <Trans>Need help signing?</Trans>
            </a>
          </DropdownMenuItem>
        )}

        {!isEmbedSigning && <PublicLegalLinksDropdownMenuItems />}

        {/* Solid Ten Sign: the AGPL source link (not in embeds). */}
        {!isEmbedSigning && (
          <DropdownMenuItem asChild className="text-muted-foreground text-xs">
            <a href={NEXT_PUBLIC_ST_SOURCE_URL()} target="_blank" rel="noopener noreferrer">
              <Trans>Source code</Trans>
            </a>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
