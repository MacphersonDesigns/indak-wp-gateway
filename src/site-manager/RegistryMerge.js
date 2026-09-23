'use strict';

/**
 * Combine the environment registry (SITES / REGISTRY_JSON) with paired database sites.
 *
 * A paired site was verified end to end with its own credential when it was paired, and it is
 * the only kind of entry a teammate can change without a redeploy. So when both registries use
 * the same key, the paired site wins even if the endpoint differs (for example a site moved
 * from the legacy Application Password route to the connector). The override is reported as a
 * diagnostic so the stale environment line can be cleaned up. A removed paired site also
 * suppresses the environment entry with its key.
 */
function mergeRegistries(environmentRegistry, databaseRegistry) {
  const sites = { ...(environmentRegistry?.sites || {}) };
  const skipped = [
    ...(environmentRegistry?.skipped || []),
    ...(databaseRegistry?.skipped || []),
  ];

  // A key whose paired site was removed or disconnected stays unroutable. Otherwise an old
  // SITES line with the same key would quietly take the route back after "Remove".
  for (const key of databaseRegistry?.removedKeys || []) {
    if (!sites[key] || databaseRegistry.sites?.[key]) continue;
    delete sites[key];
    skipped.push({
      key,
      why: 'SITES entry ignored because this paired site was removed; delete the SITES line or pair the site again',
    });
  }

  for (const [key, databaseSite] of Object.entries(databaseRegistry?.sites || {})) {
    const existing = sites[key];
    sites[key] = databaseSite;
    if (!existing) continue;
    const sameEndpoint =
      existing.base.replace(/\/$/, '') === databaseSite.base.replace(/\/$/, '') &&
      existing.mcpPath === databaseSite.mcpPath;
    if (!sameEndpoint) {
      skipped.push({
        key,
        why: 'environment entry replaced by the paired site with the same key; remove it from SITES',
      });
    }
  }

  return { sites, skipped };
}

module.exports = { mergeRegistries };
