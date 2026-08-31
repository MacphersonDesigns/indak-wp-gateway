<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Credential_Store
{
    private const OPTION_DIGEST = 'indak_gateway_connector_credential_digest';
    private const OPTION_STATE  = 'indak_gateway_connector_state';

    /** Create a URL-safe 256-bit token. The plaintext exists only during the pairing request. */
    public function generate(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public function store(string $credential): void
    {
        update_option(self::OPTION_DIGEST, $this->digest($credential), false);
    }

    public function verify(string $credential): bool
    {
        $saved = (string) get_option(self::OPTION_DIGEST, '');
        return $saved !== '' && hash_equals($saved, $this->digest($credential));
    }

    public function save_state(array $state): void
    {
        // State is deliberately non-secret. Never add the plaintext credential here.
        update_option(self::OPTION_STATE, $state, false);
    }

    public function state(): array
    {
        $state = get_option(self::OPTION_STATE, []);
        return is_array($state) ? $state : [];
    }

    public function connected(): bool
    {
        return (string) get_option(self::OPTION_DIGEST, '') !== '' && !empty($this->state()['site_key']);
    }

    public function clear(): void
    {
        delete_option(self::OPTION_DIGEST);
        delete_option(self::OPTION_STATE);
    }

    private function digest(string $credential): string
    {
        // A keyed digest means a stolen options-table value cannot be used as the bearer token.
        return hash_hmac('sha256', $credential, wp_salt('auth'));
    }
}
