<?php
/**
 * JS-bridged SQL for this tree's MariaDB WASM (post_message_to_js).
 * Native pdo_mysql is compiled in but cannot reach an in-process WASM engine.
 */
@ini_set('memory_limit', '512M');
@ini_set('max_execution_time', '0');
$_SERVER['PROJECT_ROOT'] = '/shopware';
$_ENV['PROJECT_ROOT'] = '/shopware';
putenv('PROJECT_ROOT=/shopware');

if (!function_exists('mariadblite_rpc')) {
    function mariadblite_rpc(array $payload): array
    {
        if (!function_exists('post_message_to_js')) {
            throw new RuntimeException('post_message_to_js is not available');
        }
        $sqlForError = isset($payload['sql']) && \is_string($payload['sql']) ? $payload['sql'] : '';
        if ($sqlForError !== '') {
            $payload['sql_b64'] = base64_encode($sqlForError);
            unset($payload['sql']);
        }
        try {
            $json = json_encode($payload, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        } catch (\JsonException $e) {
            throw new RuntimeException('SQL RPC encode failed: ' . $e->getMessage(), 0, $e);
        }
        $raw = post_message_to_js($json);
        try {
            $decoded = json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new RuntimeException(
                'SQL RPC decode failed: ' . $e->getMessage()
                . ' raw_len=' . \strlen((string) $raw)
                . ' raw_head=' . bin2hex(substr((string) $raw, 0, 64)),
                0,
                $e
            );
        }
        if (empty($decoded['ok'])) {
            $err = (string) ($decoded['error'] ?? 'MariaDB WASM query failed');
            if ($sqlForError !== '') {
                $err .= ' | sql=' . substr($sqlForError, 0, 500);
            }
            $sqlState = isset($decoded['sqlstate']) ? (string) $decoded['sqlstate'] : 'HY000';
            $errno = (int) ($decoded['errno'] ?? 0);
            if (\in_array($errno, [1051, 1054, 1060, 1061, 1072, 1091, 1146], true)) {
                $sqlState = '42000';
            }
            throw new \App\Playground\MariadbLiteException(
                \sprintf('SQLSTATE[%s]: %s', $sqlState, $err),
                $sqlState,
                $errno
            );
        }
        return $decoded;
    }

    function mariadblite_query(string $sql): array
    {
        $res = mariadblite_rpc(['op' => 'query', 'sql' => $sql]);
        return $res['rows'] ?? [];
    }

    function mariadblite_exec(string $sql): array
    {
        return mariadblite_rpc(['op' => 'query', 'sql' => $sql]);
    }
}
