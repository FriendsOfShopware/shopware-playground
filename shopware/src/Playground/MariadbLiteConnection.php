<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver\Connection;
use Doctrine\DBAL\Driver\Result;
use Doctrine\DBAL\Driver\Statement;

final class MariadbLiteConnection implements Connection
{
    public function prepare(string $sql): Statement
    {
        return new MariadbLiteStatement($sql);
    }

    public function query(string $sql): Result
    {
        $res = self::execAll($sql);
        return new MariadbLiteResult($res['rows'] ?? [], $res['affected'] ?? 0, $res['fields'] ?? []);
    }

    public function quote(string $value): string
    {
        return self::quoteValue($value);
    }

    public static function quoteValue(mixed $value, ?\Doctrine\DBAL\ParameterType $type = null): string
    {
        if ($value === null) {
            return 'NULL';
        }
        if (is_bool($value)) {
            return $value ? '1' : '0';
        }
        if (is_int($value) || is_float($value)) {
            return (string) $value;
        }
        $s = (string) $value;
        $binary = $type === \Doctrine\DBAL\ParameterType::BINARY
            || $type === \Doctrine\DBAL\ParameterType::LARGE_OBJECT
            || str_contains($s, "\0")
            || \strlen($s) === 16
            || (\function_exists('mb_check_encoding') && !\mb_check_encoding($s, 'UTF-8'));
        if ($binary) {
            return "UNHEX('" . bin2hex($s) . "')";
        }
        $s = str_replace(['\\', "\0", "\n", "\r", "'", '"', "\x1a"], ['\\\\', '\\0', '\\n', '\\r', "\\'", '\\"', '\\Z'], $s);
        return "'" . $s . "'";
    }

    public function exec(string $sql): int|string
    {
        $res = self::execAll($sql);
        return $res['affected'] ?? 0;
    }

    /**
     * libmariadbd mysql_query() runs a single statement. Shopware schema.sql
     * and some migrations send several at once.
     *
     * @return array{ok?: bool, rows?: list<array<string, mixed>>, affected?: int|string}
     */
    public static function execAll(string $sql): array
    {
        $last = ['ok' => true, 'rows' => [], 'affected' => 0];
        foreach (self::splitStatements($sql) as $statement) {
            $last = mariadblite_exec($statement);
        }
        return $last;
    }

    /**
     * @return list<string>
     */
    public static function splitStatements(string $sql): array
    {
        $sql = trim($sql);
        if ($sql === '') {
            return [];
        }

        $out = [];
        $buf = '';
        $len = \strlen($sql);
        $state = 'code';
        $beginDepth = 0;
        for ($i = 0; $i < $len; ++$i) {
            $c = $sql[$i];
            $n = $i + 1 < $len ? $sql[$i + 1] : '';

            if ($state === 'linecomment') {
                $buf .= $c;
                if ($c === "\n") {
                    $state = 'code';
                }
                continue;
            }
            if ($state === 'blockcomment') {
                $buf .= $c;
                if ($c === '*' && $n === '/') {
                    $buf .= $n;
                    ++$i;
                    $state = 'code';
                }
                continue;
            }
            if ($state === 'sq') {
                $buf .= $c;
                if ($c === '\\' && $n !== '') {
                    $buf .= $n;
                    ++$i;
                    continue;
                }
                if ($c === "'" && $n === "'") {
                    $buf .= $n;
                    ++$i;
                    continue;
                }
                if ($c === "'") {
                    $state = 'code';
                }
                continue;
            }
            if ($state === 'dq') {
                $buf .= $c;
                if ($c === '\\' && $n !== '') {
                    $buf .= $n;
                    ++$i;
                    continue;
                }
                if ($c === '"' && $n === '"') {
                    $buf .= $n;
                    ++$i;
                    continue;
                }
                if ($c === '"') {
                    $state = 'code';
                }
                continue;
            }
            if ($state === 'bt') {
                $buf .= $c;
                if ($c === '`') {
                    $state = 'code';
                }
                continue;
            }

            if ($c === '-' && $n === '-') {
                $state = 'linecomment';
                $buf .= $c;
                continue;
            }
            if ($c === '/' && $n === '*') {
                $state = 'blockcomment';
                $buf .= $c;
                continue;
            }
            if ($c === "'") {
                $state = 'sq';
                $buf .= $c;
                continue;
            }
            if ($c === '"') {
                $state = 'dq';
                $buf .= $c;
                continue;
            }
            if ($c === '`') {
                $state = 'bt';
                $buf .= $c;
                continue;
            }
            if (ctype_alpha($c) || $c === '_') {
                $j = $i;
                $word = '';
                while ($j < $len && (ctype_alnum($sql[$j]) || $sql[$j] === '_')) {
                    $word .= $sql[$j];
                    ++$j;
                }
                $upper = strtoupper($word);
                if ($upper === 'BEGIN') {
                    ++$beginDepth;
                } elseif ($upper === 'END') {
                    $k = $j;
                    while ($k < $len && ctype_space($sql[$k])) {
                        ++$k;
                    }
                    $next = '';
                    $m = $k;
                    while ($m < $len && (ctype_alnum($sql[$m]) || $sql[$m] === '_')) {
                        $next .= $sql[$m];
                        ++$m;
                    }
                    $nextU = strtoupper($next);
                    if (!\in_array($nextU, ['IF', 'WHILE', 'CASE', 'LOOP', 'REPEAT'], true)) {
                        $beginDepth = max(0, $beginDepth - 1);
                    }
                }
                $buf .= $word;
                $i = $j - 1;
                continue;
            }
            if ($c === ';') {
                if ($beginDepth > 0) {
                    $buf .= $c;
                    continue;
                }
                $stmt = trim($buf);
                if ($stmt !== '') {
                    $out[] = $stmt;
                }
                $buf = '';
                continue;
            }
            $buf .= $c;
        }

        $stmt = trim($buf);
        if ($stmt !== '') {
            $out[] = $stmt;
        }
        return $out;
    }

    public function lastInsertId(): int|string
    {
        $rows = mariadblite_query('SELECT LAST_INSERT_ID() AS id');
        return $rows[0]['id'] ?? 0;
    }

    public function beginTransaction(): void
    {
        mariadblite_exec('BEGIN');
    }

    public function commit(): void
    {
        mariadblite_exec('COMMIT');
    }

    public function rollBack(): void
    {
        mariadblite_exec('ROLLBACK');
    }

    public function getNativeConnection(): object
    {
        return $this;
    }

    public function getServerVersion(): string
    {
        $rows = mariadblite_query('SELECT VERSION() AS v');
        return (string) ($rows[0]['v'] ?? '10.11.0-MariaDB-wasm');
    }
}
