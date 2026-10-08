<?php declare(strict_types=1);

namespace Shopware\Core\Installer\Requirements;

use Shopware\Core\Framework\Log\Package;
use Shopware\Core\Installer\Requirements\Struct\RequirementCheck;
use Shopware\Core\Installer\Requirements\Struct\RequirementsCheckCollection;
use Shopware\Core\Installer\Requirements\Struct\SystemCheck;

/**
 * Playground override: do not boot Composer (it shells out to git via proc_open,
 * which PHP WASM cannot spawn). Report the running PHP environment instead.
 *
 * @internal
 */
#[Package('framework')]
class EnvironmentRequirementsValidator implements RequirementsValidatorInterface
{
    public function validateRequirements(RequirementsCheckCollection $checks): RequirementsCheckCollection
    {
        $checks->add(new SystemCheck(
            'php',
            version_compare(\PHP_VERSION, '8.2.0', '>=') ? RequirementCheck::STATUS_SUCCESS : RequirementCheck::STATUS_ERROR,
            '>= 8.2',
            \PHP_VERSION
        ));

        foreach (['json', 'mbstring', 'pdo', 'zip', 'xml'] as $ext) {
            $loaded = \extension_loaded($ext);
            $checks->add(new SystemCheck(
                $ext,
                $loaded ? RequirementCheck::STATUS_SUCCESS : RequirementCheck::STATUS_ERROR,
                'installed',
                $loaded ? 'installed' : 'missing'
            ));
        }

        return $checks;
    }
}
