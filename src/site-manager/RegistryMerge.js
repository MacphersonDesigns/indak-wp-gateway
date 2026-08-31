'use strict';

/**
 * Merge without silent routing changes. A database row may replace an environment entry only
 * when both describe the exact same endpoint. Conflicts keep the known-working environment
 * route and are surfaced as diagnostics for a human to resolve.
 */
function mergeRegistries(environmentRegistry, databaseRegistry) {
  const sites = { ...(environmentRegistry?.sites || {}) };
  const skipped = [
    ...(environmentRegistry?.skipped || []),
    ...(databaseRegistry?.skipped || []),
  ];

  for (const [key, databaseSite] of Object.entries(databaseRegistry?.sites || {})) {
    const existing = sites[key];
    if (!existing) {
      sites[key] = databaseSite;
      continue;
    }
    const sameEndpoint =
      existing.base.replace(/\/$/, '') === databaseSite.base.replace(/\/$/, '') &&
      existing.mcpPath === databaseSite.mcpPath;
    if (sameEndpoint) {
      sites[key] = databaseSite;
    } else {
      skipped.push({
        key,
        why: 'database entry conflicts with the environment registry endpoint; environment route retained',
      });
    }
  }

  return { sites, skipped };
}

module.exports = { mergeRegistries };
