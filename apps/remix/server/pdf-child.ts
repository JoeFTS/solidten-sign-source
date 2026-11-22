/**
 * Solid Ten: entry of the PDF child process (packages/lib/server-only/pdf-child). Built by rollup
 * next to the server (build/server/hono/server/pdf-child.js); in dev it runs through vite-node.
 */
import { startPdfChild } from '@documenso/lib/server-only/pdf-child/child-main';

await startPdfChild();
