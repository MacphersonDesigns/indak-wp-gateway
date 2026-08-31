<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Pairing_Client
{
    public function details(string $gateway_url, string $code): array
    {
        return $this->request(untrailingslashit($gateway_url) . '/pairings/details', [
            'code'     => $code,
            'home_url' => home_url(),
        ], 200);
    }

    public function claim(string $gateway_url, string $code, string $credential, string $mcp_url): array
    {
        $endpoint = untrailingslashit($gateway_url) . '/pairings/claim';
        return $this->request($endpoint, [
            'code'              => $code,
            'home_url'          => home_url(),
            'mcp_url'           => $mcp_url,
            'credential'        => $credential,
            'connector_version' => INDAK_GATEWAY_CONNECTOR_VERSION,
        ], 201);
    }

    private function request(string $endpoint, array $payload, int $expected_status): array
    {
        $response = wp_safe_remote_post($endpoint, [
            'timeout'     => 30,
            'redirection' => 0,
            'sslverify'   => true,
            'headers'     => ['Content-Type' => 'application/json'],
            'body'        => wp_json_encode($payload),
        ]);
        if (is_wp_error($response)) {
            throw new RuntimeException('Gateway could not be reached: ' . $response->get_error_message());
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        $body = json_decode((string) wp_remote_retrieve_body($response), true);
        if ($status !== $expected_status || !is_array($body)) {
            $message = is_array($body) && isset($body['error']) ? (string) $body['error'] : 'Unexpected gateway response.';
            throw new RuntimeException($message);
        }
        return $body;
    }
}
