<?php declare(strict_types=1);

$root = dirname(__DIR__);

$copies = [
    'overrides/DatabaseConnectionFactory.php' => 'vendor/shopware/core/Maintenance/System/Service/DatabaseConnectionFactory.php',
    'overrides/EnvironmentRequirementsValidator.php' => 'vendor/shopware/core/Installer/Requirements/EnvironmentRequirementsValidator.php',
    'overrides/DatabaseImportController.php' => 'vendor/shopware/core/Installer/Controller/DatabaseImportController.php',
    'overrides/DatabaseMigrator.php' => 'vendor/shopware/core/Installer/Database/DatabaseMigrator.php',
    'overrides/MySQLFactory.php' => 'vendor/shopware/core/Framework/Adapter/Database/MySQLFactory.php',
];
foreach ($copies as $src => $dest) {
    $from = $root . '/' . $src;
    $to = $root . '/' . $dest;
    if (is_file($from) && is_dir(dirname($to))) {
        copy($from, $to);
    }
}

// Version-specific overrides: only replace files that exist in this tree
// (e.g. JwtCertificateGenerator exists on 6.6, was removed on 6.7;
// RequestTransformer is the 6.6 getBaseUrl() variant, 6.7 uses getBasePath()).
$replaceOnly = [
    'overrides/JwtCertificateGenerator.php' => 'vendor/shopware/core/Maintenance/System/Service/JwtCertificateGenerator.php',
    'overrides/RequestTransformer.php' => 'vendor/shopware/storefront/Framework/Routing/RequestTransformer.php',
];
foreach ($replaceOnly as $src => $dest) {
    $from = $root . '/' . $src;
    $to = $root . '/' . $dest;
    if (is_file($from) && is_file($to)) {
        copy($from, $to);
    }
}

// The front controller must load the SQL bridge (mariadblite_exec) before
// the kernel boots — inject the prepend require into public/index.php.
$index = $root . '/public/index.php';
if (is_file($index)) {
    $src = (string) file_get_contents($index);
    if (!str_contains($src, 'playground_prepend.php')) {
        $inject = "<?php declare(strict_types=1);\n\nif (\\is_file('/internal/playground_prepend.php')) {\n    require '/internal/playground_prepend.php';\n}\n";
        $patched = preg_replace('/^<\?php declare\(strict_types=1\);/', $inject, $src, 1);
        if (\is_string($patched) && $patched !== $src) {
            file_put_contents($index, $patched);
        }
    }
}

$varCloner = $root . '/vendor/symfony/var-dumper/Cloner/VarCloner.php';
if (is_file($varCloner)) {
    $src = (string) file_get_contents($varCloner);
    $patchedVar = str_replace(
        'new \\ReflectionClass($v)->isUserDefined()',
        '(new \\ReflectionClass($v))->isUserDefined()',
        $src
    );
    if ($patchedVar !== $src) {
        file_put_contents($varCloner, $patchedVar);
    }
}

$services = $root . '/vendor/shopware/core/Installer/DependencyInjection/services.xml';
if (is_file($services)) {
    $xml = (string) file_get_contents($services);
    $patched = preg_replace(
        '#<service id="Shopware\\\\Core\\\\Installer\\\\Requirements\\\\EnvironmentRequirementsValidator">.*?</service>#s',
        '<service id="Shopware\\Core\\Installer\\Requirements\\EnvironmentRequirementsValidator">' . "\n"
        . '            <tag name="shopware.installer.requirement"/>' . "\n"
        . '        </service>',
        $xml,
        1
    );
    if (\is_string($patched) && $patched !== $xml) {
        file_put_contents($services, $patched);
    }
}

// Composer shells out (git/hg/svn) during plugin lifecycle; proc_open fails
// in PHP WASM. Make every composer process call fail softly with exit code 1.
$processExecutor = $root . '/vendor/composer/composer/src/Composer/Util/ProcessExecutor.php';
if (is_file($processExecutor)) {
    $src = (string) file_get_contents($processExecutor);
    $needle = 'return $this->runProcess($command, $cwd, $env, $tty, $output);';
    if (!str_contains($src, 'playground') && str_contains($src, $needle)) {
        $replacement = <<<'PHP'
// playground: proc_open fails in PHP WASM — report failure, never throw
        try {
            return $this->runProcess($command, $cwd, $env, $tty, $output);
        } catch (\Throwable $e) {
            $this->errorOutput = $e->getMessage();
            $output = $e->getMessage();

            return 1;
        }
PHP;
        $patched = str_replace($needle, $replacement, $src);
        if ($patched !== $src) {
            file_put_contents($processExecutor, $patched);
        }
    }
}

// Composer probes `git --version` during plugin lifecycle (requirements
// validation); proc_open fails in PHP WASM and the exception must not escape.
$gitUtil = $root . '/vendor/composer/composer/src/Composer/Util/Git.php';
if (is_file($gitUtil)) {
    $src = (string) file_get_contents($gitUtil);
    if (!str_contains($src, 'playground')) {
        $patched = preg_replace(
            '/public static function getVersion\(ProcessExecutor \$process\): \?string\n    \{\n.*?\n    \}/s',
            <<<'PHP'
public static function getVersion(ProcessExecutor $process): ?string
    {
        if (false === self::$version) {
            self::$version = null;
            // playground: proc_open fails in PHP WASM — the git version
            // probe must fail softly instead of throwing
            try {
                if (0 === $process->execute(['git', '--version'], $output) && Preg::isMatch('/^git version (\d+(?:\.\d+)+)/m', $output, $matches)) {
                    self::$version = $matches[1];
                }
            } catch (\Throwable $e) {
                self::$version = null;
            }
        }

        return self::$version;
    }
PHP,
            $src,
            1
        );
        if (\is_string($patched) && $patched !== $src) {
            file_put_contents($gitUtil, $patched);
        }
    }
}
