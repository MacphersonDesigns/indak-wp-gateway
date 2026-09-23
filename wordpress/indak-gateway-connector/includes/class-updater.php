<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Updates the connector from its GitHub releases, so a fix reaches every paired site without
 * someone uploading a ZIP to each one.
 *
 * Release details come from the gateway's /connector/release feed rather than straight from
 * GitHub: dozens of client sites behind a few shared hosting IPs would exhaust GitHub's
 * unauthenticated rate limit. The gateway is not trusted with the code itself. The package URL
 * must be this repository's release asset for that exact version, and the download must match
 * the SHA-256 digest GitHub recorded for the asset.
 */
final class Indak_Gateway_Updater
{
    private const SLUG           = 'indak-gateway-connector';
    private const UPDATE_URI     = 'https://github.com/MacphersonDesigns/indak-wp-gateway';
    private const RELEASES       = 'https://github.com/MacphersonDesigns/indak-wp-gateway/releases';
    private const ASSET          = 'indak-gateway-connector.zip';
    private const CACHE          = 'indak_gateway_connector_release';
    private const LAST_GOOD      = 'indak_gateway_connector_release_last_good';

    public function __construct(private Indak_Gateway_Credential_Store $store) {}

    public function register_hooks(): void
    {
        // WordPress calls update_plugins_{host} for plugins whose Update URI header is on that
        // host. The header also stops WordPress.org from offering a same-named plugin.
        add_filter('update_plugins_github.com', [$this, 'check'], 10, 4);
        add_filter('plugins_api', [$this, 'details'], 10, 3);
        add_filter('upgrader_pre_download', [$this, 'download'], 10, 4);
        add_filter('upgrader_source_selection', [$this, 'fix_folder'], 10, 4);
        add_action('upgrader_process_complete', [$this, 'flush_after_update'], 10, 2);
    }

    /** @param false|array $update */
    public function check($update, $plugin_data, $plugin_file, $locales)
    {
        if ($plugin_file !== $this->basename() || ($plugin_data['UpdateURI'] ?? '') !== self::UPDATE_URI) {
            return $update;
        }
        // Without a known release, report the installed version so the plugin still appears
        // in "no update" and keeps its auto-update toggle.
        $release = $this->release();
        return [
            'slug'         => self::SLUG,
            'version'      => $release['version'] ?? INDAK_GATEWAY_CONNECTOR_VERSION,
            'url'          => $release['url'] ?? self::RELEASES,
            'package'      => $release['package'] ?? '',
            'requires'     => '6.4',
            'requires_php' => '8.0',
            'icons'        => [],
            'banners'      => [],
            'banners_rtl'  => [],
        ];
    }

    /** The "View details" modal on the Plugins screen. */
    public function details($result, $action, $args)
    {
        if ($action !== 'plugin_information' || ($args->slug ?? '') !== self::SLUG) {
            return $result;
        }
        $release = $this->release();
        $notes = (string) ($release['notes'] ?? '');
        return (object) [
            'name'          => 'Indak Gateway Connector',
            'slug'          => self::SLUG,
            'version'       => $release['version'] ?? INDAK_GATEWAY_CONNECTOR_VERSION,
            'author'        => 'Indak Media',
            'homepage'      => self::UPDATE_URI,
            'requires'      => '6.4',
            'requires_php'  => '8.0',
            'last_updated'  => (string) ($release['published_at'] ?? ''),
            'download_link' => $release['package'] ?? '',
            'sections'      => [
                'description' => '<p>' . esc_html__('Securely pairs this Novamira site with the Indak WordPress MCP Gateway.', 'indak-gateway-connector') . '</p>',
                // Release notes are Markdown written on GitHub; show them as escaped text.
                'changelog'   => $notes !== ''
                    ? wpautop(esc_html($notes))
                    : '<p>' . esc_html__('See the release notes on GitHub.', 'indak-gateway-connector') . '</p>',
            ],
            'banners'       => [],
        ];
    }

