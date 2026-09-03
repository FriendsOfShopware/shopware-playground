<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver\AbstractException;

final class MariadbLiteException extends AbstractException
{
    public static function fromEngine(string $message, int $errno = 0): self
    {
        return new self($message, null, $errno);
    }
}
