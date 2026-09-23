<?php

if (!defined('ABSPATH')) {
    exit;
}

/** The gateway could not be reached or did not answer in time, so the outcome is unknown. */
class Indak_Gateway_Transport_Error extends RuntimeException {}

/** The gateway answered and refused the request. */
class Indak_Gateway_Response_Error extends RuntimeException
{
    public function __construct(string $message, private int $status)
    {
        parent::__construct($message);
    }

    public function status(): int
    {
        return $this->status;
    }
}

final class Indak_Gateway_Pairing_Client
{
    public const DEFAULT_GATEWAY_URL = 'https://gateway.indakmedia.com';

    /** Addresses the gateway used before it moved to its permanent domain. */
    private const LEGACY_GATEWAY_URLS = [
        'https://darkseagreen-emu-833683.hostingersite.com',
    ];

    // The gateway's own callback to this site is capped at 20 seconds; leave headroom so
    // WordPress never gives up on a pairing that the gateway then completes.
    private const CLAIM_TIMEOUT = 45;

    /**
     * The gateway to use: a wp-config.php override, else the saved address (moved off the old
     * temporary domain), else the Indak default.
     */
    public static function gateway_url(string $saved = ''): string
    {
        if (defined('INDAK_GATEWAY_URL') && is_string(INDAK_GATEWAY_URL) && INDAK_GATEWAY_URL !== '') {
            return untrailingslashit(INDAK_GATEWAY_URL);
        }
        $saved = untrailingslashit(trim($saved));
        if ($saved === '' || in_array(strtolower($saved), self::LEGACY_GATEWAY_URLS, true)) {
            return self::DEFAULT_GATEWAY_URL;
        }
        return $saved;
    }

    public function details(string $gateway_url, string $code): array
    {
        return $this->request($gateway_url, '/pairings/details', [
            'code'     => $code,
            'home_url' => home_url(),
        ], 200, 20);
    }

    public function claim(string $gateway_url, string $code, string $credential, string $mcp_url): array
    {
        return $this->request($gateway_url, '/pairings/claim', [
            'code'              => $code,
            'home_url'          => home_url(),
            'mcp_url'           => $mcp_url,
            'credential'        => $credential,
            'connector_version' => INDAK_GATEWAY_CONNECTOR_VERSION,
        ], 201, self::CLAIM_TIMEOUT);
    }

    /** Ask the gateway whether it still routes to this site; optionally run a live round trip. */
    public function status(string $gateway_url, string $site_key, string $management_token, bool $verify): array
    {
        return $this->request($gateway_url, '/connector/status', [
            'site_key'          => $site_key,
            'home_url'          => home_url(),
            'verify'            => $verify,
            'connector_version' => INDAK_GATEWAY_CONNECTOR_VERSION,
        ], 200, $verify ? 35 : 8, $management_token);
    }

    public function disconnect(string $gateway_url, string $site_key, string $management_token): array
    {
        return $this->request($gateway_url, '/connector/disconnect', [
            'site_key'          => $site_key,
            'home_url'          => home_url(),
            'connector_version' => INDAK_GATEWAY_CONNECTOR_VERSION,
        ], 200, 15, $management_token);
    }

    private function request(
        string $gateway_url,
        string $path,
        array $payload,
        int $expected_status,
        int $timeout,
        string $bearer = ''
    ): array {
        $headers = ['Content-Type' => 'application/json'];
        if ($bearer !== '') {
            $headers['Authorization'] = 'Bearer ' . $bearer;
        }
        $response = wp_safe_remote_post(untrailingslashit($gateway_url) . $path, [
            'timeout'     => $timeout,
            'redirection' => 0,
            'sslverify'   => true,
            'headers'     => $headers,
            'body'        => wp_json_encode($payload),
        ]);
        if (is_wp_error($response)) {
            throw new Indak_Gateway_Transport_Error(
                'The gateway could not be reached: ' . $response->get_error_message()
            );
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        $body = json_decode((string) wp_remote_retrieve_body($response), true);
        if ($status === $expected_status && is_array($body)) {
            return $body;
        }
        if ($status >= 500 || $status === 429 || !is_array($body)) {
            // A proxy error page or overload is not a decision by the gateway.
            throw new Indak_Gateway_Transport_Error(
                sprintf('The gateway returned an unexpected response (HTTP %d). Try again shortly.', $status)
            );
        }
        $message = isset($body['error']) ? (string) $body['error'] : 'The gateway refused the request.';
        throw new Indak_Gateway_Response_Error($message, $status);
    }
}
