/**
 * Solid Ten: one definition of a megabyte for every size limit and every size shown. It was
 * 1,000,000 here while the upload route and `formatFileSize` used 1,048,576, so one "15 MB" limit
 * meant two byte counts.
 */
export const BYTES_PER_MEGABYTE = 1024 * 1024;

export function megabytesToBytes(megabytes: number) {
  return megabytes * BYTES_PER_MEGABYTE;
}

/** A size limit as the UI states it, for refusal messages: "15 MB". */
export const formatMegabyteLimit = (megabytes: number) => `${megabytes} MB`;

/**
 * Format a byte count for display, e.g. `1.5 KB`.
 */
export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};
