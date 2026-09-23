<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Authenticates the gateway as the service user, only on the saved Novamira MCP route.
 *
 * WordPress chooses the REST route to dispatch from the rest_route query variable, and a
 * rest_route in the query string or a form-encoded body overrides the one taken from the URL
 * path. Connector 0.1.0 checked only the URL path, so the credential also worked on any other
 * REST route (for example /wp-json/mcp/novamira?rest_route=/wp/v2/users/me). This class checks
 * the route WordPress will actually dispatch, refuses smuggled rest_route parameters, and fences
 * the dispatch itself as a second layer.
 */
final class Indak_Gateway_Authenticator
{
    private const TOKEN_PATTERN = '/^Bearer\s+([A-Za-z0-9_-]{43})$/i';

    private bool $authenticated = false;
    private bool $main_route_seen = false;

    public function __construct(
        private Indak_Gateway_Credential_Store $store,
        private Indak_Gateway_Service_User $users
    ) {}

    public function register_hooks(): void
    {
        add_filter('determine_current_user', [$this, 'authenticate_mcp_request'], 20);
        add_filter('rest_pre_dispatch', [$this, 'fence_route'], 0, 3);
        add_filter('authenticate', [$this, 'block_service_user_login'], 50, 3);
        add_filter('allow_password_reset', [$this, 'block_service_user_reset'], 10, 2);
        add_filter('wp_is_application_passwords_available_for_user', [$this, 'block_service_user_app_passwords'], 10, 2);
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
        if ($user_id <= 0) {
            return $current_user;
        }
        $this->authenticated = true;
        return $user_id;
    }

    /**
     * Second layer: if the service user was authenticated, the first request dispatched must
     * be the MCP route. Later dispatches in the same request are internal sub-requests made
     * by Novamira abilities while handling the MCP call, so they are left alone.
     */
    public function fence_route($result, $server, $request)
    {
        if (!$this->authenticated || $this->main_route_seen || !$request instanceof WP_REST_Request) {
            return $result;
        }
        $expected = $this->expected_route();
        if ($expected !== '' && untrailingslashit($request->get_route()) === $expected) {
            $this->main_route_seen = true;
            return $result;
        }
        return new WP_Error(
            'indak_gateway_route_forbidden',
            __('This credential is only valid on the Novamira MCP endpoint.', 'indak-gateway-connector'),
            ['status' => 403]
        );
    }

    /**
     * Blocks the service account however it is identified: WordPress also accepts an email
     * address as the login, so the resolved account is checked, not just the typed name.
     */
    public function block_service_user_login($user, $username, $password)
    {
        $service_id = $this->users->id();
        $is_service = ($user instanceof WP_User && $service_id > 0 && (int) $user->ID === $service_id)
            || (is_string($username) && strcasecmp(trim($username), $this->users->username()) === 0);
        if ($is_service) {
            return new WP_Error(
                'indak_gateway_interactive_login_blocked',
                __('This service account cannot sign in interactively.', 'indak-gateway-connector')
            );
        }
        return $user;
    }

    public function block_service_user_reset($allow, $user_id)
    {
        $service_id = $this->users->id();
        return $service_id > 0 && (int) $user_id === $service_id ? false : $allow;
    }

    public function block_service_user_app_passwords($available, $user)
    {
        $service_id = $this->users->id();
        return $user instanceof WP_User && $service_id > 0 && (int) $user->ID === $service_id ? false : $available;
    }

    private function is_exact_mcp_request(): bool
    {
        // determine_current_user also runs early in every request, before routing is known.
        // WordPress re-runs it inside the REST server, which is the only pass that counts.
        if (!defined('REST_REQUEST') || !REST_REQUEST || !isset($GLOBALS['wp']) || !$GLOBALS['wp'] instanceof WP) {
            return false;
        }
        if (isset($_GET['rest_route']) || isset($_POST['rest_route'])) {
            return false;
        }
        $expected = $this->expected_route();
        $dispatched = untrailingslashit((string) ($GLOBALS['wp']->query_vars['rest_route'] ?? ''));
        if ($expected === '' || $dispatched !== $expected) {
            return false;
        }
        $mcp_path = untrailingslashit((string) wp_parse_url((string) ($this->store->state()['mcp_url'] ?? ''), PHP_URL_PATH));
        $request_path = untrailingslashit((string) wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH));
        return $request_path !== '' && $request_path === $mcp_path;
    }

    /** The saved MCP URL as a REST route, e.g. /mcp/novamira, or '' if it is not one. */
    private function expected_route(): string
    {
        $mcp_path = untrailingslashit((string) wp_parse_url((string) ($this->store->state()['mcp_url'] ?? ''), PHP_URL_PATH));
        $rest_path = untrailingslashit((string) wp_parse_url(get_rest_url(), PHP_URL_PATH));
        if ($mcp_path === '' || $rest_path === '' || !str_starts_with($mcp_path, $rest_path . '/')) {
            return '';
        }
        return substr($mcp_path, strlen($rest_path));
    }

    private function bearer_token(): string
    {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if ($header === '' && function_exists('getallheaders')) {
            // Some Apache and FastCGI setups never copy Authorization into $_SERVER.
            foreach ((array) getallheaders() as $name => $value) {
                if (strcasecmp((string) $name, 'Authorization') === 0) {
                    $header = (string) $value;
                    break;
                }
            }
        }
        return preg_match(self::TOKEN_PATTERN, trim(wp_unslash((string) $header)), $matches) ? $matches[1] : '';
    }
}
