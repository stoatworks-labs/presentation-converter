<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Controller;

use OCA\PresentationConverter\AppInfo\Application;
use OCA\PresentationConverter\Service\ConverterService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IConfig;
use OCP\IRequest;

/**
 * Admin-only: these routes carry no NoAdminRequired attribute, so Nextcloud
 * restricts them to administrators by default.
 */
class AdminSettingsController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IConfig $config,
        private ConverterService $converter,
    ) {
        parent::__construct($appName, $request);
    }

    public function save(
        string $cliPath = '',
        string $workerUrl = '',
        string $workerToken = '',
        string $outputSubfolder = '',
        string $enabled = 'yes',
        int $timeout = 300,
    ): JSONResponse {
        $this->config->setAppValue(Application::APP_ID, 'cli_path', trim($cliPath));
        $this->config->setAppValue(Application::APP_ID, 'worker_url', trim($workerUrl));
        $this->config->setAppValue(Application::APP_ID, 'output_subfolder', trim($outputSubfolder));
        $this->config->setAppValue(Application::APP_ID, 'enabled', $enabled === 'yes' ? 'yes' : 'no');
        $this->config->setAppValue(Application::APP_ID, 'timeout', (string)max(30, $timeout));

        // An empty token field means "leave it alone", so a saved token is not
        // wiped simply because the form never echoes it back.
        if (trim($workerToken) !== '') {
            $this->config->setAppValue(Application::APP_ID, 'worker_token', trim($workerToken));
        }

        return new JSONResponse(['saved' => true, 'test' => $this->converter->selfTest()]);
    }

    public function test(): JSONResponse {
        return new JSONResponse($this->converter->selfTest());
    }
}
