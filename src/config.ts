import { GhostConfig, fetchSettings } from './ghost.js';

/** Resolved public identity of the Ghost site this server front-ends. */
export interface SiteInfo {
  name: string;
  description: string;
  url: string;
  lang: string;
}

const stripSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Resolve the site's identity so the server works on ANY Ghost instance out of the box:
 * explicit env overrides win, otherwise we read Ghost's own `/settings/`, otherwise safe
 * fallbacks. Called once at startup; if Ghost is unreachable then, the env/defaults are used.
 */
export async function resolveSiteInfo(cfg: GhostConfig): Promise<SiteInfo> {
  let fromGhost: Partial<SiteInfo> = {};
  try {
    const s = await fetchSettings(cfg);
    fromGhost = { name: s.title, description: s.description, url: s.url, lang: s.lang };
  } catch {
    // Ghost down at boot — fall back to env/defaults; a later restart picks up the real values.
  }
  return {
    name: process.env.SITE_NAME ?? fromGhost.name ?? 'this Ghost site',
    description: process.env.SITE_DESCRIPTION ?? fromGhost.description ?? '',
    url: stripSlash(process.env.SITE_URL ?? fromGhost.url ?? cfg.url),
    lang: fromGhost.lang ?? 'en',
  };
}
