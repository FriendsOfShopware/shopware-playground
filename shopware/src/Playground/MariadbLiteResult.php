<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver\Result;

final class MariadbLiteResult implements Result
{
    /** @var list<array<string, mixed>> */
    private array $rows;
    /** @var list<string> */
    private array $fields;
    private int $idx = 0;
    private int|string $affected;

    /**
     * @param list<array<string, mixed>> $rows
     * @param list<string> $fields
     */
    public function __construct(array $rows, int|string $affected = 0, array $fields = [])
    {
        $this->rows = [];
        foreach (array_values($rows) as $row) {
            $this->rows[] = self::decodeRow($row);
        }
        $this->affected = $affected;
        if ($fields === [] && $this->rows !== []) {
            $fields = array_map('strval', array_keys($this->rows[0]));
        }
        $this->fields = array_values($fields);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private static function decodeRow(array $row): array
    {
        foreach ($row as $key => $value) {
            if (\is_array($value) && isset($value['$h']) && \is_string($value['$h'])) {
                $bin = hex2bin($value['$h']);
                $row[$key] = $bin === false ? $value['$h'] : $bin;
            }
        }
        return $row;
    }

    public function fetchNumeric(): array|false
    {
        $row = $this->fetchAssociative();
        return $row === false ? false : array_values($row);
    }

    public function fetchAssociative(): array|false
    {
        if (!isset($this->rows[$this->idx])) {
            return false;
        }
        return $this->rows[$this->idx++];
    }

    public function fetchOne(): mixed
    {
        $row = $this->fetchNumeric();
        return $row === false ? false : ($row[0] ?? false);
    }

    public function fetchAllNumeric(): array
    {
        $all = [];
        foreach ($this->rows as $row) {
            $all[] = array_values($row);
        }
        $this->idx = count($this->rows);
        return $all;
    }

    public function fetchAllAssociative(): array
    {
        $this->idx = count($this->rows);
        return $this->rows;
    }

    public function fetchFirstColumn(): array
    {
        $col = [];
        foreach ($this->rows as $row) {
            $col[] = array_values($row)[0] ?? null;
        }
        $this->idx = count($this->rows);
        return $col;
    }

    public function rowCount(): int
    {
        return is_int($this->affected) ? $this->affected : (int) $this->affected;
    }

    public function columnCount(): int
    {
        return count($this->fields);
    }

    public function getColumnName(int $index): string
    {
        return $this->fields[$index] ?? (string) $index;
    }

    public function free(): void
    {
        $this->rows = [];
        $this->idx = 0;
    }
}
