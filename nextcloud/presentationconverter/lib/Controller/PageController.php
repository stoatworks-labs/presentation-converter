<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Controller;

use OCA\PresentationConverter\AppInfo\Application;
use OCA\PresentationConverter\Service\ConverterService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private ConverterService $converter,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function index(): TemplateResponse {
        Util::addScript(Application::APP_ID, 'presentationconverter-main');
        Util::addStyle(Application::APP_ID, 'style');

        return new TemplateResponse(Application::APP_ID, 'main', [
            'ready' => $this->converter->isLocalAvailable() || $this->converter->isWorkerAvailable(),
            'formats' => $this->converter->supportedExtensions(),
            'keynoteSupported' => $this->converter->isWorkerAvailable(),
        ]);
    }
}
