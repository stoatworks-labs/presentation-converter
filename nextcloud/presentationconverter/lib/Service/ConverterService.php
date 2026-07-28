<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Service;

use OCA\PresentationConverter\AppInfo\Application;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\NotFoundException;
use OCP\Http\Client\IClientService;
use OCP\IConfig;
use OCP\ITempManager;
use Psr\Log\LoggerInterface;
use RuntimeException;

/**
 * Converts a single presentation into a PDF plus a `.notes.json` sidecar.
 *
 * Two routes are supported:
 *
 *  - locally, by running the `presentation-converter` CLI on this server, which
 *    uses headless LibreOffice; and
 *  - remotely, by POSTing the file to a paired macOS machine running
 *    `presentation-converter serve`.
 *
 * The remote route exists because Keynote cannot run on Linux at all, so a
 * `.key` file is simply not convertible on the Nextcloud host - there is no
 * LibreOffice filter for it.
 *
 * Files are streamed through a temporary directory rather than passed by path:
 * Nextcloud storage may be object storage or an encrypted mount, so a node has
 * no dependable local path.
 */
class ConverterService {
    /** Formats headless LibreOffice can render on the server. */
    private const LOCAL_FORMATS = ['pptx', 'pptm', 'ppsx', 'ppt', 'pps', 'odp', 'otp'];

    /** Formats that require a macOS worker. */
    private const WORKER_ONLY_FORMATS = ['key'];

    public const ALL_FORMATS = [...self::LOCAL_FORMATS, ...self::WORKER_ONLY_FORMATS];

    public function __construct(
        private IConfig $config,
        private ITempManager $tempManager,
        private IClientService $clientService,
        private LoggerInterface $logger,
    ) {
    }

    // -- configuration ------------------------------------------------------

    public function getCliPath(): string {
        return trim($this->config->getAppValue(Application::APP_ID, 'cli_path', ''));
    }

    public function getWorkerUrl(): string {
        return rtrim(trim($this->config->getAppValue(Application::APP_ID, 'worker_url', '')), '/');
    }

    public function getWorkerToken(): string {
        return trim($this->config->getAppValue(Application::APP_ID, 'worker_token', ''));
    }

    public function getTimeout(): int {
        return max(30, (int)$this->config->getAppValue(Application::APP_ID, 'timeout', '300'));
    }

    public function isLocalAvailable(): bool {
        $path = $this->getCliPath();
        return $path !== '' && is_file($path);
    }

    public function isWorkerAvailable(): bool {
        return $this->getWorkerUrl() !== '';
    }

    /** Extensions this installation can actually convert right now. */
    public function supportedExtensions(): array {
        $supported = [];
        if ($this->isLocalAvailable()) {
            $supported = self::LOCAL_FORMATS;
        }
        if ($this->isWorkerAvailable()) {
            // A worker can handle everything, Keynote included.
            $supported = array_unique([...$supported, ...self::ALL_FORMATS]);
        }
        return array_values($supported);
    }

    public function canConvert(string $filename): bool {
        return in_array($this->extensionOf($filename), $this->supportedExtensions(), true);
    }

    private function extensionOf(string $filename): string {
        return strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    }

    // -- conversion ---------------------------------------------------------

    /**
     * Converts `$source` and writes the PDF and sidecar into `$target`.
     *
     * @return array{status: string, pdf?: string, sidecar?: string, message?: string,
     *               pages?: int, slides?: int, notes?: int, alignment?: string}
     */
    public function convert(File $source, Folder $target): array {
        $extension = $this->extensionOf($source->getName());
        $stem = pathinfo($source->getName(), PATHINFO_FILENAME);

        $useWorker = in_array($extension, self::WORKER_ONLY_FORMATS, true) || !$this->isLocalAvailable();

        if ($useWorker && !$this->isWorkerAvailable()) {
            return [
                'status' => 'failed',
                'message' => $extension === 'key'
                    ? 'Keynote files need a paired macOS worker; none is configured.'
                    : 'No local converter is configured, and no macOS worker is available.',
            ];
        }

        try {
            $produced = $useWorker
                ? $this->convertViaWorker($source)
                : $this->convertLocally($source);
        } catch (\Throwable $e) {
            $this->logger->error('Presentation Converter: conversion failed', [
                'app' => Application::APP_ID,
                'file' => $source->getPath(),
                'exception' => $e,
            ]);
            return ['status' => 'failed', 'message' => $e->getMessage()];
        }

        $pdfName = $stem . '.pdf';
        $sidecarName = $stem . '.notes.json';

        $this->writeInto($target, $pdfName, $produced['pdf']);
        if (($produced['sidecar'] ?? null) !== null) {
            $this->writeInto($target, $sidecarName, $produced['sidecar']);
        }

        $result = $produced['result'] ?? [];

        return [
            'status' => 'ok',
            'pdf' => $pdfName,
            'sidecar' => ($produced['sidecar'] ?? null) !== null ? $sidecarName : null,
            'pages' => $result['pageCount'] ?? null,
            'slides' => $result['slideCount'] ?? null,
            'notes' => $result['notedSlides'] ?? null,
            'alignment' => $result['alignment'] ?? null,
        ];
    }