    /** Download only the validated package, and only if it matches GitHub's digest. */
    public function download($reply, $package, $upgrader, $hook_extra = [])
    {
        if ($reply !== false || ($hook_extra['plugin'] ?? '') !== $this->basename()) {
            return $reply;
        }
        $release = $this->release();
        if (!$release || $package !== $release['package']) {
            return new WP_Error(
                'indak_gateway_unverified_package',
                __('The connector update was not installed because its download address could not be verified.', 'indak-gateway-connector')
            );
        }
        if (!function_exists('download_url')) {
            require_once ABSPATH . 'wp-admin/includes/file.php';
        }
        $file = download_url($package, 300);
        if (is_wp_error($file)) {
            return $file;
        }
        if (!hash_equals($release['sha256'], (string) hash_file('sha256', $file))) {
            wp_delete_file($file);
            return new WP_Error(
                'indak_gateway_checksum_mismatch',
                __('The connector update was not installed because the download did not match its published checksum.', 'indak-gateway-connector')
            );
        }
        return $file;
    }

    /** Keep the plugin in its existing folder even if the ZIP's folder name differs. */
    public function fix_folder($source, $remote_source, $upgrader, $hook_extra = [])
    {
        global $wp_filesystem;
        if (is_wp_error($source) || ($hook_extra['plugin'] ?? '') !== $this->basename() || !$wp_filesystem) {
            return $source;
        }
        $wanted = trailingslashit($remote_source) . dirname($this->basename()) . '/';
        if (trailingslashit($source) === $wanted) {
            return $source;
        }
        if (trailingslashit($source) === trailingslashit($remote_source)) {
            return new WP_Error(
                'indak_gateway_bad_package',
                __('The connector update ZIP must contain a single indak-gateway-connector folder.', 'indak-gateway-connector')
            );
        }
        return $wp_filesystem->move($source, $wanted, true)
            ? $wanted
            : new WP_Error('indak_gateway_rename_failed', __('Could not prepare the connector update folder.', 'indak-gateway-connector'));
    }

    public function flush_after_update($upgrader, $hook_extra): void
    {
        $plugins = (array) ($hook_extra['plugins'] ?? [$hook_extra['plugin'] ?? '']);
        if (($hook_extra['type'] ?? '') === 'plugin' && in_array($this->basename(), $plugins, true)) {
            delete_site_transient(self::CACHE);
        }
    }

    public static function forget(): void
    {
        delete_site_transient(self::CACHE);
        delete_option(self::LAST_GOOD);
    }

    /** The newest validated release, cached for 12 hours (1 hour after a failed lookup). */
    private function release(): ?array
    {
        $cached = get_site_transient(self::CACHE);
        if (is_array($cached)) {
            return $cached['release'] ?? $this->last_good();
        }
        $release = $this->fetch();
        if ($release) {
            set_site_transient(self::CACHE, ['release' => $release], 12 * HOUR_IN_SECONDS);
            update_option(self::LAST_GOOD, $release, false);
            return $release;
        }
        set_site_transient(self::CACHE, ['release' => null], HOUR_IN_SECONDS);
        return $this->last_good();
    }

    private function last_good(): ?array
    {
        $saved = get_option(self::LAST_GOOD, null);
        return is_array($saved) ? $this->validate($saved) : null;
    }

    private function fetch(): ?array
    {
        $gateway = Indak_Gateway_Pairing_Client::gateway_url((string) ($this->store->state()['gateway_url'] ?? ''));
        $response = wp_safe_remote_get($gateway . '/connector/release', [
            'timeout'     => 10,
            'redirection' => 0,
            'headers'     => ['Accept' => 'application/json'],
        ]);
        if (is_wp_error($response) || (int) wp_remote_retrieve_response_code($response) !== 200) {
            return null;
        }
        $body = json_decode((string) wp_remote_retrieve_body($response), true);
        return is_array($body) ? $this->validate($body) : null;
    }

    private function validate(array $release): ?array
    {
        $version = (string) ($release['version'] ?? '');
        $sha256 = strtolower((string) ($release['sha256'] ?? ''));
        if (!preg_match('/^\d+\.\d+\.\d+$/', $version) || !preg_match('/^[a-f0-9]{64}$/', $sha256)) {
            return null;
        }
        $package = self::RELEASES . '/download/connector-v' . $version . '/' . self::ASSET;
        if (($release['package'] ?? '') !== $package) {
            return null;
        }
        return [
            'version'      => $version,
            'package'      => $package,
            'sha256'       => $sha256,
            'url'          => self::RELEASES . '/tag/connector-v' . $version,
            'published_at' => is_string($release['published_at'] ?? null) ? $release['published_at'] : '',
            'notes'        => substr((string) ($release['notes'] ?? ''), 0, 20000),
        ];
    }

    private function basename(): string
    {
        return plugin_basename(INDAK_GATEWAY_CONNECTOR_FILE);
    }
}
