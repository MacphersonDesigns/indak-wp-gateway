<?php

define('ABSPATH', __DIR__);
$options = [];
function wp_salt($scheme) { return 'self-test-salt-' . $scheme; }
function update_option($key, $value, $autoload = null) { global $options; $options[$key] = $value; return true; }
function get_option($key, $default = false) { global $options; return $options[$key] ?? $default; }
function delete_option($key) { global $options; unset($options[$key]); return true; }

require dirname(__DIR__) . '/wordpress/indak-gateway-connector/includes/class-credential-store.php';

$store = new Indak_Gateway_Credential_Store();
$credential = $store->generate();
$checks = 0;
$assert = function ($condition, $message) use (&$checks) {
    if (!$condition) { fwrite(STDERR, "FAIL: $message\n"); exit(1); }
    $checks++;
    echo "PASS: $message\n";
};
$assert(strlen($credential) === 43, 'generated credential contains 256 bits in base64url form');
$store->store($credential);
$assert($store->verify($credential), 'stored digest verifies the correct credential');
$assert(!$store->verify($credential . 'wrong'), 'stored digest rejects a different credential');
$assert(strpos(json_encode($options), $credential) === false, 'WordPress options never contain plaintext credential');
$store->save_state(['site_key' => 'test']);
$assert($store->connected(), 'connection state requires digest and site key');
$store->clear();
$assert(!$store->connected(), 'disconnect clears credential and connection state');
echo "\n$checks passed, 0 failed\n";
