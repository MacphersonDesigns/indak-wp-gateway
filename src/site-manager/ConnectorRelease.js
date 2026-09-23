'use strict';

/**
 * Latest connector release, for the WordPress connector's self-updater.
 *
 * Client sites ask the gateway instead of GitHub so that dozens of sites behind a few shared
 * hosting IP addresses never exhaust GitHub's unauthenticated rate limit. The gateway looks
 * up GitHub at most once an hour. The connector still refuses any package URL that is not a
 * release asset of this repository, so this endpoint cannot redirect sites to other code.
 */

const DEFAULT_REPO = 'MacphersonDesigns/indak-wp-gateway';
const ASSET_NAME = 'indak-gateway-connector.zip';
const TAG_PATTERN = /^connector-v(\d+)\.(\d+)\.(\d+)$/;
const MAX_NOTES = 20000;

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function pickLatestRelease(releases, repo = DEFAULT_REPO) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    const match = TAG_PATTERN.exec(String(release.tag_name || ''));
    if (!match) continue;
    const tag = release.tag_name;
    const expectedPackage = `https://github.com/${repo}/releases/download/${tag}/${ASSET_NAME}`;
    const asset = (release.assets || []).find((candidate) => candidate && candidate.name === ASSET_NAME);
    if (!asset || asset.browser_download_url !== expectedPackage) continue;
    // GitHub records a SHA-256 for every uploaded asset. WordPress only verifies signatures for
    // wordpress.org packages, so the connector checks this digest before installing.
    const digest = /^sha256:([a-f0-9]{64})$/.exec(String(asset.digest || ''));
    if (!digest) continue;
    const parts = match.slice(1).map(Number);
    if (best && compareVersions(parts, best.parts) <= 0) continue;
    best = {
      parts,
      release: {
        version: parts.join('.'),
        tag,
        package: expectedPackage,
        sha256: digest[1],
        url: String(release.html_url || `https://github.com/${repo}/releases/tag/${tag}`),
        published_at: release.published_at || null,
        notes: String(release.body || '').slice(0, MAX_NOTES),
      },
    };
  }
  return best ? best.release : null;
}

class ConnectorReleaseFeed {
  constructor(options = {}) {
    this.repo = options.repo || process.env.CONNECTOR_RELEASE_REPO || DEFAULT_REPO;
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? '';
    this.fetch = options.fetch || fetch;
    this.ttlMs = options.ttlMs || 3600000;
    this.failureTtlMs = options.failureTtlMs || 600000;
    this.cache = null;
    this.inflight = null;
  }

  async latest() {
    const now = Date.now();
    if (this.cache && this.cache.expires > now) {
      if (this.cache.value === null && this.cache.error) throw new Error(this.cache.error);
      return this.cache.value;
    }
    if (!this.inflight) {
      this.inflight = this.lookup()
        .then((value) => {
          this.cache = { value, expires: Date.now() + this.ttlMs };
          return value;
        })
        .catch((error) => {
          // Serve the last good answer through a GitHub outage, and back off either way.
          const stale = this.cache?.value ?? null;
          this.cache = { value: stale, expires: Date.now() + this.failureTtlMs, error: error.message };
          if (stale) return stale;
          throw error;
        })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  async lookup() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'indak-wp-gateway',
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await this.fetch(
        `https://api.github.com/repos/${this.repo}/releases?per_page=30`,
        { headers, signal: controller.signal, redirect: 'error' }
      );
      if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
      return pickLatestRelease(await response.json(), this.repo);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { ConnectorReleaseFeed, pickLatestRelease, ASSET_NAME, DEFAULT_REPO };
