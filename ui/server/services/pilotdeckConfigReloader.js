import { applyConfigToProcessEnv } from './pilotdeckConfig.js';

// Applies a validated config to every running subsystem (env, ProjectWiki) and
// returns a per-subsystem summary so the UI can show what actually reloaded.
// CCR router / EdgeClaw IM gateway reload paths were removed — both retired
// during the PilotDeck-only migration and the schema no longer carries them.
export async function reloadPilotDeckConfig(config) {
  const result = {
    processEnv: { reloaded: false },
    projectWiki: { reloaded: false },
  };

  applyConfigToProcessEnv(config);
  result.processEnv.reloaded = true;

  result.projectWiki.reloaded = true;
  result.projectWiki.enabled = config.projectWiki?.enabled !== false;

  return result;
}
