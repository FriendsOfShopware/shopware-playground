<?php declare(strict_types=1);

namespace Shopware\Core\Maintenance\System\Service;

use Doctrine\DBAL\Configuration;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Tools\DsnParser;
use Shopware\Core\Framework\Log\Package;
use Shopware\Core\Maintenance\MaintenanceException;
use Shopware\Core\Maintenance\System\Struct\DatabaseConnectionInformation;

/**
 * Playground override: route installer/setup DBAL through MariaDB WASM
 * when mariadblite_exec() is available (PHP WASM + JS SQL bridge).
 *
 * @internal
 */
#[Package('framework')]
class DatabaseConnectionFactory
{
    public function getConnection(DatabaseConnectionInformation $connectionInformation, bool $withoutDatabase = false): Connection
    {
        return self::createConnection($connectionInformation, $withoutDatabase);
    }

    public static function createConnection(DatabaseConnectionInformation $connectionInformation, bool $withoutDatabase = false): Connection
    {
        $params = $connectionInformation->toDBALParameters($withoutDatabase);
        if (\function_exists('mariadblite_exec')) {
            // Shopware 6.6 passes a DSN 'url'; DBAL 3 lets the url scheme win
            // over driverClass, so parse it into discrete params first.
            if (isset($params['url'])) {
                $dsn = (new DsnParser(['mysql' => 'pdo_mysql']))->parse((string) $params['url']);
                unset($dsn['driver']);
                $params = array_merge($dsn, $params);
                unset($params['url']);
            }
            $params['driverClass'] = \App\Playground\MariadbLiteDriver::class;
            unset($params['driver'], $params['driverOptions']);
        }
        $connection = DriverManager::getConnection($params, new Configuration());

        self::checkVersion($connection);

        return $connection;
    }

    private static function checkVersion(Connection $connection): void
    {
        $mysqlRequiredVersion = '8.0.22';
        $mariaDBRequiredVersion = '10.11';

        $version = $connection->fetchOne('SELECT VERSION()');
        if (!\is_string($version)) {
            throw MaintenanceException::dbVersionSelectFailed();
        }
        if (\mb_stripos($version, 'mariadb') !== false) {
            if (version_compare($version, $mariaDBRequiredVersion, '<')) {
                throw MaintenanceException::dbVersionMismatch('MariaDB', $version, $mysqlRequiredVersion, $mariaDBRequiredVersion);
            }

            return;
        }

        if (version_compare($version, $mysqlRequiredVersion, '<')) {
            throw MaintenanceException::dbVersionMismatch('MySQL', $version, $mysqlRequiredVersion, $mariaDBRequiredVersion);
        }
    }
}
