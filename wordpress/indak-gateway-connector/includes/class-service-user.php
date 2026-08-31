<?php

if (!defined('ABSPATH')) {
    exit;
}

final class Indak_Gateway_Service_User
{
    private const USERNAME = 'indak-gateway-bot';

    public function ensure(): int
    {
        $existing = get_user_by('login', self::USERNAME);
        if ($existing instanceof WP_User) {
            if (!in_array('administrator', (array) $existing->roles, true)) {
                $existing->set_role('administrator');
            }
            return (int) $existing->ID;
        }

        $host = (string) wp_parse_url(home_url(), PHP_URL_HOST);
        $id = wp_insert_user([
            'user_login'   => self::USERNAME,
            'user_pass'    => wp_generate_password(64, true, true),
            'user_email'   => 'indak-gateway-bot@' . preg_replace('/^www\./', '', $host),
            'display_name' => 'Indak Gateway Bot',
            // Novamira abilities currently expect administrator capabilities. The credential
            // still cannot authenticate a browser login or unrelated REST route.
            'role'         => 'administrator',
        ]);
        if (is_wp_error($id)) {
            throw new RuntimeException($id->get_error_message());
        }
        return (int) $id;
    }

    public function id(): int
    {
        $user = get_user_by('login', self::USERNAME);
        return $user instanceof WP_User ? (int) $user->ID : 0;
    }

    public function username(): string
    {
        return self::USERNAME;
    }
}
