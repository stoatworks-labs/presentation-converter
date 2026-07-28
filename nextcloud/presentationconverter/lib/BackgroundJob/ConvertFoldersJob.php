<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\BackgroundJob;

use OCA\PresentationConverter\AppInfo\Application;
use OCA\PresentationConverter\Db\WatchedFolderMapper;
use OCA\PresentationConverter\Service\ConverterService;
use OCA\PresentationConverter\Service\ScanService;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * Rescans every registered folder and converts anything new or changed.
 *
 * Marked TIME_INSENSITIVE: a conversion run can occupy LibreOffice for minutes
 * and there is no user waiting on it, so it should yield to jobs that are
 * actually time-critical.
 */
class ConvertFoldersJob extends TimedJob {
    public function __construct(
        ITimeFactory $time,
        private WatchedFolderMapper $mapper,
        private ScanService $scanService,
        private ConverterService $converter,
        private IConfig $config,
        private LoggerInterface $logger,
    ) {
        parent::__construct($time);
        $this->setInterval(15 * 60);
        $this->setTimeSensitivity(self::TIME_INSENSITIVE);
    }

    protected function run($argument): void {
        if ($this->config->getAppValue(Application::APP_ID, 'enabled', 'yes') !== 'yes') {
            return;
        }
        if (!$this->converter->isLocalAvailable() && !$this->converter->isWorkerAvailable()) {
            // Nothing configured to convert with; stay quiet rather than
            // logging an error every quarter of an hour.
            return;
        }

        foreach ($this->mapper->findAll() as $folder) {
            try {
                $summary = $this->scanService->scanPath($folder->getUserId(), $folder->getPath());

                $folder->setLastScan($this->time->getTime());
                $folder->setLastResult((string)json_encode([
                    'converted' => $summary['converted'],
                    'skipped' => $summary['skipped'],
                    'failed' => $summary['failed'],
                ]));
                $this->mapper->update($folder);

                if ($summary['converted'] > 0 || $summary['failed'] > 0) {
                    $this->logger->info('Presentation Converter: scanned folder', [
                        'app' => Application::APP_ID,
                        'path' => $folder->getPath(),
                        'converted' => $summary['converted'],
                        'failed' => $summary['failed'],
                    ]);
                }
            } catch (\Throwable $e) {
                // One bad folder must not stop the rest of the run.
                $this->logger->error('Presentation Converter: scan failed', [
                    'app' => Application::APP_ID,
                    'path' => $folder->getPath(),
                    'exception' => $e,
                ]);
            }
        }
    }
}
