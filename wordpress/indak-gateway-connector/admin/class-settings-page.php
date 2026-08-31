<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Settings_Page
{
    private const PAGE = 'indak-gateway-connector';

    public function __construct(
        private Indak_Gateway_Credential_Store $store,
        private Indak_Gateway_Service_User $users,
        private Indak_Gateway_Pairing_Client $client
    ) {}

    public function register_hooks(): void
    {
        add_options_page(
            __('Indak Gateway', 'indak-gateway-connector'),
            __('Indak Gateway', 'indak-gateway-connector'),
            'manage_options',
            self::PAGE,
            [$this, 'render']
        );
        add_action('admin_post_indak_gateway_pair', [$this, 'pair']);
        add_action('admin_post_indak_gateway_disconnect', [$this, 'disconnect']);
    }

    public function pair(): void
    {
        $this->authorize('indak_gateway_pair');
        $gateway_url = esc_url_raw(wp_unslash($_POST['gateway_url'] ?? ''));
        $code = sanitize_text_field(wp_unslash($_POST['pairing_code'] ?? ''));
        if ($gateway_url === '' || $code === '') {
            $this->redirect('error', 'Gateway URL and pairing code are required.');
        }

        try {
            // Resolve the exact manager-approved MCP path first. This supports Novamira
            // versions and subdirectory builds without asking the WordPress admin to know it.
            $details = $this->client->details($gateway_url, $code);
            $credential = $this->store->generate();
            $this->store->store($credential);
            $this->store->save_state(['mcp_url' => esc_url_raw($details['mcp_url'])]);
            $this->users->ensure();
            $result = $this->client->claim($gateway_url, $code, $credential, (string) $details['mcp_url']);
            $this->store->save_state([
                'gateway_url' => untrailingslashit($gateway_url),
                'site_key'     => sanitize_key($result['site_key']),
                'label'        => sanitize_text_field($result['label']),
                'environment'  => $result['environment'] === 'live' ? 'live' : 'staging',
                'mcp_url'       => esc_url_raw($details['mcp_url']),
                'paired_at'    => gmdate('c'),
            ]);
            $this->redirect('success', 'This site is connected to the Indak Gateway.');
        } catch (Throwable $error) {
            // The gateway never received a usable persistent connection, so remove the local
            // digest. A new pairing code creates a completely new credential.
            $this->store->clear();
            $this->redirect('error', $error->getMessage());
        }
    }

    public function disconnect(): void
    {
        $this->authorize('indak_gateway_disconnect');
        $this->store->clear();
        $this->redirect('success', 'The local gateway credential was removed.');
    }

    public function render(): void
    {
        if (!current_user_can('manage_options')) {
            return;
        }
        $state = $this->store->state();
        $notice = sanitize_text_field(wp_unslash($_GET['indak_gateway_message'] ?? ''));
        $notice_type = ($_GET['indak_gateway_status'] ?? '') === 'error' ? 'error' : 'success';
        ?>
        <div class="wrap">
            <h1><?php esc_html_e('Indak Gateway Connector', 'indak-gateway-connector'); ?></h1>
            <p><?php esc_html_e('Pairs this Novamira installation with the Indak team gateway.', 'indak-gateway-connector'); ?></p>

            <?php if ($notice !== '') : ?>
                <div class="notice notice-<?php echo esc_attr($notice_type); ?> is-dismissible"><p><?php echo esc_html($notice); ?></p></div>
            <?php endif; ?>

            <?php if ($this->store->connected()) : ?>
                <h2><?php esc_html_e('Connected', 'indak-gateway-connector'); ?></h2>
                <table class="widefat striped" style="max-width: 760px">
                    <tbody>
                    <tr><th scope="row">Site key</th><td><?php echo esc_html($state['site_key'] ?? ''); ?></td></tr>
                    <tr><th scope="row">Label</th><td><?php echo esc_html($state['label'] ?? ''); ?></td></tr>
                    <tr><th scope="row">Environment</th><td><?php echo esc_html($state['environment'] ?? ''); ?></td></tr>
                    <tr><th scope="row">MCP endpoint</th><td><code><?php echo esc_html($state['mcp_url'] ?? ''); ?></code></td></tr>
                    </tbody>
                </table>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top: 1rem">
                    <input type="hidden" name="action" value="indak_gateway_disconnect">
                    <?php wp_nonce_field('indak_gateway_disconnect'); ?>
                    <?php submit_button(__('Disconnect this site', 'indak-gateway-connector'), 'delete'); ?>
                </form>
            <?php else : ?>
                <h2><?php esc_html_e('Connect this site', 'indak-gateway-connector'); ?></h2>
                <p>Generate a one-time code in the gateway Site Manager, then paste it here.</p>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="indak_gateway_pair">
                    <?php wp_nonce_field('indak_gateway_pair'); ?>
                    <table class="form-table" role="presentation">
                        <tr>
                            <th scope="row"><label for="gateway_url">Gateway URL</label></th>
                            <td><input class="regular-text" type="url" id="gateway_url" name="gateway_url" required value="https://darkseagreen-emu-833683.hostingersite.com"></td>
                        </tr>
                        <tr>
                            <th scope="row"><label for="pairing_code">Pairing code</label></th>
                            <td><input class="regular-text code" type="text" id="pairing_code" name="pairing_code" required autocomplete="off"></td>
                        </tr>
                    </table>
                    <?php submit_button(__('Connect to Indak Gateway', 'indak-gateway-connector')); ?>
                </form>
            <?php endif; ?>
        </div>
        <?php
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

    private function redirect(string $status, string $message): void
    {
        wp_safe_redirect(add_query_arg([
            'page'                  => self::PAGE,
            'indak_gateway_status' => $status,
            'indak_gateway_message'=> $message,
        ], admin_url('options-general.php')));
        exit;
    }
}
