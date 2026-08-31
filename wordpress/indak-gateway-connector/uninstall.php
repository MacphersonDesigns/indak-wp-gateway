<?php

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('indak_gateway_connector_credential_digest');
delete_option('indak_gateway_connector_state');
