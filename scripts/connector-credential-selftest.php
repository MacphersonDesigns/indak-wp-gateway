<?php

define('ABSPATH', __DIR__);
$options = [];
$salt = 'self-test-salt-auth';
function wp_salt($scheme) { global $salt; return $salt; }
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
$assert(preg_match('/^[A-Za-z0-9_-]{43}$/', $credential) === 1, 'credential matches the authenticator token pattern');
$store->store($credential);
$assert($store->verify($credential), 'stored digest verifies the correct credential');
$assert(!$store->verify($credential . 'wrong'), 'stored digest rejects a different credential');
$assert(strpos(json_encode($options), $credential) === false, 'WordPress options never contain plaintext credential');

$salt = 'rotated-by-a-security-plugin';
$assert($store->verify($credential), 'rotating WordPress salts no longer breaks the connection');

// Cross-language vector: must equal managementToken() in src/site-manager/ConnectorAuth.js
// (checked by scripts/pairing-selftest.js with the same input and expected value).
$vector = 'indak-cross-language-test-vector-0000000000';
$assert(
    Indak_Gateway_Credential_Store::management_token_for($vector) === hash_hmac('sha256', 'indak-gateway-connector/management/v1', $vector),
    'management token is HMAC-SHA256 keyed by the credential'
);
$expected_vector = trim((string) shell_exec('node -e ' . escapeshellarg(
    "process.stdout.write(require('" . addslashes(dirname(__DIR__)) . "/src/site-manager/ConnectorAuth.js').managementToken('$vector'))"
)));
if ($expected_vector !== '') {
    $assert(Indak_Gateway_Credential_Store::management_token_for($vector) === $expected_vector, 'PHP and Node derive the same management token');
}
$assert($store->management_token() === Indak_Gateway_Credential_Store::management_token_for($credential), 'pairing stores the management token');
$assert(strpos(json_encode($options), $credential) === false, 'the management token does not reveal the credential');

// Upgrade path from connector 0.1.0, which stored a wp_salt('auth')-keyed digest and no
// management token.
$options = [];
$salt = 'original-salt';
$legacy = $store->generate();
update_option('indak_gateway_connector_credential_digest', hash_hmac('sha256', $legacy, wp_salt('auth')));
$assert($store->management_token() === '', '0.1.0 pairings start without a management token');
$assert(!$store->verify($store->generate()), 'legacy digest still rejects a wrong credential');
$assert($store->verify($legacy), 'legacy digest verifies the 0.1.0 credential');
$assert(str_starts_with((string) get_option('indak_gateway_connector_credential_digest'), 'v2:'), 'first successful request upgrades the digest format');
$assert($store->management_token() === Indak_Gateway_Credential_Store::management_token_for($legacy), 'the upgrade also derives the management token');
$salt = 'rotated-after-upgrade';
$assert($store->verify($legacy), 'an upgraded pairing survives a later salt rotation');

$store->save_state(['site_key' => 'test']);
$assert($store->connected(), 'connection state requires digest and site key');
$store->save_state(['site_key' => 'test', 'pending' => true]);
$assert(!$store->connected() && $store->pending(), 'an unconfirmed pairing is pending, not connected');
$store->clear();
$assert(!$store->connected() && !$store->pending(), 'disconnect clears credential and connection state');
$assert($store->management_token() === '', 'disconnect clears the management token');
echo "\n$checks passed, 0 failed\n";
