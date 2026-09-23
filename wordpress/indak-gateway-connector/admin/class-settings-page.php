<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Settings_Page
{
    private const PAGE             = 'indak-gateway-connector';
    private const NOTICE_TRANSIENT = 'indak_gateway_notice_';
    private const STATUS_TRANSIENT = 'indak_gateway_connector_status';
    private const PAIR_LOCK        = 'indak_gateway_pairing_';
    // How long after a claim started a "not found" from the gateway may still mean "not
    // finished yet": the claim's own timeout plus the gateway's database write.
    private const CLAIM_GRACE      = 120;

    private string $hook = '';
    private ?array $notice = null;

    public function __construct(
        private Indak_Gateway_Credential_Store $store,
        private Indak_Gateway_Service_User $users,
        private Indak_Gateway_Pairing_Client $client
    ) {}

    public function register_hooks(): void
    {
        add_action('admin_menu', [$this, 'add_page']);
        add_action('admin_post_indak_gateway_pair', [$this, 'pair']);
        add_action('admin_post_indak_gateway_test', [$this, 'test']);
        add_action('admin_post_indak_gateway_check', [$this, 'check']);
        add_action('admin_post_indak_gateway_reset', [$this, 'reset']);
        add_action('admin_post_indak_gateway_disconnect', [$this, 'disconnect']);
        add_filter('removable_query_args', [$this, 'removable_query_args']);
    }

    public function add_page(): void
    {
        $this->hook = (string) add_options_page(
            __('Indak Gateway', 'indak-gateway-connector'),
            __('Indak Gateway', 'indak-gateway-connector'),
            'manage_options',
            self::PAGE,
            [$this, 'render']
        );
        if ($this->hook !== '') {
            add_action('load-' . $this->hook, [$this, 'load']);
        }
    }

    /** Runs before the admin header, so the page title can say when something failed. */
    public function load(): void
    {
        $key = self::NOTICE_TRANSIENT . get_current_user_id();
        $notice = get_transient($key);
        if (is_array($notice)) {
            delete_transient($key);
            $this->notice = $notice;
            add_filter('admin_title', [$this, 'admin_title']);
            add_action('admin_enqueue_scripts', [$this, 'enqueue_notice_focus']);
        }
    }

    public function admin_title(string $title): string
    {
        return ($this->notice['type'] ?? '') === 'error'
            ? __('Error:', 'indak-gateway-connector') . ' ' . $title
            : $title;
    }

    public function enqueue_notice_focus(): void
    {
        wp_enqueue_script(
            'indak-gateway-notice-focus',
            plugins_url('notice-focus.js', __FILE__),
            ['common'],
            INDAK_GATEWAY_CONNECTOR_VERSION,
            true
        );
    }

    public function removable_query_args(array $args): array
    {
        $args[] = 'indak_gateway_notice';
        $args[] = 'indak_gateway_code';
        return $args;
    }

    // ------------------------------------------------------------------ actions

    public function pair(): void
    {
        $this->authorize('indak_gateway_pair');
        if ($this->store->connected()) {
            $this->redirect('error', __('This site is already connected. Disconnect it before connecting again.', 'indak-gateway-connector'));
        }
        if ($this->store->pending()) {
            $this->redirect('warning', __('An earlier connection attempt is still unconfirmed. Choose Check connection, or Start over.', 'indak-gateway-connector'));
        }
        $gateway_url = Indak_Gateway_Pairing_Client::gateway_url(esc_url_raw(wp_unslash($_POST['gateway_url'] ?? '')));
        $code = $this->clean_code(wp_unslash($_POST['pairing_code'] ?? ''));
        if ($code === '') {
            $this->redirect('error', __('Enter the pairing code from the Site Manager.', 'indak-gateway-connector'));
        }
        if (!str_starts_with($gateway_url, 'https://') && wp_get_environment_type() !== 'local') {
            $this->redirect('error', __('The gateway URL must start with https://.', 'indak-gateway-connector'));
        }

        // One pairing at a time: a double-click or a second tab would otherwise overwrite the
        // credential the first request is offering to the gateway. A database lock is atomic
        // (WordPress options are not) and is released automatically when the request ends.
        global $wpdb;
        $lock = self::PAIR_LOCK . md5($wpdb->prefix);
        $suppress = $wpdb->suppress_errors(true);
        $acquired = $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 0)', $lock));
        $wpdb->suppress_errors($suppress);
        if ($acquired === null || !in_array((string) $acquired, ['0', '1'], true)) {
            // A database without MySQL's GET_LOCK (SQLite translation layers answer with other
            // values): fall back to a best-effort option lock.
            $fresh = add_option($lock, time(), '', false);
            $stale = !$fresh && (int) get_option($lock, 0) < time() - 90;
            if ($stale) {
                update_option($lock, time(), false);
            }
            $acquired = $fresh || $stale ? '1' : '0';
        }
        if ((string) $acquired !== '1') {
            $this->redirect('warning', __('Another connection attempt is in progress. Wait a minute, then reload this page.', 'indak-gateway-connector'));
        }
        [$type, $message] = $this->attempt_pairing($gateway_url, $code);
        $suppress = $wpdb->suppress_errors(true);
        $wpdb->query($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
        $wpdb->suppress_errors($suppress);
        delete_option($lock);
        $this->redirect($type, $message);
    }

    /** @return array{0: string, 1: string} notice type and message */
    private function attempt_pairing(string $gateway_url, string $code): array
    {
        $credential = null;
        try {
            // Resolve the exact manager-approved MCP path first. This supports Novamira
            // versions and subdirectory builds without asking the WordPress admin to know it.
            $details = $this->client->details($gateway_url, $code);
            $mcp_url = esc_url_raw((string) ($details['mcp_url'] ?? ''));
            if (self::host($mcp_url) === '' || self::host($mcp_url) !== self::host(home_url())) {
                throw new Indak_Gateway_Response_Error(__('That pairing code was created for a different site.', 'indak-gateway-connector'), 400);
            }
            // Before any credential exists, so a refusal here leaves nothing to clean up.
            $this->users->ensure();

            $credential = $this->store->generate();
            $this->store->store($credential);
            // Saved before the claim: the gateway calls this site back with the new credential
            // before it answers, and if that answer is lost the site can still ask later.
            $state = [
                'gateway_url' => $gateway_url,
                'site_key'    => sanitize_key((string) ($details['site_key'] ?? '')),
                'label'       => sanitize_text_field((string) ($details['label'] ?? '')),
                'environment' => ($details['environment'] ?? '') === 'live' ? 'live' : 'staging',
                'mcp_url'     => $mcp_url,
                'pending'     => true,
                'started_at'  => gmdate('c'),
            ];
            $this->store->save_state($state);

            $result = $this->client->claim($gateway_url, $code, $credential, $mcp_url);
            unset($state['pending'], $state['started_at']);
            $state['site_key'] = sanitize_key((string) ($result['site_key'] ?? $state['site_key']));
            $state['label'] = sanitize_text_field((string) ($result['label'] ?? $state['label']));
            $state['environment'] = ($result['environment'] ?? '') === 'live' ? 'live' : 'staging';
            $state['paired_at'] = gmdate('c');
            $this->store->save_state($state);
            delete_transient(self::STATUS_TRANSIENT);
            return ['success', !empty($result['replaced'])
                ? __('This site is reconnected. The gateway replaced its previous connection.', 'indak-gateway-connector')
                : __('This site is connected to the Indak Gateway.', 'indak-gateway-connector')];
        } catch (Indak_Gateway_Transport_Error $error) {
            if ($credential !== null) {
                return ['warning', __('The gateway did not answer in time, so it is not yet known whether the connection worked. Choose Check connection below.', 'indak-gateway-connector')];
            }
            return ['error', $error->getMessage()];
        } catch (Throwable $error) {
            // The gateway refused, so the credential this request offered is useless. Clear it
            // only if it is still the one stored; never touch anything this request did not write.
            if ($credential !== null && $this->store->verify($credential)) {
                $this->store->clear();
            }
            return ['error', $error->getMessage()];
        }
    }

    public function test(): void
    {
        $this->authorize('indak_gateway_test');
        $state = $this->store->state();
        if ($this->store->management_token() === '') {
            // A 0.1.0 pairing has no management token until the gateway next calls this site,
            // so the gateway would answer "not found" even though the connection works.
            $this->redirect('warning', $this->legacy_status_text());
        }
        try {
            $status = $this->client->status(
                Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? '')),
                (string) ($state['site_key'] ?? ''),
                $this->store->management_token(),
                true
            );
            set_transient(self::STATUS_TRANSIENT, ['recognized' => true] + $status, 5 * MINUTE_IN_SECONDS);
            if (!empty($status['check']['ok'])) {
                $this->redirect('success', __('Connection verified: the gateway reached this site\'s Novamira endpoint.', 'indak-gateway-connector'));
            }
            $this->redirect('error', sprintf(
                /* translators: %s: error reported by the gateway */
                __('The gateway recognizes this site but could not reach it: %s', 'indak-gateway-connector'),
                (string) ($status['check']['error'] ?? __('unknown error', 'indak-gateway-connector'))
            ));
        } catch (Indak_Gateway_Response_Error $error) {
            if ($error->status() === 404) {
                set_transient(self::STATUS_TRANSIENT, ['recognized' => false], 5 * MINUTE_IN_SECONDS);
                $this->redirect('error', $this->not_recognized_text($state));
            }
            $this->redirect('error', $error->getMessage());
        } catch (Indak_Gateway_Transport_Error $error) {
            $this->redirect('error', $error->getMessage());
        }
    }

    /** Resolve a pairing whose answer was lost: the gateway knows whether it completed. */
    public function check(): void
    {
        $this->authorize('indak_gateway_check');
        if (!$this->store->pending()) {
            $this->redirect('success', __('There is no pending connection to check.', 'indak-gateway-connector'));
        }
        $state = $this->store->state();
        if ($this->store->management_token() === '') {
            $this->redirect('warning', __('This connection cannot be checked from here. Choose Start over and connect again with a new pairing code.', 'indak-gateway-connector'));
        }
        try {
            $this->client->status(
                Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? '')),
                (string) ($state['site_key'] ?? ''),
                $this->store->management_token(),
                false
            );
            unset($state['pending'], $state['started_at']);
            $state['paired_at'] = gmdate('c');
            $this->store->save_state($state);
            delete_transient(self::STATUS_TRANSIENT);
            $this->redirect('success', __('The gateway confirmed the connection. This site is connected.', 'indak-gateway-connector'));
        } catch (Indak_Gateway_Response_Error $error) {
            if ($error->status() === 404) {
                $started = strtotime((string) ($state['started_at'] ?? '')) ?: 0;
                if ($started > time() - self::CLAIM_GRACE) {
                    // The gateway may still be finishing; clearing now could strand a
                    // connection it is about to activate.
                    $this->redirect('warning', __('The gateway has not finished confirming this connection yet. Wait a minute, then choose Check connection again.', 'indak-gateway-connector'));
                }
                $this->store->clear();
                $this->redirect('error', __('The pairing did not complete, so this site is not connected. Create a new pairing code in the Site Manager and connect again.', 'indak-gateway-connector'));
            }
            $this->redirect('error', $error->getMessage());
        } catch (Indak_Gateway_Transport_Error $error) {
            $this->redirect('error', $error->getMessage());
        }
    }

    public function reset(): void
    {
        $this->authorize('indak_gateway_reset');
        $this->store->clear();
        delete_transient(self::STATUS_TRANSIENT);
        $this->redirect('success', __('The pending connection was removed from this site. Enter a new pairing code to connect.', 'indak-gateway-connector'));
    }

    public function disconnect(): void
    {
        $this->authorize('indak_gateway_disconnect');
        $state = $this->store->state();
        $token = $this->store->management_token();
        $site_key = (string) ($state['site_key'] ?? '');
        $outcome = 'not-notified';
        $reason = __('this connection was made with connector 0.1.0, which cannot notify the gateway', 'indak-gateway-connector');

        if ($token !== '' && $site_key !== '') {
            try {
                $this->client->disconnect(
                    Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? '')),
                    $site_key,
                    $token
                );
                $outcome = 'removed';
            } catch (Indak_Gateway_Response_Error $error) {
                $outcome = $error->status() === 404 ? 'already-removed' : 'not-notified';
                $reason = $error->getMessage();
            } catch (Indak_Gateway_Transport_Error $error) {
                $reason = $error->getMessage();
            }
        }

        // Clearing the local digest always happens: it is what revokes the gateway's access.
        $this->store->clear();
        delete_transient(self::STATUS_TRANSIENT);

        if ($outcome === 'removed') {
            $this->redirect('success', __('Disconnected. The gateway removed this site.', 'indak-gateway-connector'));
        }
        if ($outcome === 'already-removed') {
            if ($this->address_changed($state)) {
                $this->redirect('warning', __('Disconnected on this site. The gateway did not recognize this connection because this site\'s address changed after it was paired. If the old address still appears in the Site Manager, a manager should remove it there.', 'indak-gateway-connector'));
            }
            $this->redirect('success', __('Disconnected on this site. The gateway did not recognize this connection, so it had most likely been removed already. If it still appears in the Site Manager, a manager can remove it there.', 'indak-gateway-connector'));
        }
        $this->redirect('warning', sprintf(
            /* translators: %s: why the gateway could not be told */
            __('Disconnected on this site, so the gateway can no longer use it. The gateway could not be told (%s). It will show this site as failing until a manager removes it in the Site Manager, or until you connect this site again, which replaces the old record automatically.', 'indak-gateway-connector'),
            rtrim($reason, '.')
        ));
    }

    // ------------------------------------------------------------------- render

    public function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $state = $this->store->state();
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Indak Gateway Connector', 'indak-gateway-connector'); ?></h1>
            <hr class="wp-header-end">
            <?php $this->render_notice(); ?>
            <p><?php esc_html_e('Pairs this Novamira installation with the Indak team gateway.', 'indak-gateway-connector'); ?></p>
            <?php
            if ($this->store->connected()) {
                $this->render_connected($state);
            } elseif ($this->store->pending()) {
                $this->render_pending();
            } else {
                $this->render_connect_form($state);
            }
            ?>
        </div>
        <?php
    }

    private function render_notice(): void
    {
        if (!$this->notice) {
            return;
        }
        $type = in_array($this->notice['type'] ?? '', ['success', 'warning', 'error'], true) ? $this->notice['type'] : 'error';
        $prefix = ['error' => __('Error:', 'indak-gateway-connector'), 'warning' => __('Warning:', 'indak-gateway-connector')][$type] ?? '';
        ?>
        <div id="indak-gateway-notice" class="notice notice-<?php echo esc_attr($type); ?> is-dismissible" tabindex="-1">
            <p><?php if ($prefix !== '') : ?><strong><?php echo esc_html($prefix); ?></strong> <?php endif; ?><?php echo esc_html((string) ($this->notice['message'] ?? '')); ?></p>
        </div>
        <?php
    }

    private function render_connected(array $state): void
    {
        $status = $this->gateway_status($state);
        $problem = $status['kind'] === 'not-recognized';
        ?>
        <h2><?php echo $problem
            ? esc_html__('Connection problem', 'indak-gateway-connector')
            : esc_html__('Connected to Indak Gateway', 'indak-gateway-connector'); ?></h2>
        <table class="widefat striped" style="max-width: 760px">
            <caption class="screen-reader-text"><?php esc_html_e('Connection details', 'indak-gateway-connector'); ?></caption>
            <tbody>
            <tr><th scope="row"><?php esc_html_e('Gateway status', 'indak-gateway-connector'); ?></th><td><?php $this->render_status_cell($status); ?></td></tr>
            <tr><th scope="row"><?php esc_html_e('Site key', 'indak-gateway-connector'); ?></th><td><?php echo esc_html($state['site_key'] ?? ''); ?></td></tr>
            <tr><th scope="row"><?php esc_html_e('Label', 'indak-gateway-connector'); ?></th><td><?php echo esc_html($state['label'] ?? ''); ?></td></tr>
            <tr><th scope="row"><?php esc_html_e('Environment', 'indak-gateway-connector'); ?></th><td><?php echo esc_html(($state['environment'] ?? '') === 'live' ? __('Live', 'indak-gateway-connector') : __('Staging', 'indak-gateway-connector')); ?></td></tr>
            <tr><th scope="row"><?php esc_html_e('Gateway URL', 'indak-gateway-connector'); ?></th><td><code><?php echo esc_html(Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? ''))); ?></code></td></tr>
            <tr><th scope="row"><?php esc_html_e('MCP endpoint', 'indak-gateway-connector'); ?></th><td><code><?php echo esc_html($state['mcp_url'] ?? ''); ?></code></td></tr>
            <tr><th scope="row"><?php esc_html_e('Connector version', 'indak-gateway-connector'); ?></th><td><?php echo esc_html(INDAK_GATEWAY_CONNECTOR_VERSION); ?></td></tr>
            </tbody>
        </table>
        <div class="indak-gateway-actions" style="display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start;margin-top:1rem">
            <?php
            if ($this->store->management_token() !== '') {
                $this->action_form('indak_gateway_test', __('Test connection', 'indak-gateway-connector'), 'secondary');
            }
            $this->action_form('indak_gateway_disconnect', __('Disconnect this site', 'indak-gateway-connector'), 'delete');
            ?>
        </div>
        <p class="description"><?php echo $this->store->management_token() !== ''
            ? esc_html__('Test connection asks the gateway to call this site the same way ClickUp Brain does. It can take up to 30 seconds.', 'indak-gateway-connector')
            : esc_html($this->legacy_status_text()); ?></p>
        <?php
    }

    private function render_status_cell(array $status): void
    {
        $icons = [
            'ok'             => ['dashicons-yes-alt', '#007017'],
            'failing'        => ['dashicons-warning', '#b32d2e'],
            'not-recognized' => ['dashicons-warning', '#b32d2e'],
            'unknown'        => ['dashicons-info', '#50575e'],
        ];
        [$icon, $color] = $icons[$status['kind']] ?? $icons['unknown'];
        ?>
        <span class="dashicons <?php echo esc_attr($icon); ?>" style="color:<?php echo esc_attr($color); ?>" aria-hidden="true"></span>
        <?php if ($status['kind'] === 'not-recognized') : ?><strong><?php esc_html_e('Not recognized.', 'indak-gateway-connector'); ?></strong> <?php endif; ?>
        <?php echo esc_html($status['text']); ?>
        <?php if (!empty($status['time'])) : ?>
            (<time datetime="<?php echo esc_attr(gmdate('c', $status['time'])); ?>"><?php echo esc_html(wp_date(get_option('date_format') . ' ' . get_option('time_format'), $status['time'])); ?></time>)
        <?php endif; ?>
        <?php
    }

    private function render_pending(): void
    {
        ?>
        <h2><?php esc_html_e('Connection not confirmed', 'indak-gateway-connector'); ?></h2>
        <p><?php echo wp_kses(
            __('This site sent its pairing request, but the gateway did not answer in time, so it is not yet known whether the connection worked. Choose <strong>Check connection</strong> to ask the gateway. If it did not work, choose <strong>Start over</strong> and enter a new pairing code.', 'indak-gateway-connector'),
            ['strong' => []]
        ); ?></p>
        <div class="indak-gateway-actions" style="display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start">
            <?php
            $this->action_form('indak_gateway_check', __('Check connection', 'indak-gateway-connector'), 'primary');
            $this->action_form('indak_gateway_reset', __('Start over', 'indak-gateway-connector'), 'secondary', 'indak-gateway-reset-help');
            ?>
        </div>
        <p id="indak-gateway-reset-help" class="description"><?php esc_html_e('Start over removes the unconfirmed credential from this site. You will need a new pairing code.', 'indak-gateway-connector'); ?></p>
        <?php
    }

    private function render_connect_form(array $state): void
    {
        $prefilled = $this->clean_code(wp_unslash($_GET['indak_gateway_code'] ?? ''));
        $locked = defined('INDAK_GATEWAY_URL') && is_string(INDAK_GATEWAY_URL) && INDAK_GATEWAY_URL !== '';
        $gateway_url = Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? ''));
        ?>
        <h2><?php esc_html_e('Connect this site', 'indak-gateway-connector'); ?></h2>
        <p><?php echo $prefilled !== ''
            ? esc_html__('The pairing code from the Site Manager is filled in below. Check it, then choose Connect to Indak Gateway.', 'indak-gateway-connector')
            : esc_html__('Create a one-time code in the gateway Site Manager, then paste it here.', 'indak-gateway-connector'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="indak_gateway_pair">
            <?php wp_nonce_field('indak_gateway_pair'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="gateway_url"><?php esc_html_e('Gateway URL', 'indak-gateway-connector'); ?></label></th>
                    <td>
                        <input class="regular-text" type="url" id="gateway_url" name="gateway_url" required spellcheck="false"
                               value="<?php echo esc_attr($gateway_url); ?>" aria-describedby="gateway_url-description"<?php echo $locked ? ' readonly' : ''; ?>>
                        <p class="description" id="gateway_url-description"><?php echo $locked
                            ? esc_html__('Set by INDAK_GATEWAY_URL in wp-config.php.', 'indak-gateway-connector')
                            : esc_html__('Leave this as it is unless the Indak team gives you a different address.', 'indak-gateway-connector'); ?></p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="pairing_code"><?php esc_html_e('Pairing code', 'indak-gateway-connector'); ?></label></th>
                    <td>
                        <input class="regular-text code" type="text" id="pairing_code" name="pairing_code" required autocomplete="off" spellcheck="false"
                               value="<?php echo esc_attr($prefilled); ?>" aria-describedby="pairing_code-description">
                        <p class="description" id="pairing_code-description"><?php echo $prefilled !== ''
                            ? esc_html__('Filled in from the link you opened in the Site Manager. Check that it matches the code shown there.', 'indak-gateway-connector')
                            : esc_html__('Paste the one-time code from the Site Manager. Codes expire after 10 minutes, so use it soon after you create it.', 'indak-gateway-connector'); ?></p>
                    </td>
                </tr>
            </table>
            <?php submit_button(__('Connect to Indak Gateway', 'indak-gateway-connector'), 'primary', 'indak_gateway_connect', true, ['id' => 'indak-gateway-connect']); ?>
        </form>
        <?php
    }

    /** One small form per action, with a unique button id instead of submit_button()'s "submit". */
    private function action_form(string $action, string $label, string $type, string $described_by = ''): void
    {
        $attributes = ['id' => str_replace('_', '-', $action)];
        if ($described_by !== '') {
            $attributes['aria-describedby'] = $described_by;
        }
        ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="<?php echo esc_attr($action); ?>">
            <?php wp_nonce_field($action); ?>
            <?php submit_button($label, $type, $action, false, $attributes); ?>
        </form>
        <?php
    }

    /**
     * What the gateway says about this site, cached briefly so opening the page stays fast.
     *
     * @return array{kind: string, text: string, time?: int}
     */
    private function gateway_status(array $state): array
    {
        $token = $this->store->management_token();
        if ($token === '') {
            return ['kind' => 'unknown', 'text' => $this->legacy_status_text()];
        }
        $cached = get_transient(self::STATUS_TRANSIENT);
        if (!is_array($cached)) {
            try {
                $cached = ['recognized' => true] + $this->client->status(
                    Indak_Gateway_Pairing_Client::gateway_url((string) ($state['gateway_url'] ?? '')),
                    (string) ($state['site_key'] ?? ''),
                    $token,
                    false
                );
            } catch (Indak_Gateway_Response_Error $error) {
                $cached = $error->status() === 404 ? ['recognized' => false] : ['unreachable' => $error->getMessage()];
            } catch (Indak_Gateway_Transport_Error $error) {
                $cached = ['unreachable' => $error->getMessage()];
            }
            set_transient(self::STATUS_TRANSIENT, $cached, isset($cached['unreachable']) ? MINUTE_IN_SECONDS : 5 * MINUTE_IN_SECONDS);
        }

        if (isset($cached['unreachable'])) {
            return ['kind' => 'unknown', 'text' => sprintf(
                /* translators: %s: connection error */
                __('Unknown. The gateway could not be reached (%s).', 'indak-gateway-connector'),
                rtrim((string) $cached['unreachable'], '.')
            )];
        }
        if (empty($cached['recognized'])) {
            return ['kind' => 'not-recognized', 'text' => $this->not_recognized_text($state)];
        }
        if (!empty($cached['last_error'])) {
            return ['kind' => 'failing', 'text' => sprintf(
                /* translators: %s: last error the gateway recorded */
                __('Connected, but the gateway\'s last call failed: %s', 'indak-gateway-connector'),
                (string) $cached['last_error']
            )];
        }
        $verified = !empty($cached['last_verified_at']) ? strtotime((string) $cached['last_verified_at']) : false;
        return $verified
            ? ['kind' => 'ok', 'text' => sprintf(
                /* translators: %s: human-readable time difference, e.g. "5 minutes" */
                __('Connected. Last verified %s ago', 'indak-gateway-connector'),
                human_time_diff($verified)
            ), 'time' => $verified]
            : ['kind' => 'ok', 'text' => __('Connected.', 'indak-gateway-connector')];
    }

    private function legacy_status_text(): string
    {
        return __('This connection was made with connector 0.1.0. It finishes upgrading the next time the gateway uses this site, after which it can be tested here. To upgrade it now, ask an Indak manager to choose Test for this site in the Site Manager.', 'indak-gateway-connector');
    }

    private function not_recognized_text(array $state): string
    {
        if ($this->address_changed($state)) {
            return sprintf(
                /* translators: 1: address the site was paired with, 2: current address */
                __('This site was paired as %1$s but its address is now %2$s, so the gateway no longer matches it. Ask an Indak manager to remove the old entry in the Site Manager, then choose Disconnect this site and connect again with a new pairing code.', 'indak-gateway-connector'),
                self::host((string) ($state['mcp_url'] ?? '')),
                self::host(home_url())
            );
        }
        return __('The gateway no longer recognizes this site; it was probably removed in the Site Manager. To reconnect, choose Disconnect this site, then connect again with a new pairing code.', 'indak-gateway-connector');
    }

    private function address_changed(array $state): bool
    {
        $paired = self::host((string) ($state['mcp_url'] ?? ''));
        return $paired !== '' && $paired !== self::host(home_url());
    }

    /** Host for comparison: lowercase and, for international domains, punycode (as the gateway stores it). */
    private static function host(string $url): string
    {
        $host = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        if ($host !== '' && function_exists('idn_to_ascii') && defined('INTL_IDNA_VARIANT_UTS46')) {
            $ascii = idn_to_ascii($host, IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46);
            if (is_string($ascii) && $ascii !== '') {
                $host = strtolower($ascii);
            }
        }
        return rtrim($host, '.');
    }

    private function clean_code($value): string
    {
        return substr(strtoupper((string) preg_replace('/[^A-Za-z0-9-]/', '', (string) $value)), 0, 64);
    }

    private function authorize(string $nonce_action): void
    {
        if (!current_user_can('manage_options')) {
            wp_die(
                esc_html__('You do not have permission to manage gateway pairing.', 'indak-gateway-connector'),
                esc_html__('Access denied', 'indak-gateway-connector'),
                ['response' => 403]
            );
        }
        check_admin_referer($nonce_action);
    }

    /** Notices travel in a per-user transient, so a crafted link cannot put text on this page. */
    private function redirect(string $type, string $message): void
    {
        set_transient(self::NOTICE_TRANSIENT . get_current_user_id(), ['type' => $type, 'message' => $message], 5 * MINUTE_IN_SECONDS);
        wp_safe_redirect(add_query_arg([
            'page'                 => self::PAGE,
            'indak_gateway_notice' => 1,
        ], admin_url('options-general.php')));
        exit;
    }
}
