<?php

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

// Keep the service account (and anything it authored) but take away its role; nothing
// protects it once the plugin is gone. The ownership marker is kept on purpose, so a
// reinstalled connector recognizes its own account instead of refusing it as foreign.
$service_user_id = (int) get_site_option('indak_gateway_connector_service_user_id', 0);
$service_user = $service_user_id > 0 ? get_userdata($service_user_id) : get_user_by('login', 'indak-gateway-bot');
if (
    $service_user instanceof WP_User
    && $service_user->user_login === 'indak-gateway-bot'
    && ($service_user_id > 0 || in_array('administrator', (array) $service_user->roles, true))
) {
    $service_user->set_role('');
}

delete_option('indak_gateway_connector_credential_digest');
delete_option('indak_gateway_connector_state');
delete_option('indak_gateway_connector_management_token');
delete_option('indak_gateway_connector_release_last_good');
delete_site_transient('indak_gateway_connector_release');
delete_transient('indak_gateway_connector_status');
global $wpdb;
delete_option('indak_gateway_pairing_' . md5($wpdb->prefix));
