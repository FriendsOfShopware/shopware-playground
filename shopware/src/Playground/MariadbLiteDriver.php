<?php declare(strict_types=1);

namespace App\Playground;

use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\API\ExceptionConverter;
use Doctrine\DBAL\Driver\API\MySQL\ExceptionConverter as MySQLExceptionConverter;
use Doctrine\DBAL\Driver\Connection;
use Doctrine\DBAL\Platforms\AbstractPlatform;
use Doctrine\DBAL\Platforms\MariaDB1010Platform;
use Doctrine\DBAL\Platforms\MariaDB1060Platform;
use Doctrine\DBAL\Platforms\MariaDB110700Platform;
use Doctrine\DBAL\Platforms\MariaDB120300Platform;
use Doctrine\DBAL\Platforms\MariaDBPlatform;
use Doctrine\DBAL\ServerVersionProvider;

final class MariadbLiteDriver implements Driver
{
    public function connect(array $params): Connection
    {
        $db = $params['dbname'] ?? $params['database'] ?? null;
        if (is_string($db) && $db !== '') {
            mariadblite_exec('CREATE DATABASE IF NOT EXISTS `' . str_replace('`', '', $db) . '`');
            mariadblite_exec('USE `' . str_replace('`', '', $db) . '`');
        }
        mariadblite_exec("SET @@session.time_zone = '+00:00'");
        mariadblite_exec('SET @@group_concat_max_len = CAST(IF(@@group_concat_max_len > 320000, @@group_concat_max_len, 320000) AS UNSIGNED)');
        mariadblite_exec("SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))");
        return new MariadbLiteConnection();
    }

    public function getDatabasePlatform(ServerVersionProvider $versionProvider): AbstractPlatform
    {
        $version = $versionProvider->getServerVersion();
        if (preg_match('/(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)/', $version, $m) === 1) {
            $v = $m['major'] . '.' . $m['minor'] . '.' . $m['patch'];
            if (version_compare($v, '12.3.0', '>=')) {
                return new MariaDB120300Platform();
            }
            if (version_compare($v, '11.7.0', '>=')) {
                return new MariaDB110700Platform();
            }
            if (version_compare($v, '10.10.0', '>=')) {
                return new MariaDB1010Platform();
            }
            if (version_compare($v, '10.6.0', '>=')) {
                return new MariaDB1060Platform();
            }
        }
        return new MariaDBPlatform();
    }

    public function getExceptionConverter(): ExceptionConverter
    {
        return new MySQLExceptionConverter();
    }
}
