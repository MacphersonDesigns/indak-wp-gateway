<?php
/**
 * Indak WP Gateway - one-shot site bootstrap.
 *
 * Creates the novamira-bot admin user, generates its Application Password, and
 * prints the two lines you paste into the gateway's environment variables.
 * Replaces the whole "create user, find the app password screen, copy the 24
 * characters without the spaces" dance.
 *
 * HOW TO RUN (pick whichever you have on that site):
 *
 *   A) WP-CLI:      wp eval-file bootstrap-site.php
 *   B) Novamira:    paste the contents into novamira/execute-php
 *   C) WPCode Lite: new snippet, PHP, "Run Once", paste, Save & Activate,
 *                   read the output, then DELETE the snippet
 *
 * Safe to run twice: an existing novamira-bot is reused, and each run issues a
 * fresh application password named "wp-gateway" after revoking any old one.
 */

if (!defined('ABSPATH')) {
    fwrite(STDERR, "Run this inside WordPress (wp eval-file, Novamira, or WPCode).\n");
    exit(1);
}

$out = [];
$line = function ($s = '') use (&$out) { $out[] = $s; };

$username = 'novamira-bot';
$label    = 'wp-gateway';

// --- 1. the bot user -------------------------------------------------------
$user = get_user_by('login', $username);
if (!$user) {
    $email = 'novamira-bot@' . preg_replace('/^www\./', '', parse_url(home_url(), PHP_URL_HOST));
    $id = wp_insert_user([
        'user_login'   => $username,
        'user_pass'    => wp_generate_password(32, true, true),
        'user_email'   => $email,
        'display_name' => 'Novamira Bot',
        'role'         => 'administrator',
    ]);
    if (is_wp_error($id)) {
        $line('FAILED to create ' . $username . ': ' . $id->get_error_message());
        echo implode("\n", $out) . "\n";
        return implode("\n", $out);
    }
    $user = get_user_by('id', $id);
    $line('Created user ' . $username . ' (id ' . $id . ') as administrator.');
} else {
    if (!in_array('administrator', (array) $user->roles, true)) {
        $user->add_role('administrator');
        $line('Existing user ' . $username . ' promoted to administrator.');
    } else {
        $line('Reusing existing admin user ' . $username . ' (id ' . $user->ID . ').');
    }
}

// --- 2. the application password ------------------------------------------
if (!class_exists('WP_Application_Passwords')) {
    $line('This WordPress does not have Application Passwords available.');
    $line('They require WordPress 5.6+ over HTTPS. Check the site is served over https.');
    echo implode("\n", $out) . "\n";
    return implode("\n", $out);
}

foreach (WP_Application_Passwords::get_user_application_passwords($user->ID) as $existing) {
    if (isset($existing['name']) && $existing['name'] === $label) {
        WP_Application_Passwords::delete_application_password($user->ID, $existing['uuid']);
        $line('Revoked the previous "' . $label . '" application password.');
    }
}

$created = WP_Application_Passwords::create_new_application_password($user->ID, ['name' => $label]);
if (is_wp_error($created)) {
    $line('FAILED to create an application password: ' . $created->get_error_message());
    echo implode("\n", $out) . "\n";
    return implode("\n", $out);
}
$password = $created[0];

// --- 3. work out the site key and env -------------------------------------
$host = strtolower(preg_replace('/^www\./', '', parse_url(home_url(), PHP_URL_HOST)));
$parts = array_values(array_filter(explode('.', $host), function ($p) {
    return !in_array($p, ['staging', 'stage', 'dev', 'test', 'www'], true);
}));
$key = preg_replace('/[^a-z0-9-]/', '', count($parts) > 1 ? $parts[count($parts) - 2] : ($parts[0] ?? $host));
$isStaging = (bool) preg_match('/(^|[.\/-])(staging|stage|dev|test)([.\/-]|$)|hostingersite\.com$/i', $host);
$env = $isStaging ? 'staging' : 'live';
$secretVar = 'WP_PW_' . strtoupper(str_replace('-', '_', $key));

// --- 4. sanity checks worth knowing about now, not at 11pm ----------------
$warnings = [];
if (!is_ssl() && strpos(home_url(), 'https://') !== 0) {
    $warnings[] = 'This site is not HTTPS. The gateway will refuse it.';
}
$activePlugins = (array) get_option('active_plugins', []);
if (is_multisite()) {
    $activePlugins = array_merge($activePlugins, array_keys((array) get_site_option('active_sitewide_plugins', [])));
}
$novamiraActive = false;
foreach ($activePlugins as $plugin) {
    if (stripos((string) $plugin, 'novamira') !== false) { $novamiraActive = true; break; }
}
if (!$novamiraActive) {
    $warnings[] = 'Novamira does not look active here. Install/activate it and tick "Enable AI Abilities".';
}
$mcpPath = '/wp-json/mcp-adapter/mcp';

// --- 5. the bit you copy --------------------------------------------------
$line('');
$line('=================================================================');
$line('ADD THESE TO THE GATEWAY ENVIRONMENT VARIABLES');
$line('=================================================================');
$line('');
$line('1) Append this line to SITES:');
$line('');
$line('   ' . $key . ' | ' . get_bloginfo('name') . ($isStaging ? ' (staging)' : '') . ' | ' . home_url() . ' | ' . $env);
$line('');
$line('2) Add this variable:');
$line('');
$line('   ' . $secretVar . ' = ' . $password);
$line('');
$line('=================================================================');
$line('Then redeploy the gateway and check its domain root shows the new count.');
$line('MCP endpoint on this site: ' . home_url($mcpPath));
if ($warnings) {
    $line('');
    $line('WARNINGS:');
    foreach ($warnings as $w) { $line('  - ' . $w); }
}
$line('');
$line('This password is shown once. If you lose it, run this again.');
$line('Delete the snippet/file now that you have it.');

$text = implode("\n", $out);
echo $text . "\n";
return $text;
