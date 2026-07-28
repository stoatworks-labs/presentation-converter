<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Service;

use OCA\PresentationConverter\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\IConfig;
use Psr\Log\LoggerInterface;

/**
 * Walks a folder tree and keeps a PDF (plus notes sidecar) beside every
 * presentation in it.
 *
 * Conversion is skipped whenever the existing PDF is at least as new as its
 * source, so repeat scans over an unchanged folder cost only a directory walk.
 */
class ScanService {
    /** Guards against a pathological tree costing an entire cron run. */
    private const MAX_DEPTH = 24;

    public function __construct(
        private IRootFolder $rootFolder,
        private ConverterService $converter,
        private IConfig $config,
        private LoggerInterface $logger,
    ) {
    }

    /**
     * Converts everything under `$path` for `$userId`.
     *
     * @return array{converted: int, skipped: int, failed: int, files: list<array>}
     */
    public function scanPath(string $userId, string $path): array {
        $userFolder = $this->rootFolder->getUserFolder($userId);

        try {
            $node = $userFolder->get($path);
        } catch (NotFoundException) {
            return [
                'converted' => 0,
                'skipped' => 0,
                'failed' => 1,
                'files' => [['path' => $path, 'status' => 'failed', 'message' => 'Folder not found']],
            ];
        }

        if (!$node instanceof Folder) {
            return [
                'converted' => 0,
                'skipped' => 0,
                'failed' => 1,
                'files' => [['path' => $path, 'status' => 'failed', 'message' => 'Not a folder']],
            ];
        }

        $summary = ['converted' => 0, 'skipped' => 0, 'failed' => 0, 'files' => []];
        $this->claimed = [];
        $this->walk($node, $node, $summary, 0);
        return $summary;
    }

    /**
     * Output paths already claimed during this scan, mapped to the source that
     * claimed them.
     *
     * `talk.key` and `talk.pptx` in one folder both want `talk.pdf`, and
     * whichever converts last would silently win. Tracking claims turns that
     * into a reported failure instead of one deck's PDF quietly becoming
     * another's.
     *
     * @var array<string, string>
     */
    private array $claimed = [];

    private function walk(Folder $folder, Folder $root, array &$summary, int $depth): void {
        if ($depth > self::MAX_DEPTH) {
            $this->logger->warning('Presentation Converter: stopping at maximum folder depth', [
                'app' => Application::APP_ID,
                'path' => $folder->getPath(),
            ]);
            return;
        }

        try {
            $children = $folder->getDirectoryListing();
        } catch (\Throwable $e) {
            $this->logger->warning('Presentation Converter: could not list folder', [
                'app' => Application::APP_ID,
                'path' => $folder->getPath(),
                'exception' => $e,
            ]);
            return;
        }

        foreach ($children as $child) {
            if ($child instanceof Folder) {
                if ($this->isOutputFolder($child)) {
                    continue;
                }
                $this->walk($child, $root, $summary, $depth + 1);
                continue;
            }

            if ($child instanceof File) {
                $this->handleFile($child, $summary);
            }
        }
    }

    /** True for the folder this app writes into, so a scan never re-reads its own output. */
    private function isOutputFolder(Node $node): bool {
        $subfolder = $this->outputSubfolder();
        return $subfolder !== '' && $node->getName() === $subfolder;
    }

    private function outputSubfolder(): string {
        return trim($this->config->getAppValue(Application::APP_ID, 'output_subfolder', ''));
    }

    private function handleFile(File $file, array &$summary): void {
        $name = $file->getName();

        // Office lock files and macOS resource forks look convertible but are not.
        if (str_starts_with($name, '~$') || str_starts_with($name, '._') || str_starts_with($name, '.')) {
            return;
        }
        if (!$this->converter->canConvert($name)) {
            return;
        }

        $parent = $file->getParent();
        $target = $this->targetFolderFor($parent);
        $stem = pathinfo($name, PATHINFO_FILENAME);

        $claim = $target->getPath() . '/' . $stem . '.pdf';
        if (isset($this->claimed[$claim])) {
            $summary['failed']++;
            $summary['files'][] = [
                'path' => $file->getPath(),
                'name' => $name,
                'status' => 'failed',
                'message' => sprintf(
                    'Would overwrite the PDF already produced from %s. Rename one of them.',
                    $this->claimed[$claim]
                ),
            ];
            return;
        }
        $this->claimed[$claim] = $name;

        if ($this->isUpToDate($target, $stem, $file)) {
            $summary['skipped']++;
            return;
        }

        $outcome = $this->converter->convert($file, $target);

        if (($outcome['status'] ?? '') === 'ok') {
            $summary['converted']++;
        } else {
            $summary['failed']++;
        }

        $summary['files'][] = [
            'path' => $file->getPath(),
            'name' => $name,
        ] + $outcome;
    }

    /** Where a source file's outputs belong: beside it, or in a named subfolder. */
    private function targetFolderFor(Folder $parent): Folder {
        $subfolder = $this->outputSubfolder();
        if ($subfolder === '') {
            return $parent;
        }
        try {
            $existing = $parent->get($subfolder);
            if ($existing instanceof Folder) {
                return $existing;
            }
            // Something non-folder occupies the name; fall back to writing beside.
            return $parent;
        } catch (NotFoundException) {
            return $parent->newFolder($subfolder);
        }
    }

    /**
     * True when a PDF already exists and is no older than its source.
     *
     * The sidecar is checked too, so enabling sidecars later reconverts decks
     * whose PDF is already current rather than leaving them without notes.
     */
    private function isUpToDate(Folder $target, string $stem, File $source): bool {
        try {
            $pdf = $target->get($stem . '.pdf');
        } catch (NotFoundException) {
            return false;
        }
        if ($pdf->getMTime() < $source->getMTime()) {
            return false;
        }

        try {
            $sidecar = $target->get($stem . '.notes.json');
        } catch (NotFoundException) {
            return false;
        }

        return $sidecar->getMTime() >= $source->getMTime();
    }
}
