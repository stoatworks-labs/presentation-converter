<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Settings;

use OCA\PresentationConverter\AppInfo\Application;
use OCA\PresentationConverter\Service\ConverterService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IConfig;
use OCP\Settings\ISettings;
use OCP\Util;

class AdminSettings implements ISettings {
    public function __construct(
        private IConfig $config,
        private ConverterService $converter,
    ) {
    }

    public function getForm(): TemplateResponse {
        Util::addScript(Application::APP_ID, 'presentationconverter-admin');
        Util::addStyle(Application::APP_ID, 'style');

        return new TemplateResponse(Application::APP_ID, 'admin', [
            'cliPath' => $this->config->getAppValue(Application::APP_ID, 'cli_path', ''),
            'workerUrl' => $this->config->getAppValue(Application::APP_ID, 'worker_url', ''),
            // The token itself is never sent to the browser; only whether one is set.
            'workerTokenSet' => $this->config->getAppValue(Application::APP_ID, 'worker_token', '') !== '',
            'outputSubfolder' => $this->config->getAppValue(Application::APP_ID, 'output_subfolder', ''),
            'enabled' => $this->config->getAppValue(Application::APP_ID, 'enabled', 'yes'),
            'timeout' => (int)$this->config->getAppValue(Application::APP_ID, 'timeout', '300'),
            'status' => $this->converter->selfTest(),
        ]);
    }

    public function getSection(): string {
        return Application::APP_ID;
    }

    public function getPriority(): int {
        return 50;
    }
}