    /** Creates or overwrites `$name` in `$folder` with `$contents`. */
    private function writeInto(Folder $folder, string $name, string $contents): void {
        try {
            $existing = $folder->get($name);
            if ($existing instanceof File) {
                $existing->putContent($contents);
                return;
            }
            throw new RuntimeException(sprintf('%s already exists and is not a file', $name));
        } catch (NotFoundException) {
            $folder->newFile($name, $contents);
        }
    }

    /**
     * Runs the CLI against a temporary copy of the file.
     *
     * @return array{pdf: string, sidecar: ?string, result: array}
     */
    private function convertLocally(File $source): array {
        $workDir = $this->tempManager->getTemporaryFolder();
        if ($workDir === false) {
            throw new RuntimeException('Could not create a temporary working directory');
        }
        $workDir = rtrim($workDir, '/');
        $outDir = $workDir . '/out';
        if (!@mkdir($outDir) && !is_dir($outDir)) {
            throw new RuntimeException('Could not create a temporary output directory');
        }

        // Keep the original name: the CLI picks its engine from the extension.
        $sourcePath = $workDir . '/' . $this->safeName($source->getName());
        $handle = $source->fopen('r');
        if ($handle === false) {
            throw new RuntimeException('Could not read ' . $source->getName());
        }
        $written = file_put_contents($sourcePath, $handle);
        if (is_resource($handle)) {
            fclose($handle);
        }
        if ($written === false) {
            throw new RuntimeException('Could not stage ' . $source->getName() . ' for conversion');
        }

        $command = [
            $this->getCliPath(),
            'convert',
            $sourcePath,
            '--out-dir',
            $outDir,
            '--force',
            '--json',
        ];

        $output = $this->run($command, $this->getTimeout());
        $decoded = json_decode($output, true);
        $result = $decoded['results'][0] ?? null;

        if (!is_array($result)) {
            throw new RuntimeException('Converter returned unreadable output: ' . substr($output, 0, 500));
        }
        if (($result['status'] ?? '') !== 'ok') {
            throw new RuntimeException($result['message'] ?? 'Conversion failed');
        }

        $pdfPath = $result['pdfPath'] ?? '';
        if ($pdfPath === '' || !is_file($pdfPath)) {
            throw new RuntimeException('Converter reported success but produced no PDF');
        }

        $sidecarPath = $result['sidecarPath'] ?? '';
        $sidecar = ($sidecarPath !== '' && is_file($sidecarPath))
            ? (string)file_get_contents($sidecarPath)
            : null;

        return [
            'pdf' => (string)file_get_contents($pdfPath),
            'sidecar' => $sidecar,
            'result' => $result,
        ];
    }

