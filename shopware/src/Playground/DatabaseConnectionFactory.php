<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Configuration;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Shopware\Core\Maintenance\System\Service\DatabaseConnectionFactory as BaseFactory;
use Shopware\Core\Maintenance\System\Struct\DatabaseConnectionInformation;

/**
 * Routes Shopware installer/setup DBAL connections through MariaDB WASM
 * instead of native pdo_mysql TCP.
 */
final class DatabaseConnectionFactory extends BaseFactory
{
    public function getConnection(DatabaseConnectionInformation $connectionInformation, bool $withoutDatabase = false): Connection
    {
        $params = $connectionInformation->toDBALParameters($withoutDatabase);
        $params['driverClass'] = MariadbLiteDriver::class;
        unset($params['driver']);
        return DriverManager::getConnection($params, new Configuration());
    }
}
