<?php

if (!defined('ABSPATH')) {
    exit;
}

/**
 * The account the gateway acts as. The plugin only ever uses an account it created itself,
 * identified by ID. Connector 0.1.0 looked the account up by its (public) login name and
 * promoted whatever it found, so on a site with open registration anyone could register
 * "indak-gateway-bot" first and be made an administrator by the next pairing.
 *
 * The ownership marker is a network option: on multisite the user is shared by every subsite,
 * and on a single site it is an ordinary option. It survives uninstall, so a reinstalled
 * connector still recognizes its own account.
 */
final class Indak_Gateway_Service_User
{
    private const USERNAME  = 'indak-gateway-bot';
    private const OPTION_ID = 'indak_gateway_connector_service_user_id';

    public function ensure(): int
    {
        $id = $this->id();
        if ($id > 0) {
            $user = get_userdata($id);
            if (!in_array('administrator', (array) $user->roles, true)) {
                // The role was removed while the plugin was inactive or uninstalled, when
                // nothing protected the account. Whoever might have reached it loses access
                // before it becomes an administrator again.
                $this->lock_down($id);
                $user->set_role('administrator');
            }
            return $id;
        }
        if (get_user_by('login', self::USERNAME) instanceof WP_User) {
            throw new RuntimeException(__(
                'A user named indak-gateway-bot already exists on this site, and the connector did not create it. For safety it will not be given administrator access. Delete that user in Users, then connect again.',
                'indak-gateway-connector'
            ));
        }

        $id = wp_insert_user([
            'user_login'   => self::USERNAME,
            'user_pass'    => wp_generate_password(64, true, true),
            'user_email'   => $this->email(),
            'display_name' => 'Indak Gateway Bot',
            // Novamira abilities currently expect administrator capabilities. The credential
            // still cannot authenticate a browser login or unrelated REST route.
            'role'         => 'administrator',
        ]);
        if (is_wp_error($id)) {
            throw new RuntimeException($id->get_error_message());
        }
        update_site_option(self::OPTION_ID, (int) $id);
        return (int) $id;
    }

    /** The service account's ID, or 0 if the connector has no account it can vouch for. */
    public function id(): int
    {
        $id = (int) get_site_option(self::OPTION_ID, 0);
        if ($id > 0) {
            $user = get_userdata($id);
            return $user instanceof WP_User && $user->user_login === self::USERNAME ? $id : 0;
        }
        return $this->adopt_legacy();
    }

    public function username(): string
    {
        return self::USERNAME;
    }

    /** Remove the account's role (keeping any content it authored) while the plugin is off. */
    public function demote(): void
    {
        $user = $this->owned_or_legacy_user();
        if ($user) {
            $user->set_role('');
        }
    }

    /** Give the account its role back when the plugin is reactivated on a paired site. */
    public function restore(): void
    {
        $id = $this->id();
        $user = $id > 0 ? get_userdata($id) : false;
        if ($user instanceof WP_User && !in_array('administrator', (array) $user->roles, true)) {
            $this->lock_down($id);
            $user->set_role('administrator');
        }
    }

    /**
     * The recorded account, or an administrator with the bot's login that 0.1.0 created before
     * accounts were recorded. Used where the account must be neutralized even if it was never
     * adopted.
     */
    private function owned_or_legacy_user(): ?WP_User
    {
        $id = (int) get_site_option(self::OPTION_ID, 0);
        $user = $id > 0 ? get_userdata($id) : get_user_by('login', self::USERNAME);
        if (!$user instanceof WP_User || $user->user_login !== self::USERNAME) {
            return null;
        }
        return $id > 0 || in_array('administrator', (array) $user->roles, true) ? $user : null;
    }

    /**
     * Connector 0.1.0 created the account without recording its ID, and its pairing made the
     * account an administrator. So an administrator with this login is taken to be that
     * account; anything else (for example a subscriber registered under this name) is never
     * adopted. Adoption locks the account down in case someone else had access to it.
     */
    private function adopt_legacy(): int
    {
        $user = get_user_by('login', self::USERNAME);
        if (!$user instanceof WP_User || !in_array('administrator', (array) $user->roles, true)) {
            return 0;
        }
        $id = (int) $user->ID;
        update_site_option(self::OPTION_ID, $id);
        $this->lock_down($id);
        return $id;
    }

    /** End any access someone else may have: password, sessions, application passwords, email. */
    private function lock_down(int $id): void
    {
        wp_set_password(wp_generate_password(64, true, true), $id);
        if (class_exists('WP_Session_Tokens')) {
            WP_Session_Tokens::get_instance($id)->destroy_all();
        }
        if (class_exists('WP_Application_Passwords')) {
            WP_Application_Passwords::delete_all_application_passwords($id);
        }
        $user = get_userdata($id);
        if ($user instanceof WP_User && strcasecmp($user->user_email, $this->email()) !== 0) {
            add_filter('send_email_change_email', '__return_false');
            wp_update_user(['ID' => $id, 'user_email' => $this->email()]);
            remove_filter('send_email_change_email', '__return_false');
        }
    }

    private function email(): string
    {
        $host = (string) wp_parse_url(home_url(), PHP_URL_HOST);
        return 'indak-gateway-bot@' . preg_replace('/^www\./', '', $host);
    }
}
