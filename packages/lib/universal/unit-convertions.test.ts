import { describe, expect, it } from 'vitest';

import { BRANDING_LOGO_MAX_SIZE_BYTES, BRANDING_LOGO_MAX_SIZE_MB } from '../constants/branding';
import { formatFileSize, formatMegabyteLimit, megabytesToBytes } from './unit-convertions';

describe('one megabyte for every size limit', () => {
  it('uses 1,048,576 bytes, as the upload route and formatFileSize do', () => {
    expect(megabytesToBytes(1)).toBe(1_048_576);
    expect(megabytesToBytes(15)).toBe(15_728_640);
    expect(formatFileSize(megabytesToBytes(15))).toBe('15.0 MB');
  });

  it('a file exactly at the limit is shown as the limit, and the message names it the same way', () => {
    expect(formatMegabyteLimit(15)).toBe('15 MB');
    expect(BRANDING_LOGO_MAX_SIZE_BYTES).toBe(megabytesToBytes(BRANDING_LOGO_MAX_SIZE_MB));
  });
});
