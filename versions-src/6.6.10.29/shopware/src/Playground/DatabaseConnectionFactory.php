<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Connection;
use Shopware\Core\Maintenance\System\Service\DatabaseConnectionFactory as BaseFactory;
use Shopware\Core\Maintenance\System\Struct\DatabaseConnectionInformation;

/**
 * Routes Shopware installer/setup DBAL connections through MariaDB WASM.
 * On 6.6 the vendor override (overrides/DatabaseConnectionFactory.php)
 * already does the DSN → driverClass rewrite; delegate to it.
 */
final class DatabaseConnectionFactory extends BaseFactory
{
    public function getConnection(DatabaseConnectionInformation $connectionInformation, bool $withoutDatabase = false): Connection
    {
        return BaseFactory::createConnection($connectionInformation, $withoutDatabase);
    }
}