    /**
     * Uploads the file to a paired macOS worker and takes back the results.
     *
     * @return array{pdf: string, sidecar: ?string, result: array}
     */
    private function convertViaWorker(File $source): array {
        $client = $this->clientService->newClient();

        $headers = [
            'x-filename' => $this->safeName($source->getName()),
            'content-type' => 'application/octet-stream',
        ];
        $token = $this->getWorkerToken();
        if ($token !== '') {
            $headers['authorization'] = 'Bearer ' . $token;
        }

        $body = $source->fopen('r');
        if ($body === false) {
            throw new RuntimeException('Could not read ' . $source->getName());
        }

        try {
            $response = $client->post($this->getWorkerUrl() . '/api/worker/convert', [
                'headers' => $headers,
                'body' => $body,
                'timeout' => $this->getTimeout(),
            ]);
        } finally {
            if (is_resource($body)) {
                fclose($body);
            }
        }

        $decoded = json_decode((string)$response->getBody(), true);
        if (!is_array($decoded) || !isset($decoded['pdfBase64'])) {
            $message = $decoded['result']['message'] ?? $decoded['error'] ?? 'Worker returned no PDF';
            throw new RuntimeException((string)$message);
        }

        $pdf = base64_decode((string)$decoded['pdfBase64'], true);
        if ($pdf === false) {
            throw new RuntimeException('Worker returned a corrupt PDF');
        }

        $sidecar = isset($decoded['sidecar']) && $decoded['sidecar'] !== null
            ? (string)json_encode($decoded['sidecar'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
            : null;

        return [
            'pdf' => $pdf,
            'sidecar' => $sidecar,
            'result' => $decoded['result'] ?? [],
        ];
    }

    /** Strips any directory component a filename might carry. */
    private function safeName(string $name): string {
        return str_replace(['/', '\\', "\0"], '_', $name);
    }

    /**
     * Executes a command without a shell.
     *
     * proc_open with an argument array means filenames containing spaces,
     * quotes or `$` need no escaping and cannot be interpreted as shell syntax.
     */
    private function run(array $command, int $timeout): string {
        $descriptors = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = proc_open($command, $descriptors, $pipes);

        if (!is_resource($process)) {
            throw new RuntimeException('Could not start ' . ($command[0] ?? 'converter'));
        }

        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $deadline = time() + $timeout;

        while (true) {
            $stdout .= (string)stream_get_contents($pipes[1]);
            $stderr .= (string)stream_get_contents($pipes[2]);

            $status = proc_get_status($process);
            if (!$status['running']) {
                break;
            }
            if (time() > $deadline) {
                proc_terminate($process, 9);
                throw new RuntimeException('Conversion timed out after ' . $timeout . 's');
            }
            usleep(100_000);
        }

        // Drain whatever was buffered between the last read and exit.
        $stdout .= (string)stream_get_contents($pipes[1]);
        $stderr .= (string)stream_get_contents($pipes[2]);

        fclose($pipes[1]);
        fclose($pipes[2]);
        $exitCode = proc_close($process);

        if ($exitCode !== 0 && trim($stdout) === '') {
            throw new RuntimeException(trim($stderr) !== '' ? trim($stderr) : 'Converter exited with code ' . $exitCode);
        }

        return $stdout;
    }

    /** Checks that whichever backend is configured actually answers. */
    public function selfTest(): array {
        $report = [
            'local' => ['configured' => $this->isLocalAvailable(), 'ok' => false, 'detail' => ''],
            'worker' => ['configured' => $this->isWorkerAvailable(), 'ok' => false, 'detail' => ''],
        ];

        if ($report['local']['configured']) {
            try {
                $output = $this->run([$this->getCliPath(), 'doctor', '--json'], 60);
                $decoded = json_decode($output, true);
                $engines = $decoded['engines'] ?? [];
                $usable = array_filter(
                    $engines,
                    static fn ($engine) => ($engine['kind'] ?? '') === 'pdf' && ($engine['availability']['available'] ?? false)
                );
                $report['local']['ok'] = $usable !== [];
                $report['local']['detail'] = $usable !== []
                    ? 'Converter ' . ($decoded['version'] ?? '?') . ' with ' . count($usable) . ' PDF engine(s)'
                    : 'Converter runs, but no PDF engine is available - install LibreOffice on this server.';
            } catch (\Throwable $e) {
                $report['local']['detail'] = $e->getMessage();
            }
        }

        if ($report['worker']['configured']) {
            try {
                $headers = [];
                $token = $this->getWorkerToken();
                if ($token !== '') {
                    $headers['authorization'] = 'Bearer ' . $token;
                }
                $response = $this->clientService->newClient()->get(
                    $this->getWorkerUrl() . '/api/worker/health',
                    ['headers' => $headers, 'timeout' => 15]
                );
                $decoded = json_decode((string)$response->getBody(), true);
                $report['worker']['ok'] = is_array($decoded) && isset($decoded['version']);
                $report['worker']['detail'] = $report['worker']['ok']
                    ? 'Worker running presentation-converter ' . $decoded['version']
                    : 'Worker responded, but not as a presentation-converter server.';
            } catch (\Throwable $e) {
                $report['worker']['detail'] = $e->getMessage();
            }
        }

        return $report;
    }
}
