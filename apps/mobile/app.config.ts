import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Extends app.json. EXPO_BASE_URL lets the website live under a sub-path,
 * e.g. GitHub Pages serves https://<user>.github.io/<repo>/ → EXPO_BASE_URL=/<repo>
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  experiments: { ...config.experiments, baseUrl: process.env.EXPO_BASE_URL ?? '' },
});
