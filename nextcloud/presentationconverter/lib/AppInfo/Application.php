<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\AppInfo;

use OCA\PresentationConverter\BackgroundJob\ConvertFoldersJob;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\BackgroundJob\IJobList;

class Application extends App implements IBootstrap {
    public const APP_ID = 'presentationconverter';

    public function __construct(array $urlParams = []) {
        parent::__construct(self::APP_ID, $urlParams);
    }

    public function register(IRegistrationContext $context): void {
    }

    public function boot(IBootContext $context): void {
        // IRegistrationContext::registerBackgroundJob() isn't available across
        // every supported Nextcloud version (27-31), so register directly via
        // IJobList - adding an already-registered job is a no-op.
        $context->getAppContainer()->get(IJobList::class)->add(ConvertFoldersJob::class);
    }
}
