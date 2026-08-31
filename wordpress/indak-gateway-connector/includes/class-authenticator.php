<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Authenticator
{
    public function __construct(
        private Indak_Gateway_Credential_Store $store,
        private Indak_Gateway_Service_User $users
    ) {}

    public function register_hooks(): void
    {
        add_filter('determine_current_user', [$this, 'authenticate_mcp_request'], 20);
        add_filter('authenticate', [$this, 'block_service_user_login'], 50, 3);
    }

    public function authenticate_mcp_request($current_user)
    {
        if ($current_user || !$this->is_exact_mcp_request()) {
            return $current_user;
        }
        $credential = $this->bearer_token();
        if ($credential === '' || !$this->store->verify($credential)) {
            return $current_user;
        }
        $user_id = $this->users->id();
        return $user_id > 0 ? $user_id : $current_user;
    }

    public function block_service_user_login($user, string $username, string $password)
    {
        if ($username === $this->users->username()) {
            return new WP_Error(
                'indak_gateway_interactive_login_blocked',
                __('This service account cannot sign in interactively.', 'indak-gateway-connector')
            );
        }
        return $user;
    }

    private function is_exact_mcp_request(): bool
    {
        $request_path = (string) wp_parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);
        $mcp_path = (string) wp_parse_url($this->store->state()['mcp_url'] ?? '', PHP_URL_PATH);
        return $request_path !== '' && untrailingslashit($request_path) === untrailingslashit($mcp_path);
    }

    private function bearer_token(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        return preg_match('/^Bearer\s+(.+)$/i', (string) $header, $matches)
            ? trim($matches[1])
            : '';
    }
}
