<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Credential_Store
{
    private const OPTION_DIGEST     = 'indak_gateway_connector_credential_digest';
    private const OPTION_STATE      = 'indak_gateway_connector_state';
    private const OPTION_MANAGEMENT = 'indak_gateway_connector_management_token';

    private const DIGEST_PREFIX = 'v2:';
    private const DIGEST_LABEL  = 'indak-gateway-connector/credential-digest/v2';

    /** Keep in sync with MANAGEMENT_LABEL in src/site-manager/ConnectorAuth.js. */
    public const MANAGEMENT_LABEL = 'indak-gateway-connector/management/v1';

    /** Create a URL-safe 256-bit token. The plaintext exists only during the pairing request. */
    public function generate(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    /**
     * Store only one-way values derived from the credential: a digest to verify the gateway's
     * MCP requests, and the management token the gateway expects on status and disconnect calls.
     */
    public function store(string $credential): void
    {
        update_option(self::OPTION_DIGEST, self::DIGEST_PREFIX . $this->digest($credential), false);
        update_option(self::OPTION_MANAGEMENT, self::management_token_for($credential), false);
    }

    public function verify(string $credential): bool
    {
        $saved = (string) get_option(self::OPTION_DIGEST, '');
        if ($saved === '') {
            return false;
        }
        if (str_starts_with($saved, self::DIGEST_PREFIX)) {
            return hash_equals($saved, self::DIGEST_PREFIX . $this->digest($credential));
        }

        // Connector 0.1.0 keyed its digest with wp_salt('auth'). Rotating the salts (security
        // plugins, host tools, or a wp-config.php rebuild) silently broke the connection. The
        // first request that still verifies upgrades to the salt-independent format, and also
        // derives the management token that 0.1.0 never stored.
        if (!hash_equals($saved, hash_hmac('sha256', $credential, wp_salt('auth')))) {
            return false;
        }
        $this->store($credential);
        return true;
    }

    public function management_token(): string
    {
        return (string) get_option(self::OPTION_MANAGEMENT, '');
    }

    public static function management_token_for(string $credential): string
    {
        return hash_hmac('sha256', self::MANAGEMENT_LABEL, $credential);
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

    public function has_credential(): bool
    {
        return (string) get_option(self::OPTION_DIGEST, '') !== '';
    }

    /** Paired and confirmed by the gateway. */
    public function connected(): bool
    {
        $state = $this->state();
        return $this->has_credential() && !empty($state['site_key']) && empty($state['pending']);
    }

    /** A credential was offered to the gateway but its answer never arrived. */
    public function pending(): bool
    {
        return $this->has_credential() && !empty($this->state()['pending']);
    }

    public function clear(): void
    {
        delete_option(self::OPTION_DIGEST);
        delete_option(self::OPTION_STATE);
        delete_option(self::OPTION_MANAGEMENT);
    }

    private function digest(string $credential): string
    {
        // The credential is 256 random bits, so a domain-separated SHA-256 cannot be reversed
        // or brute forced, and a copied options-table value is useless as a bearer token.
        return hash_hmac('sha256', $credential, self::DIGEST_LABEL);
    }
}
