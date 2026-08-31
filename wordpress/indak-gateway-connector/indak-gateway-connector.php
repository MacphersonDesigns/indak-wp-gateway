<?php
/**
 * Plugin Name: Indak Gateway Connector
 * Description: Securely pairs this Novamira site with the Indak WordPress MCP Gateway.
 * Version: 0.1.0
 * Author: Indak Media
 * Requires at least: 6.4
 * Requires PHP: 8.0
 */

if (!defined('ABSPATH')) {
    exit;
}

define('INDAK_GATEWAY_CONNECTOR_VERSION', '0.1.0');
define('INDAK_GATEWAY_CONNECTOR_FILE', __FILE__);
define('INDAK_GATEWAY_CONNECTOR_DIR', plugin_dir_path(__FILE__));

require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-credential-store.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-service-user.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-authenticator.php';
require_once INDAK_GATEWAY_CONNECTOR_DIR . 'includes/class-pairing-client.php';
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

    if (is_admin()) {
        (new Indak_Gateway_Settings_Page(
            $store,
            $users,
            new Indak_Gateway_Pairing_Client()
        ))->register_hooks();
    }
}
add_action('plugins_loaded', 'indak_gateway_connector_boot');
