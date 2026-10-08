<?php declare(strict_types=1);

namespace Shopware\Core\Framework\Adapter\Database;

use Doctrine\DBAL\Configuration;
use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Connections\PrimaryReadReplicaConnection;
use Doctrine\DBAL\Driver\Middleware;
use Doctrine\DBAL\DriverManager;
use Doctrine\DBAL\Tools\DsnParser;
use Shopware\Core\DevOps\Environment\EnvironmentHelper;
use Shopware\Core\Framework\Log\Package;

/**
 * Playground override: the full Shopware kernel builds its Doctrine
 * connection here. Route it through MariaDB WASM instead of pdo_mysql TCP.
 *
 * @phpstan-import-type Params from DriverManager
 *
 * @internal
 */
#[Package('framework')]
class MySQLFactory
{
    public const PLACEHOLDER_DATABASE_URL = 'mysql://_placeholder.test';

    /**
     * Returns true, when bin/ci is used and Shopware is called in a CI/CD environment where the Database is not available to warmup caches
     */
    public static function hasNoDatabaseAvailable(): bool
    {
        return (string) EnvironmentHelper::getVariable('DATABASE_URL', '') === self::PLACEHOLDER_DATABASE_URL;
    }

    /**
     * @param array<Middleware> $middlewares
     */
    public static function create(array $middlewares = []): Connection
    {
        $config = (new Configuration())
            ->setMiddlewares($middlewares);

        $url = (string) EnvironmentHelper::getVariable('DATABASE_URL', getenv('DATABASE_URL'));
        if ($url === '') {
            $url = 'mysql://root:root@localhost/shopware';
        }

        $dsnParser = new DsnParser(['mysql' => 'pdo_mysql']);
        $dsnParameters = $dsnParser->parse($url);

        $parameters = array_merge([
            'charset' => 'utf8mb4',
            'driver' => 'pdo_mysql',
        ], $dsnParameters);

        if (\function_exists('mariadblite_exec')) {
            $parameters['driverClass'] = \App\Playground\MariadbLiteDriver::class;
            unset($parameters['driver'], $parameters['driverOptions']);
        }

        $replicaUrl = (string) EnvironmentHelper::getVariable('DATABASE_REPLICA_0_URL');
        if ($replicaUrl !== '' && !isset($parameters['wrapperClass'])) {
            $parameters['wrapperClass'] = PrimaryReadReplicaConnection::class;
        }

        return DriverManager::getConnection($parameters, $config);
    }
}
