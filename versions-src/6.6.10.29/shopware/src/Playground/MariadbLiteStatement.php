<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver\Result;
use Doctrine\DBAL\Driver\Statement;
use Doctrine\DBAL\ParameterType;

/**
 * DBAL 3 flavour (Shopware 6.6): client-side parameter interpolation, the
 * engine has no prepared statements over the JS bridge.
 */
final class MariadbLiteStatement implements Statement
{
    /** @var array<int|string, mixed> */
    private array $params = [];

    /** @var array<int|string, int> */
    private array $types = [];

    public function __construct(private readonly string $sql)
    {
    }

    /**
     * @param int|string $param
     * @param mixed $value
     * @param int $type
     */
    public function bindValue($param, $value, $type = ParameterType::STRING): bool
    {
        $this->params[$param] = $value;
        $this->types[$param] = (int) $type;

        return true;
    }

    /**
     * @param int|string $param
     * @param mixed $variable
     * @param int $type
     * @param int|null $length
     */
    public function bindParam($param, &$variable, $type = ParameterType::STRING, $length = null): bool
    {
        return $this->bindValue($param, $variable, $type);
    }

    /**
     * @param array<int|string, mixed>|null $params
     */
    public function execute($params = null): Result
    {
        if (\is_array($params)) {
            foreach ($params as $key => $value) {
                $this->bindValue(\is_int($key) ? $key + 1 : $key, $value);
            }
        }

        $sql = $this->sql;
        $values = array_values($this->params);
        $types = array_values($this->types);
        $i = 0;
        $sql = preg_replace_callback('/\?/', function () use (&$i, $values, $types) {
            $v = $values[$i] ?? null;
            $t = $types[$i] ?? null;
            ++$i;

            return MariadbLiteConnection::quoteValue($v, $t);
        }, $sql) ?? $sql;

        foreach ($this->params as $name => $value) {
            if (!\is_string($name)) {
                continue;
            }
            $placeholder = str_starts_with($name, ':') ? $name : ':' . $name;
            $sql = str_replace(
                $placeholder,
                MariadbLiteConnection::quoteValue($value, $this->types[$name] ?? null),
                $sql
            );
        }

        // PDO/MySQL prepared statements do not run a multi-query script.
        // Some Shopware migrations pass several statements to prepare(); only
        // the first is executed, matching native pdo_mysql.
        $statements = MariadbLiteConnection::splitStatements($sql);
        $res = MariadbLiteConnection::execAll($statements[0] ?? $sql);

        return new MariadbLiteResult($res['rows'] ?? [], $res['affected'] ?? 0, $res['fields'] ?? []);
    }
}
