<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\API\ExceptionConverter;
use Doctrine\DBAL\Driver\API\MySQL\ExceptionConverter as MySQLExceptionConverter;
use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Platforms\AbstractPlatform;
use Doctrine\DBAL\Platforms\MariaDb1010Platform;
use Doctrine\DBAL\Platforms\MariaDb1027Platform;
use Doctrine\DBAL\Platforms\MariaDb1043Platform;
use Doctrine\DBAL\Platforms\MariaDb1052Platform;
use Doctrine\DBAL\Platforms\MariaDb1060Platform;
use Doctrine\DBAL\Platforms\MariaDb110700Platform;
use Doctrine\DBAL\Platforms\MariaDb120300Platform;
use Doctrine\DBAL\Platforms\MariaDBPlatform;
use Doctrine\DBAL\Schema\MySQLSchemaManager;
use Doctrine\DBAL\VersionAwarePlatformDriver;

/**
 * DBAL 3 flavour (Shopware 6.6) of the MariaDB WASM driver. The 6.7 tree
 * carries the DBAL 4 variant in shopware/src/Playground.
 */
final class MariadbLiteDriver implements Driver, VersionAwarePlatformDriver
{
    /**
     * @param array<string, mixed> $params
     */
    public function connect(array $params): DriverConnection
    {
        $db = $params['dbname'] ?? $params['database'] ?? null;
        if (\is_string($db) && $db !== '') {
            mariadblite_exec('CREATE DATABASE IF NOT EXISTS `' . str_replace('`', '', $db) . '`');
            mariadblite_exec('USE `' . str_replace('`', '', $db) . '`');
        }
        mariadblite_exec("SET @@session.time_zone = '+00:00'");
        mariadblite_exec('SET @@group_concat_max_len = CAST(IF(@@group_concat_max_len > 320000, @@group_concat_max_len, 320000) AS UNSIGNED)');
        mariadblite_exec("SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))");

        return new MariadbLiteConnection();
    }

    public function getDatabasePlatform(): AbstractPlatform
    {
        return new MariaDBPlatform();
    }

    /**
     * @param string $version
     */
    public function createDatabasePlatformForVersion($version): AbstractPlatform
    {
        // "5.5.5-10.11.6-MariaDB" → "10.11.6"
        $normalized = (string) preg_replace('/^5\.5\.5-/', '', (string) $version);
        if (preg_match('/^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)/', $normalized, $m) !== 1) {
            return new MariaDBPlatform();
        }
        $v = $m['major'] . '.' . $m['minor'] . '.' . $m['patch'];
        if (version_compare($v, '12.3.0', '>=')) {
            return new MariaDb120300Platform();
        }
        if (version_compare($v, '11.7.0', '>=')) {
            return new MariaDb110700Platform();
        }
        if (version_compare($v, '10.10.0', '>=')) {
            return new MariaDb1010Platform();
        }
        if (version_compare($v, '10.6.0', '>=')) {
            return new MariaDb1060Platform();
        }
        if (version_compare($v, '10.5.2', '>=')) {
            return new MariaDb1052Platform();
        }
        if (version_compare($v, '10.4.3', '>=')) {
            return new MariaDb1043Platform();
        }
        if (version_compare($v, '10.2.7', '>=')) {
            return new MariaDb1027Platform();
        }

        return new MariaDBPlatform();
    }

    public function getSchemaManager(Connection $conn, AbstractPlatform $platform): MySQLSchemaManager
    {
        return new MySQLSchemaManager($conn, $platform);
    }

    public function getExceptionConverter(): ExceptionConverter
    {
        return new MySQLExceptionConverter();
    }
}
