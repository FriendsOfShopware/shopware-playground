<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver\Statement;
use Doctrine\DBAL\ParameterType;

final class MariadbLiteStatement implements Statement
{
    /** @var array<int|string, mixed> */
    private array $params = [];
    /** @var array<int|string, ParameterType> */
    private array $types = [];

    public function __construct(private readonly string $sql)
    {
    }

    public function bindValue(int|string $param, mixed $value, ParameterType $type): void
    {
        $this->params[$param] = $value;
        $this->types[$param] = $type;
    }

    public function execute(): MariadbLiteResult
    {
        $sql = $this->sql;
        $values = array_values($this->params);
        $types = array_values($this->types);
        $i = 0;
        $sql = preg_replace_callback('/\?/', function () use (&$i, $values, $types) {
            $v = $values[$i] ?? null;
            $t = $types[$i] ?? null;
            $i++;
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
