<?php declare(strict_types=1);

namespace Shopware\Core\Installer\Database;

use Doctrine\DBAL\Connection;
use Psr\Clock\ClockInterface;
use Shopware\Core\Defaults;
use Shopware\Core\Framework\Log\Package;
use Shopware\Core\Installer\Requirements\IniConfigReader;
use Shopware\Core\Maintenance\System\Service\SetupDatabaseAdapter;

/**
 * Playground override: small batches, skip WASM-hostile migrations, and
 * continue when a step throws instead of freezing the installer UI.
 *
 * @internal
 */
#[Package('framework')]
class DatabaseMigrator
{
    private const MAX_BATCH = 8;

    public function __construct(
        private readonly SetupDatabaseAdapter $adapter,
        private readonly MigrationCollectionFactory $migrationFactory,
        private readonly string $version,
        private readonly IniConfigReader $iniConfigReader,
        private readonly ClockInterface $clock
    ) {
    }

    /**
     * @return array{offset: int, total: int, isFinished: bool}
     */
    public function migrate(int $offset, Connection $connection): array
    {
        $migrationLoader = $this->migrationFactory->getMigrationCollectionLoader($connection);

        $coreMigrations = $migrationLoader->collectAllForVersion($this->version);

        if ($offset === 0) {
            $this->adapter->initializeShopwareDb($connection);

            $coreMigrations->sync();
        }

        $configuredMaxExecutionTime = (int) $this->iniConfigReader->get('max_execution_time');
        $maxExecutionTime = $configuredMaxExecutionTime <= 0 ? 7 : min($configuredMaxExecutionTime, 7);
        $startTime = (float) $this->clock->now()->format(Defaults::MICROTIME_FORMAT);
        $executedMigrations = $offset;
        $batch = 0;

        $stopped = false;
        while (true) {
            $skipped = $this->skipUnrunnable($connection, $coreMigrations);
            if ($skipped > 0) {
                $executedMigrations += $skipped;
                $batch += $skipped;
                if ($batch >= self::MAX_BATCH) {
                    $stopped = true;
                    break;
                }
            }

            $ran = $this->runOne($connection, $coreMigrations, false);
            if (!$ran) {
                break;
            }
            $runningSince = (float) $this->clock->now()->format(Defaults::MICROTIME_FORMAT) - $startTime;
            ++$executedMigrations;
            ++$batch;

            if ($batch >= self::MAX_BATCH || $runningSince + 5 > $maxExecutionTime || $executedMigrations === 1) {
                $stopped = true;
                break;
            }
        }

        while (!$stopped) {
            $skipped = $this->skipUnrunnable($connection, $coreMigrations, true);
            if ($skipped > 0) {
                $executedMigrations += $skipped;
                $batch += $skipped;
                if ($batch >= self::MAX_BATCH) {
                    break;
                }
            }

            $ran = $this->runOne($connection, $coreMigrations, true);
            if (!$ran) {
                break;
            }
            $runningSince = (float) $this->clock->now()->format(Defaults::MICROTIME_FORMAT) - $startTime;
            ++$executedMigrations;
            ++$batch;

            if ($batch >= self::MAX_BATCH || $runningSince + 5 > $maxExecutionTime) {
                break;
            }
        }

        $total = $coreMigrations->getTotalMigrationCount() * 2;

        return [
            'offset' => $executedMigrations,
            'total' => $total,
            'isFinished' => $coreMigrations->getExecutableMigrations() === []
                && $coreMigrations->getExecutableDestructiveMigrations() === [],
        ];
    }

    private function runOne(Connection $connection, object $coreMigrations, bool $destructive): bool
    {
        try {
            if ($destructive) {
                return iterator_count($coreMigrations->migrateDestructiveInSteps(null, 1)) === 1;
            }

            return iterator_count($coreMigrations->migrateInSteps(null, 1)) === 1;
        } catch (\Throwable $e) {
            $pending = $destructive
                ? $coreMigrations->getExecutableDestructiveMigrations(null, 1)
                : $coreMigrations->getExecutableMigrations(null, 1);
            if ($pending !== []) {
                $this->markSkipped($connection, $pending[0], 'failed: ' . $e->getMessage());
            }

            return true;
        }
    }

    private function skipUnrunnable(Connection $connection, object $coreMigrations, bool $destructive = false): int
    {
        $skipped = 0;
        while ($skipped < self::MAX_BATCH) {
            $pending = $destructive
                ? $coreMigrations->getExecutableDestructiveMigrations(null, 1)
                : $coreMigrations->getExecutableMigrations(null, 1);
            if ($pending === []) {
                return $skipped;
            }
            $class = $pending[0];
            if (\class_exists($class) && !self::shouldSkipClass($class)) {
                return $skipped;
            }
            $this->markSkipped($connection, $class, 'skipped: playground');
            ++$skipped;
        }

        return $skipped;
    }

    private function markSkipped(Connection $connection, string $class, string $message): void
    {
        $connection->executeStatement(
            'UPDATE `migration` SET `update` = NOW(6), `update_destructive` = NOW(6), `message` = :m WHERE `class` = :c',
            ['m' => substr($message, 0, 500), 'c' => $class]
        );
    }

    private static function shouldSkipClass(string $class): bool
    {
        // Node prepare-install runs the full set. Browser installer still
        // aborts PHP WASM on large HTML INSERTs, so skip those there.
        if (!\is_file('/internal/playground_skip_heavy_migrations')) {
            return false;
        }
        if (\str_starts_with($class, 'Shopware\\Administration\\')) {
            return true;
        }

        return (bool) preg_match(
            '/MailTemplate|MailTemplates|MailFooter|MailTranslation|UpdateMail|DownloadMail|MailImages|PasswordChangeMail|RegistrationMail|ReviewFormMail/',
            $class
        );
    }
}
