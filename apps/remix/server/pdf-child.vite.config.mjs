// Solid Ten: vite-node config for the PDF child in dev. Like the app's vite config it compiles
// TypeScript, lingui macros and the .po catalogs the certificate and audit pages load.
import { lingui } from '@lingui/vite-plugin';
import macrosPlugin from 'vite-plugin-babel-macros';

export default {
  plugins: [macrosPlugin(), lingui()],
  server: {
    deps: {
      inline: [/@documenso\//],
    },
  },
};
