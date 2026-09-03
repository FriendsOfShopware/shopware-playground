<?php declare(strict_types=1);

if (\is_file('/internal/playground_prepend.php')) {
    require '/internal/playground_prepend.php';
}

use Shopware\Core\DevOps\Environment\EnvironmentHelper;
use Shopware\Core\Framework\Plugin\KernelPluginLoader\ComposerPluginLoader;
use Shopware\Core\Installer\Helper\InstallerRedirectHelper;
use Shopware\Core\Installer\InstallerKernel;
use Shopware\Core\Framework\Adapter\Kernel\KernelFactory;

$_SERVER['SCRIPT_FILENAME'] = __FILE__;

require_once __DIR__ . '/../vendor/autoload_runtime.php';

if (!file_exists(__DIR__ . '/../.env') && !file_exists(__DIR__ . '/../.env.dist') && !file_exists(__DIR__ . '/../.env.local.php')) {
    $_SERVER['APP_RUNTIME_OPTIONS']['disable_dotenv'] = true;
}

return function (array $context) {
    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    if (preg_match('#^/index\.php(/.*)?(\\?.*)?$#', $uri, $m) === 1) {
        $_SERVER['REQUEST_URI'] = ($m[1] ?? '') !== '' ? $m[1] : '/' . ($m[2] ?? '');
        if ($_SERVER['REQUEST_URI'] === '') {
            $_SERVER['REQUEST_URI'] = '/';
        }
    }
    if (($_SERVER['PATH_INFO'] ?? '') === '/index.php') {
        $_SERVER['PATH_INFO'] = '/';
    }

    $host = (string) ($_SERVER['HTTP_HOST'] ?? '127.0.0.1');
    if (preg_match('/:(\d+)$/', $host, $portMatch) === 1) {
        $_SERVER['SERVER_PORT'] = $portMatch[1];
    }
    $https = (string) ($_SERVER['HTTPS'] ?? '');
    $scheme = ($https !== '' && $https !== 'off') ? 'https' : 'http';
    $appUrl = $scheme . '://' . $host;
    $_SERVER['APP_URL'] = $appUrl;
    $_ENV['APP_URL'] = $appUrl;
    putenv('APP_URL=' . $appUrl);
    $context['APP_URL'] = $appUrl;

    $classLoader = require __DIR__ . '/../vendor/autoload.php';

    if (!EnvironmentHelper::getVariable('SHOPWARE_SKIP_WEBINSTALLER', false) && !file_exists(dirname(__DIR__) . '/install.lock')) {
        $baseURL = str_replace(basename(__FILE__), '', $_SERVER['SCRIPT_NAME']);
        $baseURL = rtrim($baseURL, '/');

        if (strpos($_SERVER['REQUEST_URI'], '/installer') === false) {
            // InstallerRedirectHelper was introduced in 6.7.5.0; older 6.7 patch releases
            // ship no such class, so forward the sanitised query only when it is available.
            $query = match (true) {
                class_exists(InstallerRedirectHelper::class) => (new InstallerRedirectHelper($_SERVER))->buildQueryString(),
                default => '',
            };

            header('Location: ' . $baseURL . '/installer' . $query);
            exit;
        }
    }

    $appEnv = $context['APP_ENV'] ?? 'dev';
    $debug = (bool) ($context['APP_DEBUG'] ?? ($appEnv !== 'prod'));

    if (!EnvironmentHelper::getVariable('SHOPWARE_SKIP_WEBINSTALLER', false) && !file_exists(dirname(__DIR__) . '/install.lock')) {
        return new InstallerKernel($appEnv, $debug);
    }

    $pluginLoader = null;

    if (EnvironmentHelper::getVariable('COMPOSER_PLUGIN_LOADER', false)) {
        $pluginLoader = new ComposerPluginLoader($classLoader, null);
    }

    return KernelFactory::create(
        environment: $appEnv,
        debug: $debug,
        classLoader: $classLoader,
        pluginLoader: $pluginLoader,
    );
};
