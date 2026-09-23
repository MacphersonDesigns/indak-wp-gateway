<?php
/**
 * Plugin Name: Indak Gateway Connector
 * Description: Securely pairs this Novamira site with the Indak WordPress MCP Gateway.
 * Version: 0.2.0
 * Author: Indak Media
 * Requires at least: 6.4
 * Requires PHP: 8.0
 * Update URI: https://github.com/MacphersonDesigns/indak-wp-gateway
 */

if (!defined('ABSPATH')) {
    exit;
}

define('INDAK_GATEWAY_CONNECTOR_VERSION', '0.2.0');
define('INDAK_GATEWAY_CONNECTOR_FILE', __FILE__);
define('INDAK_GATEWAY_CONNECTOR_DIR', plugin_dir_path(__FILE__));

require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-credential-store.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-service-user.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-authenticator.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-pairing-client.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-updater.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'admin/class-settings-page.php';

/**
 * Keep bootstrap composition here and feature logic in its own classes. This makes the
 * connector easy to test and prevents the WordPress global hook layer from becoming the app.
 */
function indak_gateway_connector_boot(): void
{
    $store = new Indak_Gateway_Credential_Store();
    $users = new Indak_Gateway_Service_User();

    (new Indak_Gateway_Authenticator($store, $users))->register_hooks();
    // Update checks run from cron as well as wp-admin, so the updater is always registered.
    (new Indak_Gateway_Updater($store))->register_hooks();

    if (is_admin()) {
        (new Indak_Gateway_Settings_Page(
            $store,
            $users,
            new Indak_Gateway_Pairing_Client()
        ))->register_hooks();
    }
}
add_action('plugins_loaded', 'indak_gateway_connector_boot');

/**
 * While the plugin is inactive nothing blocks interactive logins or password resets for the
 * service account, so it keeps no role. Its role comes back on reactivation if the site is
 * still paired, or with the next pairing.
 */
function indak_gateway_connector_deactivate(): void
{
    (new Indak_Gateway_Service_User())->demote();
}
register_deactivation_hook(__FILE__, 'indak_gateway_connector_deactivate');

function indak_gateway_connector_activate(): void
{
    $users = new Indak_Gateway_Service_User();
    // Records (and locks down) a 0.1.0 account now, so deactivation can find it later.
    $users->id();
    if ((new Indak_Gateway_Credential_Store())->has_credential()) {
        $users->restore();
    }
}
register_activation_hook(__FILE__, 'indak_gateway_connector_activate');
