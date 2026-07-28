<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Controller;

use OCA\PresentationConverter\Db\WatchedFolder;
use OCA\PresentationConverter\Db\WatchedFolderMapper;
use OCA\PresentationConverter\Service\ConverterService;
use OCA\PresentationConverter\Service\ScanService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\IRequest;

class FolderController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private WatchedFolderMapper $mapper,
        private ScanService $scanService,
        private ConverterService $converter,
        private ITimeFactory $time,
        private ?string $userId,
    ) {
        parent::__construct($appName, $request);
    }

    #[NoAdminRequired]
    public function index(): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'Not signed in'], Http::STATUS_UNAUTHORIZED);
        }

        return new JSONResponse([
            'folders' => $this->mapper->findForUser($this->userId),
            'formats' => $this->converter->supportedExtensions(),
            'ready' => $this->converter->isLocalAvailable() || $this->converter->isWorkerAvailable(),
            'keynoteSupported' => $this->converter->isWorkerAvailable(),
        ]);
    }

    #[NoAdminRequired]
    public function create(string $path): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'Not signed in'], Http::STATUS_UNAUTHORIZED);
        }

        $path = '/' . trim($path, '/');
        if ($this->mapper->exists($this->userId, $path)) {
            return new JSONResponse(['error' => 'That folder is already being converted'], Http::STATUS_CONFLICT);
        }

        $folder = new WatchedFolder();
        $folder->setUserId($this->userId);
        $folder->setPath($path);
        $folder->setLastScan(0);
        $folder->setLastResult('');

        return new JSONResponse($this->mapper->insert($folder));
    }

    #[NoAdminRequired]
    public function destroy(int $id): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'Not signed in'], Http::STATUS_UNAUTHORIZED);
        }
        try {
            $this->mapper->delete($this->mapper->find($id, $this->userId));
        } catch (DoesNotExistException) {
            return new JSONResponse(['error' => 'No such folder'], Http::STATUS_NOT_FOUND);
        }
        return new JSONResponse(['deleted' => true]);
    }

    /**
     * Converts a registered folder immediately.
     *
     * Runs inline rather than queueing, because the user is watching and a
     * folder small enough to add by hand is usually quick; large trees are
     * better left to the scheduled job.
     */
    #[NoAdminRequired]
    public function scanNow(int $id): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'Not signed in'], Http::STATUS_UNAUTHORIZED);
        }
        try {
            $folder = $this->mapper->find($id, $this->userId);
        } catch (DoesNotExistException) {
            return new JSONResponse(['error' => 'No such folder'], Http::STATUS_NOT_FOUND);
        }

        $summary = $this->scanService->scanPath($this->userId, $folder->getPath());

        $folder->setLastScan($this->time->getTime());
        $folder->setLastResult((string)json_encode([
            'converted' => $summary['converted'],
            'skipped' => $summary['skipped'],
            'failed' => $summary['failed'],
        ]));
        $this->mapper->update($folder);

        return new JSONResponse(['folder' => $folder, 'summary' => $summary]);
    }

    /** One-off conversion of a path without registering it. */
    #[NoAdminRequired]
    public function convertPath(string $path): JSONResponse {
        if ($this->userId === null) {
            return new JSONResponse(['error' => 'Not signed in'], Http::STATUS_UNAUTHORIZED);
        }
        return new JSONResponse($this->scanService->scanPath($this->userId, '/' . trim($path, '/')));
    }
}
