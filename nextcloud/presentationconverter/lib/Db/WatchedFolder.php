<?php

declare(strict_types=1);

namespace OCA\PresentationConverter\Db;

use OCP\AppFramework\Db\Entity;

/**
 * A folder a user wants kept converted.
 *
 * @method string getUserId()
 * @method void setUserId(string $userId)
 * @method string getPath()
 * @method void setPath(string $path)
 * @method int getLastScan()
 * @method void setLastScan(int $lastScan)
 * @method string getLastResult()
 * @method void setLastResult(string $lastResult)
 */
class WatchedFolder extends Entity implements \JsonSerializable {
    protected $userId = '';
    protected $path = '';
    protected $lastScan = 0;
    protected $lastResult = null;

    public function __construct() {
        $this->addType('userId', 'string');
        $this->addType('path', 'string');
        $this->addType('lastScan', 'integer');
        $this->addType('lastResult', 'string');
    }

    public function jsonSerialize(): array {
        // last_result has no column default and may be NULL for a folder that
        // has never been scanned.
        $lastResult = $this->getLastResult();

        return [
            'id' => $this->getId(),
            'path' => $this->getPath(),
            'lastScan' => $this->getLastScan(),
            'lastResult' => ($lastResult !== null && $lastResult !== '')
                ? json_decode($lastResult, true)
                : null,
        ];
    }
}
